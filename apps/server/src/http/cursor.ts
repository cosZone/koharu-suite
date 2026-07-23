const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MessageCursor {
  channelId: string;
  messageId: string;
  publishedAt: string;
}

export interface DecodeMessageCursorOptions {
  channelId?: string;
}

interface MessageCursorPayload extends MessageCursor {
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

export function encodeMessageCursor(cursor: MessageCursor): string {
  validateCursor(cursor);
  return Buffer.from(JSON.stringify(cursorPayload(cursor)), 'utf8').toString('base64url');
}

export function decodeMessageCursor(
  encoded: string,
  options: DecodeMessageCursorOptions = {},
): MessageCursor {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return invalidCursor();
  }

  let bytes: Buffer;
  let json: string;
  let parsed: unknown;

  try {
    bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) {
      return invalidCursor();
    }
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(json);
  } catch {
    return invalidCursor();
  }

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
