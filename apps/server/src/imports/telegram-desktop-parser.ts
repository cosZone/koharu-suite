import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { Tokenizer, TokenParser } from '@streamparser/json';

const TELEGRAM_CHANNEL_PREFIX = 1_000_000_000_000n;
const MAX_TELEGRAM_ID = 9_223_372_036_854_775_807n;
const MAX_TELEGRAM_BARE_CHANNEL_ID = MAX_TELEGRAM_ID - TELEGRAM_CHANNEL_PREFIX;
const INTEGER_LEXEME = /^-?(?:0|[1-9][0-9]*)$/u;

type DesktopChatSource = 'chats' | 'left_chats' | 'root';

export interface DesktopChatDescriptor {
  id: bigint;
  index: number | null;
  name: string;
  source: DesktopChatSource;
  type: string;
}

export interface DesktopMatchedChat extends DesktopChatDescriptor {
  telegramChatId: bigint;
}

export type DesktopMessageRecord = Record<string, unknown>;

export type DesktopMessageStreamItem =
  | {
      descriptor: DesktopChatDescriptor;
      kind: 'item_error';
      code: 'invalid_message_record';
      sanitizedReason: string;
    }
  | {
      descriptor: DesktopChatDescriptor;
      kind: 'record';
      record: DesktopMessageRecord;
    };

export class TelegramDesktopInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TelegramDesktopInputError';
    this.code = code;
  }
}

interface ParsedValue {
  path: Array<number | string>;
  value: unknown;
}

interface ParsedElementPath {
  key?: number | string | undefined;
  stack: Array<{ key: number | string | undefined }>;
}

interface PendingDescriptor {
  id?: unknown;
  index: number | null;
  name?: unknown;
  source: DesktopChatSource;
  type?: unknown;
}

/**
 * Telegram Desktop writes IDs as bare JSON integer tokens. Keeping every integer
 * token as its original decimal string prevents precision loss before a field-aware
 * normalizer can decide whether it is an ID, timestamp, size, or small integer.
 */
class ExactIntegerTokenizer extends Tokenizer {
  protected override parseNumber(numberString: string): number {
    return INTEGER_LEXEME.test(numberString)
      ? (numberString as unknown as number)
      : super.parseNumber(numberString);
  }
}

function parsedPath(parsed: ParsedElementPath): Array<number | string> {
  return [
    ...parsed.stack
      .slice(1)
      .flatMap((entry) =>
        typeof entry.key === 'number' || typeof entry.key === 'string' ? [entry.key] : [],
      ),
    ...(typeof parsed.key === 'number' || typeof parsed.key === 'string' ? [parsed.key] : []),
  ];
}

async function* parsePaths(inputPath: string, paths: string[]): AsyncGenerator<ParsedValue> {
  const tokenizer = new ExactIntegerTokenizer({
    numberBufferSize: 64,
    stringBufferSize: 64 * 1_024,
  });
  const parser = new TokenParser({ keepStack: false, paths });
  const pending: ParsedValue[] = [];
  const input = createReadStream(inputPath);

  tokenizer.onToken = parser.write.bind(parser);
  tokenizer.onEnd = () => {
    if (!parser.isEnded) {
      parser.end();
    }
  };
  tokenizer.onError = (error) => {
    throw error;
  };
  parser.onValue = (parsed) => {
    pending.push({
      path: parsedPath(parsed),
      value: parsed.value,
    });
  };
  parser.onError = tokenizer.error.bind(tokenizer);
  parser.onEnd = () => {
    if (!tokenizer.isEnded) {
      tokenizer.end();
    }
  };

  try {
    for await (const chunk of input) {
      tokenizer.write(chunk);
      while (pending.length > 0) {
        const parsed = pending.shift();
        if (parsed) {
          yield parsed;
        }
      }
    }
    if (!tokenizer.isEnded) {
      tokenizer.end();
    }
    while (pending.length > 0) {
      const parsed = pending.shift();
      if (parsed) {
        yield parsed;
      }
    }
  } catch {
    throw new TelegramDesktopInputError('invalid_json', 'Input is not valid Telegram JSON');
  } finally {
    input.destroy();
  }
}

