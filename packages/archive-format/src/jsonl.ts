import { TextDecoder, TextEncoder } from 'node:util';
import { closeIteratorBestEffort, runWithAbort } from './async-control.js';
import { serializeCanonicalJson } from './canonical-json.js';
import {
  type ArchiveRecordFamily,
  archiveRecordFamilySchema,
  DEFAULT_ARCHIVE_SHARD_BYTES,
  DEFAULT_ARCHIVE_SHARD_RECORDS,
} from './schemas.js';

export type JsonlObject = Record<string, unknown>;

export interface JsonlOptions {
  maxLineBytes: number;
  maxRecords: number;
  signal?: AbortSignal;
}

export type JsonlErrorCode =
  | 'blank_line'
  | 'invalid_chunk'
  | 'invalid_json'
  | 'invalid_line_ending'
  | 'invalid_record'
  | 'invalid_utf8'
  | 'line_too_large'
  | 'missing_trailing_lf'
  | 'non_canonical_json'
  | 'record_limit_exceeded'
  | 'shard_limit_exceeded';

const ERROR_MESSAGES: Record<JsonlErrorCode, string> = {
  blank_line: 'JSONL input contains a blank line',
  invalid_chunk: 'JSONL input yielded an invalid byte chunk',
  invalid_json: 'JSONL line is not valid JSON',
  invalid_line_ending: 'JSONL input must use LF line endings',
  invalid_record: 'JSONL line must contain one JSON object',
  invalid_utf8: 'JSONL line is not valid UTF-8',
  line_too_large: 'JSONL line exceeds the configured byte limit',
  missing_trailing_lf: 'Non-empty JSONL input must end with LF',
  non_canonical_json: 'JSONL line is not canonical JSON',
  record_limit_exceeded: 'JSONL input exceeds the configured record limit',
  shard_limit_exceeded: 'JSONL output exceeds the supported shard count',
};

export interface JsonlShardOptions extends JsonlOptions {
  family: ArchiveRecordFamily;
  maxShardBytes?: number;
  maxShardRecords?: number;
}

export interface EncodedJsonlShard {
  byteLength: number;
  bytes: Uint8Array;
  family: ArchiveRecordFamily;
  path: string;
  recordCount: number;
  shardIndex: number;
}

/**
 * A position-aware, content-safe JSONL error.
 *
 * `lineNo` is one-based and `byteOffset` is the zero-based byte offset at
 * which that line starts. Messages intentionally never include line content.
 */
export class JsonlError extends Error {
  constructor(
    readonly code: JsonlErrorCode,
    readonly lineNo: number,
    readonly byteOffset: number,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'JsonlError';
  }
}

type ByteSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
type RecordSource = AsyncIterable<unknown> | Iterable<unknown>;

/** Encode JSON objects as UTF-8 JSONL, yielding exactly one LF-terminated line per record. */
export async function* encodeJsonl(
  records: RecordSource,
  options: JsonlOptions,
): AsyncGenerator<Uint8Array> {
  assertOptions(options);
  const iterator = toAsyncIterator(records);
  const encoder = new TextEncoder();
  let byteOffset = 0;
  let lineNo = 1;
  let recordCount = 0;

  try {
    while (true) {
      const next = await nextWithAbort(iterator, options.signal);
      if (next.done) {
        return;
      }
      options.signal?.throwIfAborted();
      if (recordCount >= options.maxRecords) {
        throw new JsonlError('record_limit_exceeded', lineNo, byteOffset);
      }

      const json = serializeObject(next.value, lineNo, byteOffset);
      const encoded = encoder.encode(json);
      if (encoded.byteLength > options.maxLineBytes) {
        throw new JsonlError('line_too_large', lineNo, byteOffset);
      }

      const line = new Uint8Array(encoded.byteLength + 1);
      line.set(encoded);
      line[line.length - 1] = 0x0a;
      yield line;

      byteOffset += line.byteLength;
      lineNo += 1;
      recordCount += 1;
    }
  } finally {
    await closeIteratorBestEffort(iterator);
  }
}

/** Encode records into deterministic, bounded, non-empty v1 JSONL shards. */
export async function* encodeJsonlShards(
  records: RecordSource,
  options: JsonlShardOptions,
): AsyncGenerator<EncodedJsonlShard> {
  const family = archiveRecordFamilySchema.parse(options.family);
  const maxShardBytes = options.maxShardBytes ?? DEFAULT_ARCHIVE_SHARD_BYTES;
  const maxShardRecords = options.maxShardRecords ?? DEFAULT_ARCHIVE_SHARD_RECORDS;
  if (
    !Number.isSafeInteger(maxShardBytes) ||
    maxShardBytes <= 0 ||
    maxShardBytes < options.maxLineBytes ||
    maxShardBytes > DEFAULT_ARCHIVE_SHARD_BYTES
  ) {
    throw new TypeError(
      'maxShardBytes must be a positive safe integer between maxLineBytes and the v1 shard limit',
    );
  }
  if (
    !Number.isSafeInteger(maxShardRecords) ||
    maxShardRecords <= 0 ||
    maxShardRecords > DEFAULT_ARCHIVE_SHARD_RECORDS
  ) {
    throw new TypeError(
      'maxShardRecords must be a positive safe integer within the v1 shard limit',
    );
  }

  let shardIndex = 0;
  let shardByteLength = 0;
  let shardRecordCount = 0;
  let chunks: Uint8Array[] = [];

  const flush = (): EncodedJsonlShard => {
    if (shardIndex > 999_999) {
      throw new JsonlError('shard_limit_exceeded', 1, 0);
    }
    const bytes = concatParts(chunks, shardByteLength);
    const shard: EncodedJsonlShard = {
      byteLength: shardByteLength,
      bytes,
      family,
      path: archiveDataShardPath(family, shardIndex),
      recordCount: shardRecordCount,
      shardIndex,
    };
    shardIndex += 1;
    shardByteLength = 0;
    shardRecordCount = 0;
    chunks = [];
    return shard;
  };

  for await (const line of encodeJsonl(records, options)) {
    if (
      shardRecordCount > 0 &&
      (shardRecordCount >= maxShardRecords || shardByteLength + line.byteLength > maxShardBytes)
    ) {
      yield flush();
    }
    chunks.push(line);
    shardByteLength += line.byteLength;
    shardRecordCount += 1;
  }

  if (shardRecordCount > 0) {
    yield flush();
  }
}

