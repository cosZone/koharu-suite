import path from 'node:path';
import { fingerprintMessageSnapshot } from '../messages/fingerprint.js';
import type {
  NormalizedChannelIdentity,
  NormalizedMessageSnapshot,
  SourceNeutralMedia,
  SourceObservation,
} from '../messages/types.js';
import type { NormalizedMediaKind, NormalizedMessageEntity } from '../telegram/types.js';
import type { DesktopMessageRecord } from './telegram-desktop-parser.js';

const MAX_TELEGRAM_ID = 9_223_372_036_854_775_807n;
const PLACEHOLDER_REASONS: ReadonlyArray<[RegExp, string]> = [
  [/exceeds (?:the )?maximum size/iu, 'exceeds_maximum_size'],
  [/(?:file|media) not included/iu, 'not_included'],
  [/(?:file|media) (?:is )?unavailable/iu, 'unavailable'],
];

export const TELEGRAM_DESKTOP_PARSER_VERSION = 1;

export interface TelegramDesktopNormalizeContext {
  channel: NormalizedChannelIdentity;
  importRunId?: string | null;
  sourceChatId: bigint;
}

export interface TelegramDesktopSourceMetadata extends Record<string, unknown> {
  forwardedFrom: string | null;
  replyToMessageId: string | null;
}

export type TelegramDesktopSkipReason = 'rich_message' | 'service' | 'unsupported';

export type TelegramDesktopNormalizationResult =
  | {
      code: string;
      kind: 'item_error';
      sanitizedReason: string;
    }
  | {
      kind: 'eligible';
      observation: Extract<SourceObservation, { kind: 'telegram_desktop_json' }>;
      snapshot: NormalizedMessageSnapshot;
      sourceMetadata: TelegramDesktopSourceMetadata;
      warnings: string[];
    }
  | {
      kind: 'skipped';
      reason: TelegramDesktopSkipReason;
    };

class ItemError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function decimalBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ItemError('invalid_id', `${field} must be an exact decimal integer`);
    }
    value = value.toString();
  }

  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) {
    throw new ItemError('invalid_id', `${field} must be a decimal integer`);
  }

  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > MAX_TELEGRAM_ID) {
    throw new ItemError('invalid_id', `${field} is outside the supported range`);
  }
  return parsed;
}

function finiteInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' && /^[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ItemError('invalid_media_metadata', `${field} must be a non-negative integer`);
  }
  return value;
}

function optionalBigInt(value: unknown, field: string): bigint | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ItemError('invalid_media_metadata', `${field} must be an exact integer`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^[0-9]+$/u.test(value)) {
    return BigInt(value);
  }
  throw new ItemError('invalid_media_metadata', `${field} must be a decimal integer`);
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ItemError('invalid_media_metadata', `${field} must be a string`);
  }
  return value;
}

function parseEpoch(value: unknown, field: string): Date {
  let epoch: bigint;
  try {
    epoch = decimalBigInt(value, field);
  } catch {
    throw new ItemError('invalid_date', `${field} must be a positive epoch second`);
  }
  const milliseconds = Number(epoch * 1_000n);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new ItemError('invalid_date', `${field} is outside the supported date range`);
  }
  const parsed = new Date(milliseconds);
  if (Number.isNaN(parsed.getTime())) {
    throw new ItemError('invalid_date', `${field} is outside the supported date range`);
  }
  return parsed;
}

function parseIsoDate(value: unknown, field: string): Date {
  if (
    typeof value !== 'string' ||
    !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new ItemError('invalid_date', `${field} must include an explicit timezone`);
  }
  return new Date(value);
}

function parseDate(
  record: DesktopMessageRecord,
  epochField: 'date_unixtime' | 'edited_unixtime',
  isoField: 'date' | 'edited',
  required: boolean,
  warnings: string[],
): Date | null {
  const epoch = record[epochField];
  if (epoch !== undefined && epoch !== null && epoch !== '') {
    return parseEpoch(epoch, epochField);
  }
  const iso = record[isoField];
  if (iso !== undefined && iso !== null && iso !== '') {
    warnings.push(`${isoField}_iso_fallback`);
    return parseIsoDate(iso, isoField);
  }
  if (required) {
    throw new ItemError('missing_date', 'Message date is required');
  }
  return null;
}