async function assertRegularInputFile(inputPath: string): Promise<void> {
  let inputStat: Awaited<ReturnType<typeof lstat>>;
  try {
    inputStat = await lstat(inputPath);
  } catch {
    throw new TelegramDesktopInputError('input_unreadable', 'Input JSON file is not readable');
  }

  if (!inputStat.isFile()) {
    throw new TelegramDesktopInputError('input_not_file', 'Input must be a regular JSON file');
  }
}

function decimalBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TelegramDesktopInputError(
        'invalid_chat_descriptor',
        `${field} must be an exact decimal integer`,
      );
    }
    value = value.toString();
  }

  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) {
    throw new TelegramDesktopInputError(
      'invalid_chat_descriptor',
      `${field} must be a decimal integer`,
    );
  }

  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > MAX_TELEGRAM_ID) {
    throw new TelegramDesktopInputError(
      'invalid_chat_descriptor',
      `${field} is outside the supported range`,
    );
  }
  return parsed;
}

function stringDescriptorField(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TelegramDesktopInputError('invalid_chat_descriptor', `${field} must be a string`);
  }
  return value;
}

function descriptorKey(source: DesktopChatSource, index: number | null): string {
  return `${source}:${index ?? 'root'}`;
}

function descriptorField(parsed: ParsedValue): {
  field: 'id' | 'name' | 'type';
  index: number | null;
  source: DesktopChatSource;
} | null {
  if (
    parsed.path.length === 1 &&
    (parsed.path[0] === 'id' || parsed.path[0] === 'name' || parsed.path[0] === 'type')
  ) {
    return { field: parsed.path[0], index: null, source: 'root' };
  }
  const [source, list, index, field] = parsed.path;
  if (
    (source === 'chats' || source === 'left_chats') &&
    list === 'list' &&
    typeof index === 'number' &&
    (field === 'id' || field === 'name' || field === 'type')
  ) {
    return { field, index, source };
  }
  return null;
}

export async function discoverTelegramDesktopChats(
  inputPath: string,
): Promise<DesktopChatDescriptor[]> {
  await assertRegularInputFile(inputPath);
  const pending = new Map<string, PendingDescriptor>();
  const paths = [
    '$.id',
    '$.name',
    '$.type',
    '$.chats.list.*.id',
    '$.chats.list.*.name',
    '$.chats.list.*.type',
    '$.left_chats.list.*.id',
    '$.left_chats.list.*.name',
    '$.left_chats.list.*.type',
  ];

  for await (const parsed of parsePaths(inputPath, paths)) {
    const location = descriptorField(parsed);
    if (!location) {
      continue;
    }
    const key = descriptorKey(location.source, location.index);
    const descriptor = pending.get(key) ?? {
      index: location.index,
      source: location.source,
    };
    descriptor[location.field] = parsed.value;
    pending.set(key, descriptor);
  }

  const sourceOrder: Record<DesktopChatSource, number> = {
    root: 0,
    chats: 1,
    left_chats: 2,
  };
  const descriptors = [...pending.values()]
    .sort(
      (left, right) =>
        sourceOrder[left.source] - sourceOrder[right.source] ||
        (left.index ?? -1) - (right.index ?? -1),
    )
    .map((descriptor) => {
      const location =
        descriptor.source === 'root'
          ? 'root'
          : `${descriptor.source}.list[${descriptor.index ?? 'unknown'}]`;
      if (
        descriptor.id === undefined ||
        descriptor.name === undefined ||
        descriptor.type === undefined
      ) {
        throw new TelegramDesktopInputError(
          'invalid_chat_descriptor',
          `${location} contains an incomplete chat descriptor`,
        );
      }
      return {
        id: decimalBigInt(descriptor.id, `${location}.id`),
        index: descriptor.index,
        name: stringDescriptorField(descriptor.name, `${location}.name`),
        source: descriptor.source,
        type: stringDescriptorField(descriptor.type, `${location}.type`),
      };
    });

  if (descriptors.length === 0) {
    throw new TelegramDesktopInputError(
      'missing_chat_descriptor',
      'Input does not contain a Telegram chat export',
    );
  }
  return descriptors;
}