export function archiveDataShardPath(family: ArchiveRecordFamily, shardIndex: number): string {
  const validatedFamily = archiveRecordFamilySchema.parse(family);
  if (!Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex > 999_999) {
    throw new TypeError('shardIndex must be an integer between 0 and 999999');
  }
  return `data/${validatedFamily}/${shardIndex.toString().padStart(6, '0')}.jsonl`;
}

/** Decode strict UTF-8, LF-terminated, one-object-per-line JSONL without buffering the file. */
export async function* decodeJsonl<T extends JsonlObject = JsonlObject>(
  chunks: ByteSource,
  options: JsonlOptions,
): AsyncGenerator<T> {
  assertOptions(options);
  const iterator = toAsyncIterator(chunks);
  // `ignoreBOM: true` means the BOM is preserved as U+FEFF instead of being
  // silently stripped, so the canonical JSON check rejects it.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let byteOffset = 0;
  let lineNo = 1;
  let lineByteLength = 0;
  let parts: Uint8Array[] = [];
  let recordCount = 0;

  const append = (part: Uint8Array) => {
    if (part.byteLength === 0) {
      return;
    }
    if (lineByteLength + part.byteLength > options.maxLineBytes) {
      throw new JsonlError('line_too_large', lineNo, byteOffset);
    }
    parts.push(part);
    lineByteLength += part.byteLength;
  };

  try {
    while (true) {
      const next = await nextWithAbort(iterator, options.signal);
      if (next.done) {
        break;
      }
      options.signal?.throwIfAborted();
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new JsonlError('invalid_chunk', lineNo, byteOffset);
      }

      let segmentStart = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 0x0a) {
          continue;
        }

        append(chunk.subarray(segmentStart, index));
        if (recordCount >= options.maxRecords) {
          throw new JsonlError('record_limit_exceeded', lineNo, byteOffset);
        }
        const record = parseLine<T>(parts, lineByteLength, decoder, lineNo, byteOffset);
        yield record;

        recordCount += 1;
        byteOffset += lineByteLength + 1;
        lineNo += 1;
        lineByteLength = 0;
        parts = [];
        segmentStart = index + 1;
        options.signal?.throwIfAborted();
      }

      append(chunk.subarray(segmentStart));
    }

    options.signal?.throwIfAborted();
    if (lineByteLength > 0) {
      throw new JsonlError('missing_trailing_lf', lineNo, byteOffset);
    }
  } finally {
    await closeIteratorBestEffort(iterator);
  }
}

function assertOptions(options: JsonlOptions): void {
  if (!Number.isSafeInteger(options.maxLineBytes) || options.maxLineBytes <= 0) {
    throw new TypeError('maxLineBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.maxRecords) || options.maxRecords < 0) {
    throw new TypeError('maxRecords must be a non-negative safe integer');
  }
}

function serializeObject(value: unknown, lineNo: number, byteOffset: number): string {
  if (!isJsonObject(value)) {
    throw new JsonlError('invalid_record', lineNo, byteOffset);
  }

  try {
    return serializeCanonicalJson(value);
  } catch {
    throw new JsonlError('invalid_record', lineNo, byteOffset);
  }
}

function parseLine<T extends JsonlObject>(
  parts: readonly Uint8Array[],
  byteLength: number,
  decoder: TextDecoder,
  lineNo: number,
  byteOffset: number,
): T {
  const bytes = concatParts(parts, byteLength);
  if (bytes.includes(0x0d)) {
    throw new JsonlError('invalid_line_ending', lineNo, byteOffset);
  }

  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new JsonlError('invalid_utf8', lineNo, byteOffset);
  }
  if (text.trim().length === 0) {
    throw new JsonlError('blank_line', lineNo, byteOffset);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new JsonlError('invalid_json', lineNo, byteOffset);
  }
  if (!isJsonObject(value)) {
    throw new JsonlError('invalid_record', lineNo, byteOffset);
  }
  try {
    if (serializeCanonicalJson(value) !== text) {
      throw new JsonlError('non_canonical_json', lineNo, byteOffset);
    }
  } catch (error) {
    if (error instanceof JsonlError) throw error;
    throw new JsonlError('invalid_record', lineNo, byteOffset);
  }
  return value as T;
}

function concatParts(parts: readonly Uint8Array[], byteLength: number): Uint8Array {
  if (parts.length === 1) {
    return parts[0] ?? new Uint8Array();
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function isJsonObject(value: unknown): value is JsonlObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toAsyncIterator<T>(source: AsyncIterable<T> | Iterable<T>): AsyncIterator<T> {
  if (Symbol.asyncIterator in source) {
    return source[Symbol.asyncIterator]();
  }
  const iterator = source[Symbol.iterator]();
  if (iterator.return) {
    return {
      next: async () => iterator.next(),
      return: async () => iterator.return?.() ?? { done: true, value: undefined },
    };
  }
  return { next: async () => iterator.next() };
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> {
  return runWithAbort(() => iterator.next(), signal);
}
