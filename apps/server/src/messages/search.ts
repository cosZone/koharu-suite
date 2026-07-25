import { createHash } from 'node:crypto';
import type { PublicMessage } from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type MessageSearchMode = 'short_substring' | 'trigram';
export type MessageSearchSort = 'newest' | 'relevance';

export interface MessageSearchKey {
  channelId: string | null;
  channelIds?: readonly string[];
  from: string | null;
  query: string;
  sort: MessageSearchSort;
  to: string | null;
}

export interface MessageSearchCursor {
  messageId: string;
  publishedAt: string;
  queryHash: string;
  score: number | null;
  snapshotAt: string;
}

export interface MessageSearchOptions extends MessageSearchKey {
  cursor?: MessageSearchCursor;
  limit: number;
}

export interface MessageSearchMatch {
  score: number | null;
  snippet: string;
}

export interface MessageSearchItem {
  match: MessageSearchMatch;
  message: PublicMessage;
}

export interface MessageSearchPage {
  items: MessageSearchItem[];
  mode: MessageSearchMode;
  nextCursor: MessageSearchCursor | null;
}

interface MessageSearchCursorPayload extends MessageSearchCursor {
  v: 1;
}

export class InvalidSearchCursorError extends Error {
  readonly code = 'invalid_cursor';

  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidSearchCursorError';
  }
}

function invalidCursor(): never {
  throw new InvalidSearchCursorError();
}

export function unicodeLength(value: string): number {
  return Array.from(value).length;
}

export function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('Z')) {
    return false;
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function canonicalKey(key: MessageSearchKey): string {
  const value = {
    v: 1,
    query: key.query,
    channelId: key.channelId,
    from: key.from,
    to: key.to,
    sort: key.sort,
    ...(key.channelIds && key.channelIds.length > 0
      ? { channelIds: [...key.channelIds].sort() }
      : {}),
  };
  return JSON.stringify(value);
}

export function messageSearchQueryHash(key: MessageSearchKey): string {
  return createHash('sha256').update(canonicalKey(key), 'utf8').digest('hex');
}

function payload(cursor: MessageSearchCursor): MessageSearchCursorPayload {
  return {
    v: 1,
    queryHash: cursor.queryHash,
    snapshotAt: cursor.snapshotAt,
    score: cursor.score,
    publishedAt: cursor.publishedAt,
    messageId: cursor.messageId,
  };
}

function validateCursor(cursor: MessageSearchCursor): void {
  if (
    !SHA256_PATTERN.test(cursor.queryHash) ||
    !isCanonicalIsoTimestamp(cursor.snapshotAt) ||
    !isCanonicalIsoTimestamp(cursor.publishedAt) ||
    !UUID_PATTERN.test(cursor.messageId) ||
    (cursor.score !== null &&
      (!Number.isFinite(cursor.score) || cursor.score < 0 || cursor.score > 1))
  ) {
    invalidCursor();
  }
}

function parsePayload(value: unknown): MessageSearchCursorPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidCursor();
  }
  const keys = Object.keys(value);
  const expected = ['v', 'queryHash', 'snapshotAt', 'score', 'publishedAt', 'messageId'];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    return invalidCursor();
  }

  const candidate = value as Partial<MessageSearchCursorPayload>;
  if (candidate.v !== 1) {
    return invalidCursor();
  }
  const cursor: MessageSearchCursor = {
    messageId: candidate.messageId ?? '',
    publishedAt: candidate.publishedAt ?? '',
    queryHash: candidate.queryHash ?? '',
    score: candidate.score === null || typeof candidate.score === 'number' ? candidate.score : NaN,
    snapshotAt: candidate.snapshotAt ?? '',
  };
  validateCursor(cursor);
  return payload(cursor);
}

export function encodeMessageSearchCursor(cursor: MessageSearchCursor): string {
  validateCursor(cursor);
  return Buffer.from(JSON.stringify(payload(cursor)), 'utf8').toString('base64url');
}

export function decodeMessageSearchCursor(
  encoded: string,
  key: MessageSearchKey,
): MessageSearchCursor {
  if (!encoded || encoded.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return invalidCursor();
  }

  let json: string;
  let parsed: unknown;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) {
      return invalidCursor();
    }
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(json);
  } catch {
    return invalidCursor();
  }

  const decoded = parsePayload(parsed);
  if (
    JSON.stringify(decoded) !== json ||
    decoded.queryHash !== messageSearchQueryHash(key) ||
    (key.sort === 'relevance') !== (decoded.score !== null)
  ) {
    return invalidCursor();
  }
  return {
    messageId: decoded.messageId,
    publishedAt: decoded.publishedAt,
    queryHash: decoded.queryHash,
    score: decoded.score,
    snapshotAt: decoded.snapshotAt,
  };
}

function clippedCodePoints(value: string, start: number, length: number): string {
  return Array.from(value)
    .slice(start, start + length)
    .join('');
}

export function messageSearchSnippet(text: string, query: string, maxCodePoints = 280): string {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1) {
    throw new RangeError('maxCodePoints must be a positive integer');
  }
  const textPoints = Array.from(text);
  if (textPoints.length <= maxCodePoints) {
    return text;
  }

  const queryIndex = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const codeUnitPrefix = queryIndex < 0 ? '' : text.slice(0, queryIndex);
  const matchPoint = queryIndex < 0 ? 0 : Array.from(codeUnitPrefix).length;
  const contentLength = Math.max(1, maxCodePoints - 2);
  const start = Math.max(
    0,
    Math.min(textPoints.length - contentLength, matchPoint - Math.floor(contentLength / 3)),
  );
  const end = Math.min(textPoints.length, start + contentLength);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < textPoints.length ? '…' : '';
  return `${prefix}${clippedCodePoints(text, start, contentLength)}${suffix}`;
}