export function desktopBareChannelIdToCanonical(sourceChatId: bigint): bigint {
  if (sourceChatId <= 0n || sourceChatId > MAX_TELEGRAM_BARE_CHANNEL_ID) {
    throw new TelegramDesktopInputError(
      'invalid_chat_descriptor',
      'Desktop channel ID is outside the supported range',
    );
  }
  return -(TELEGRAM_CHANNEL_PREFIX + sourceChatId);
}

export function matchTelegramDesktopChats(
  descriptors: readonly DesktopChatDescriptor[],
  selectedTelegramChannelIds: readonly bigint[],
): DesktopMatchedChat[] {
  if (selectedTelegramChannelIds.length === 0) {
    throw new TelegramDesktopInputError(
      'missing_channel_selection',
      'At least one explicit channel selection is required',
    );
  }

  const uniqueSelection = new Set(selectedTelegramChannelIds.map(String));
  if (uniqueSelection.size !== selectedTelegramChannelIds.length) {
    throw new TelegramDesktopInputError(
      'duplicate_channel_selection',
      'Channel selections must be unique',
    );
  }

  return selectedTelegramChannelIds.map((telegramChatId) => {
    const matches = descriptors.filter(
      (descriptor) =>
        descriptor.type === 'public_channel' &&
        desktopBareChannelIdToCanonical(descriptor.id) === telegramChatId,
    );
    if (matches.length !== 1) {
      throw new TelegramDesktopInputError(
        matches.length === 0 ? 'channel_not_found' : 'ambiguous_channel',
        matches.length === 0
          ? 'Selected channel is not present as a public channel in the export'
          : 'Selected channel appears more than once in the export',
      );
    }

    const match = matches[0];
    if (!match) {
      throw new TelegramDesktopInputError('channel_not_found', 'Selected channel was not found');
    }
    return { ...match, telegramChatId };
  });
}

function messagePath(descriptor: DesktopChatDescriptor): string {
  if (descriptor.source === 'root') {
    return '$.messages.*';
  }
  if (descriptor.index === null) {
    throw new TelegramDesktopInputError(
      'invalid_chat_descriptor',
      'Nested chat descriptor is missing its index',
    );
  }
  return `$.${descriptor.source}.list.${descriptor.index}.messages.*`;
}

function messageDescriptorKey(path: Array<number | string>): string | null {
  const [first, second, third, fourth] = path;
  if (first === 'messages' && typeof second === 'number') {
    return descriptorKey('root', null);
  }
  if (
    (first === 'chats' || first === 'left_chats') &&
    second === 'list' &&
    typeof third === 'number' &&
    fourth === 'messages'
  ) {
    return descriptorKey(first, third);
  }
  return null;
}

export async function* streamTelegramDesktopSelectedMessages(
  inputPath: string,
  descriptors: readonly DesktopChatDescriptor[],
): AsyncGenerator<DesktopMessageStreamItem> {
  await assertRegularInputFile(inputPath);
  if (descriptors.length === 0) {
    return;
  }
  const descriptorByKey = new Map(
    descriptors.map((descriptor) => [
      descriptorKey(descriptor.source, descriptor.index),
      descriptor,
    ]),
  );

  for await (const parsed of parsePaths(inputPath, descriptors.map(messagePath))) {
    const key = messageDescriptorKey(parsed.path);
    const descriptor = key ? descriptorByKey.get(key) : undefined;
    if (!descriptor) {
      throw new TelegramDesktopInputError(
        'invalid_chat_descriptor',
        'A selected message could not be associated with its chat descriptor',
      );
    }
    if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      yield {
        code: 'invalid_message_record',
        descriptor,
        kind: 'item_error',
        sanitizedReason: 'Telegram message record must be an object',
      };
      continue;
    }
    yield {
      descriptor,
      kind: 'record',
      record: parsed.value as DesktopMessageRecord,
    };
  }
}

export async function* streamTelegramDesktopMessages(
  inputPath: string,
  descriptor: DesktopChatDescriptor,
): AsyncGenerator<DesktopMessageStreamItem> {
  yield* streamTelegramDesktopSelectedMessages(inputPath, [descriptor]);
}
