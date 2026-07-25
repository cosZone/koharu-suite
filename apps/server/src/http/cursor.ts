import { createHash } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface MessageCursor {
  channelId: string;
  messageId: string;
  publishedAt: string;
}

export interface LatestMessageCursor extends MessageCursor {
  snapshotAt: string;
}

export interface DecodeMessageCursorOptions {
  channelId?: string;
}

interface MessageCursorPayload extends MessageCursor {
  v: 1;
}

interface LatestMessageCursorPayload extends LatestMessageCursor {
  channelFilterHash: string;
  v: 1;
}

export class InvalidCursorError extends Error {
  readonly code = 'invalid_cursor';

  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

function invalidCursor(): never {
  throw new InvalidCursorError();
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function validateCursor(cursor: MessageCursor): void {
  if (
    !isCanonicalIsoTimestamp(cursor.publishedAt) ||
    !isUuid(cursor.channelId) ||
    !isUuid(cursor.messageId)
  ) {
    invalidCursor();
  }
}

function cursorPayload(cursor: MessageCursor): MessageCursorPayload {
  return {
    v: 1,
    publishedAt: cursor.publishedAt,
    channelId: cursor.channelId,
    messageId: cursor.messageId,
  };
}

function parsePayload(value: unknown): MessageCursorPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidCursor();
  }

  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !keys.includes('v') ||
    !keys.includes('publishedAt') ||
    !keys.includes('channelId') ||
    !keys.includes('messageId')
  ) {
    return invalidCursor();
  }

  const candidate = value as Partial<MessageCursorPayload>;
  if (
    candidate.v !== 1 ||
    !isCanonicalIsoTimestamp(candidate.publishedAt) ||
    !isUuid(candidate.channelId) ||
    !isUuid(candidate.messageId)
  ) {
    return invalidCursor();
  }

  return cursorPayload({
    channelId: candidate.channelId,
    messageId: candidate.messageId,
    publishedAt: candidate.publishedAt,
  });
}

function channelFilterHash(channelIds: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...channelIds].sort()), 'utf8')
    .digest('hex');
}

function latestCursorPayload(
  cursor: LatestMessageCursor,
  channelIds: readonly string[],
): LatestMessageCursorPayload {
  if (!isCanonicalIsoTimestamp(cursor.snapshotAt)) {
    return invalidCursor();
  }
  validateCursor(cursor);
  return {
    v: 1,
    publishedAt: cursor.publishedAt,
    channelId: cursor.channelId,
    messageId: cursor.messageId,
    snapshotAt: cursor.snapshotAt,
    channelFilterHash: channelFilterHash(channelIds),
  };
}

function parseLatestPayload(
  value: unknown,
  channelIds: readonly string[],
): LatestMessageCursorPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidCursor();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 6 ||
    !keys.includes('v') ||
    !keys.includes('publishedAt') ||
    !keys.includes('channelId') ||
    !keys.includes('messageId') ||
    !keys.includes('snapshotAt') ||
    !keys.includes('channelFilterHash')
  ) {
    return invalidCursor();
  }
  const candidate = value as Partial<LatestMessageCursorPayload>;
  if (
    candidate.v !== 1 ||
    !isCanonicalIsoTimestamp(candidate.publishedAt) ||
    !isCanonicalIsoTimestamp(candidate.snapshotAt) ||
    !isUuid(candidate.channelId) ||
    !isUuid(candidate.messageId) ||
    typeof candidate.channelFilterHash !== 'string' ||
    !SHA256_PATTERN.test(candidate.channelFilterHash) ||
    candidate.channelFilterHash !== channelFilterHash(channelIds)
  ) {
    return invalidCursor();
  }
  return latestCursorPayload(
    {
      channelId: candidate.channelId,
      messageId: candidate.messageId,
      publishedAt: candidate.publishedAt,
      snapshotAt: candidate.snapshotAt,
    },
    channelIds,
  );
}

function decodePayload(encoded: string): { json: string; parsed: unknown } {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return invalidCursor();
  }
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) {
      return invalidCursor();
    }
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { json, parsed: JSON.parse(json) };
  } catch {
    return invalidCursor();
  }
}

export function encodeMessageCursor(cursor: MessageCursor): string {
  validateCursor(cursor);
  return Buffer.from(JSON.stringify(cursorPayload(cursor)), 'utf8').toString('base64url');
}

export function decodeMessageCursor(
  encoded: string,
  options: DecodeMessageCursorOptions = {},
): MessageCursor {
  const { json, parsed } = decodePayload(encoded);

  const payload = parsePayload(parsed);
  if (JSON.stringify(payload) !== json) {
    return invalidCursor();
  }
  if (options.channelId !== undefined) {
    const channelId = options.channelId.toLowerCase();
    if (!isUuid(channelId) || payload.channelId !== channelId) {
      return invalidCursor();
    }
  }

  return {
    channelId: payload.channelId,
    messageId: payload.messageId,
    publishedAt: payload.publishedAt,
  };
}

export function encodeLatestMessageCursor(
  cursor: LatestMessageCursor,
  channelIds: readonly string[],
): string {
  return Buffer.from(JSON.stringify(latestCursorPayload(cursor, channelIds)), 'utf8').toString(
    'base64url',
  );
}

export function decodeLatestMessageCursor(
  encoded: string,
  channelIds: readonly string[],
): LatestMessageCursor {
  const { json, parsed } = decodePayload(encoded);
  const payload = parseLatestPayload(parsed, channelIds);
  if (JSON.stringify(payload) !== json) {
    return invalidCursor();
  }
  return {
    channelId: payload.channelId,
    messageId: payload.messageId,
    publishedAt: payload.publishedAt,
    snapshotAt: payload.snapshotAt,
  };
}