interface NormalizedText {
  entities: NormalizedMessageEntity[];
  text: string;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeEntityType(
  entity: Record<string, unknown>,
  warnings: string[],
): Omit<NormalizedMessageEntity, 'length' | 'offset'> | null {
  const type = entity.type;
  if (typeof type !== 'string') {
    throw new ItemError('invalid_text', 'Text entity type must be a string');
  }

  switch (type) {
    case 'plain':
      return null;
    case 'link':
      return { type: 'url' };
    case 'text_link': {
      if (typeof entity.href !== 'string') {
        throw new ItemError('invalid_text', 'text_link entity must contain href');
      }
      return { type: 'text_link', url: entity.href };
    }
    case 'phone':
      return { type: 'phone_number' };
    case 'blockquote':
      return { type: entity.collapsed === true ? 'expandable_blockquote' : 'blockquote' };
    case 'custom_emoji': {
      const documentId = entity.document_id;
      if (
        (typeof documentId !== 'string' && typeof documentId !== 'number') ||
        String(documentId).length === 0
      ) {
        throw new ItemError('invalid_text', 'custom_emoji entity must contain document_id');
      }
      return { customEmojiId: String(documentId), type: 'custom_emoji' };
    }
    case 'pre':
      return typeof entity.language === 'string' ? { language: entity.language, type } : { type };
    case 'bold':
    case 'bot_command':
    case 'cashtag':
    case 'code':
    case 'email':
    case 'hashtag':
    case 'italic':
    case 'mention':
    case 'spoiler':
    case 'strikethrough':
    case 'underline':
      return { type };
    default:
      warnings.push('unknown_entity');
      return null;
  }
}

function normalizeSegments(value: unknown, warnings: string[]): NormalizedText {
  if (typeof value === 'string') {
    return { entities: [], text: value };
  }
  if (!Array.isArray(value)) {
    throw new ItemError('invalid_text', 'Message text must be a string or segment array');
  }

  const entities: NormalizedMessageEntity[] = [];
  let text = '';
  for (const segment of value) {
    if (typeof segment === 'string') {
      text += segment;
      continue;
    }

    const entity = recordValue(segment);
    if (entity === null || typeof entity.text !== 'string') {
      throw new ItemError('invalid_text', 'Text segment must contain string text');
    }
    const offset = text.length;
    text += entity.text;
    const normalized = normalizeEntityType(entity, warnings);
    if (normalized !== null && entity.text.length > 0) {
      entities.push({
        ...normalized,
        length: entity.text.length,
        offset,
      });
    }
  }
  return { entities, text };
}

function normalizeText(record: DesktopMessageRecord, warnings: string[]): NormalizedText {
  if (record.text_entities !== undefined) {
    return normalizeSegments(record.text_entities, warnings);
  }
  if (record.text === undefined || record.text === null) {
    return { entities: [], text: '' };
  }
  return normalizeSegments(record.text, warnings);
}

function placeholderReason(value: string): string | null {
  for (const [pattern, reason] of PLACEHOLDER_REASONS) {
    if (pattern.test(value)) {
      return reason;
    }
  }
  return null;
}

export function normalizeTelegramDesktopMediaPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(value)
  ) {
    throw new ItemError('unsafe_media_path', 'Media path must be a relative POSIX path');
  }
  const segments = value.split('/');
  if (segments.includes('..')) {
    throw new ItemError('unsafe_media_path', 'Media path cannot contain a parent segment');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized.startsWith('../')) {
    throw new ItemError('unsafe_media_path', 'Media path must remain inside the export root');
  }
  return normalized.replace(/^\.\//u, '');
}

function sourcePath(
  value: unknown,
  field: string,
): {
  availabilityReason: string | null;
  sourcePath: string | null;
} {
  if (typeof value !== 'string') {
    throw new ItemError('invalid_media_metadata', `${field} must be a string`);
  }
  const reason = placeholderReason(value);
  return reason === null
    ? { availabilityReason: null, sourcePath: normalizeTelegramDesktopMediaPath(value) }
    : { availabilityReason: reason, sourcePath: null };
}

function desktopMediaKind(sourceMediaType: string | null): NormalizedMediaKind {
  switch (sourceMediaType) {
    case 'animation':
      return 'animation';
    case 'audio_file':
      return 'audio';
    case 'video_file':
    case 'video_message':
      return 'video';
    case 'voice_message':
      return 'voice';
    default:
      return 'document';
  }
}

function normalizeMedia(record: DesktopMessageRecord, warnings: string[]): SourceNeutralMedia[] {
  const media: SourceNeutralMedia[] = [];
  if (record.photo !== undefined && record.photo !== null) {
    const photoPath = sourcePath(record.photo, 'photo');
    media.push({
      ...photoPath,
      duration: null,
      fileName: null,
      fileSize: optionalBigInt(record.photo_file_size, 'photo_file_size'),
      height: finiteInteger(record.height, 'height'),
      kind: 'photo',
      mimeType: 'image/jpeg',
      sourceMediaType: 'photo',
      sourceMetadata: {},
      telegramFileId: null,
      telegramFileUniqueId: null,
      width: finiteInteger(record.width, 'width'),
    });
  }

  if (record.file !== undefined && record.file !== null) {
    const filePath = sourcePath(record.file, 'file');
    const sourceMediaType = optionalString(record.media_type, 'media_type');
    const knownMediaTypes = new Set([
      'animation',
      'audio_file',
      'file',
      'sticker',
      'video_file',
      'video_message',
      'voice_message',
    ]);
    const knownSourceMediaType =
      sourceMediaType === null || knownMediaTypes.has(sourceMediaType)
        ? sourceMediaType
        : 'unknown';
    if (knownSourceMediaType === 'unknown') {
      warnings.push('unknown_media');
    }
    media.push({
      ...filePath,
      duration: finiteInteger(record.duration_seconds, 'duration_seconds'),
      fileName: optionalString(record.file_name, 'file_name'),
      fileSize: optionalBigInt(record.file_size, 'file_size'),
      height: finiteInteger(record.height, 'height'),
      kind: desktopMediaKind(knownSourceMediaType),
      mimeType: optionalString(record.mime_type, 'mime_type'),
      sourceMediaType: knownSourceMediaType,
      sourceMetadata: {
        ...(typeof record.performer === 'string' ? { performer: record.performer } : {}),
        ...(typeof record.sticker_emoji === 'string' ? { stickerEmoji: record.sticker_emoji } : {}),
        ...(typeof record.title === 'string' ? { title: record.title } : {}),
      },
      telegramFileId: null,
      telegramFileUniqueId: null,
      width: finiteInteger(record.width, 'width'),
    });
  }

  return media;
}

function sourceMetadata(record: DesktopMessageRecord): TelegramDesktopSourceMetadata {
  const reply =
    record.reply_to_message_id === undefined || record.reply_to_message_id === null
      ? null
      : decimalBigInt(record.reply_to_message_id, 'reply_to_message_id');
  const forwardedFrom =
    typeof record.forwarded_from === 'string'
      ? record.forwarded_from
      : typeof record.forwarded_from_name === 'string'
        ? record.forwarded_from_name
        : null;
  return { forwardedFrom, replyToMessageId: reply?.toString() ?? null };
}

function normalizeEligible(
  record: DesktopMessageRecord,
  context: TelegramDesktopNormalizeContext,
): Extract<TelegramDesktopNormalizationResult, { kind: 'eligible' }> {
  const warnings: string[] = [];
  const telegramMessageId = decimalBigInt(record.id, 'id');
  const publishedAt = parseDate(record, 'date_unixtime', 'date', true, warnings);
  if (publishedAt === null) {
    throw new ItemError('missing_date', 'Message date is required');
  }
  const editedAt = parseDate(record, 'edited_unixtime', 'edited', false, warnings);
  const normalizedText = normalizeText(record, warnings);
  const media = normalizeMedia(record, warnings);
  const text = normalizedText.text.length === 0 ? null : normalizedText.text;
  if (text === null && media.length === 0) {
    throw new ItemError('empty_message', 'Message has no visible text or supported media');
  }

  const snapshot: NormalizedMessageSnapshot = {
    channel: context.channel,
    media,
    message: {
      authorSignature: typeof record.author === 'string' ? record.author : null,
      contentKind: text === null ? 'none' : media.length > 0 ? 'caption' : 'text',
      editedAt,
      entities: normalizedText.entities,
      mediaGroupId: null,
      publishedAt,
      telegramMessageId,
      text,
    },
  };
  const fingerprint = fingerprintMessageSnapshot(snapshot);
  const observedAt = editedAt ?? publishedAt;
  const normalizedSourceMetadata = sourceMetadata(record);
  const observation: Extract<SourceObservation, { kind: 'telegram_desktop_json' }> = {
    importRunId: context.importRunId ?? null,
    kind: 'telegram_desktop_json',
    observedAt,
    raw: record,
    sourceChatId: context.sourceChatId,
    sourceMetadata: normalizedSourceMetadata,
    sourceKey: [
      'telegram-desktop',
      context.channel.telegramChatId.toString(),
      telegramMessageId.toString(),
      observedAt.toISOString(),
      fingerprint,
    ].join(':'),
    sourceMessageId: telegramMessageId,
  };

  return {
    kind: 'eligible',
    observation,
    snapshot,
    sourceMetadata: normalizedSourceMetadata,
    warnings,
  };
}

export function normalizeTelegramDesktopMessage(
  record: DesktopMessageRecord,
  context: TelegramDesktopNormalizeContext,
): TelegramDesktopNormalizationResult {
  const type = record.type;
  if (type === 'message' && record.rich_message !== undefined) {
    return { kind: 'skipped', reason: 'rich_message' };
  }
  if (type === 'service') {
    return { kind: 'skipped', reason: 'service' };
  }
  if (type === 'unsupported') {
    return { kind: 'skipped', reason: 'unsupported' };
  }
  if (type === 'rich_message') {
    return { kind: 'skipped', reason: 'rich_message' };
  }
  if (type !== 'message') {
    return { kind: 'skipped', reason: 'unsupported' };
  }

  try {
    return normalizeEligible(record, context);
  } catch (error) {
    if (error instanceof ItemError) {
      return {
        code: error.code,
        kind: 'item_error',
        sanitizedReason: error.message,
      };
    }
    throw error;
  }
}
