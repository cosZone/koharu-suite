import type { ZodType } from 'astro/zod';
import { KoharuError, type KoharuRateLimit } from './errors.js';
import {
  apiErrorResponseSchema,
  type ChannelListResponse,
  canonicalUtcTimestampSchema,
  channelListResponseSchema,
  type MessageContext,
  type MessagePage,
  messageContextSchema,
  messagePageSchema,
  type PublicMessage,
  publicMessageSchema,
  type SearchMessagePage,
  searchMessagePageSchema,
  suiteIdSchema,
} from './schemas.js';
import { canonicalSuiteOrigin, channelRssUrl, globalRssUrl, resolveSuiteUrl } from './urls.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_VISIBLE_CHANNEL_IDS = 32;

export interface KoharuRequestOptions {
  signal?: AbortSignal;
}

export interface ListMessagesOptions extends KoharuRequestOptions {
  channelId: string;
  cursor?: string;
  limit?: number;
}

export interface LatestMessagesOptions extends KoharuRequestOptions {
  channelIds?: string[];
  cursor?: string;
  limit?: number;
}

export interface GetMessageOptions extends KoharuRequestOptions {
  messageId: string;
}

export type SearchTimestamp = Date | string;
export type SearchMessageSort = 'newest' | 'relevance';

export interface SearchMessagesOptions extends KoharuRequestOptions {
  channelId?: string;
  channelIds?: string[];
  cursor?: string;
  from?: SearchTimestamp;
  limit?: number;
  query: string;
  sort?: SearchMessageSort;
  to?: SearchTimestamp;
}

export interface CreateKoharuClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface KoharuClient {
  readonly channels: {
    list(options?: KoharuRequestOptions): Promise<ChannelListResponse>;
  };
  readonly messages: {
    context(options: GetMessageOptions): Promise<MessageContext>;
    get(options: GetMessageOptions): Promise<PublicMessage>;
    latest(options?: LatestMessagesOptions): Promise<MessagePage>;
    list(options: ListMessagesOptions): Promise<MessagePage>;
  };
  readonly search: {
    messages(options: SearchMessagesOptions): Promise<SearchMessagePage>;
  };
  readonly urls: {
    channelRss(channelId: string): string;
    globalRss(): string;
  };
  resolveUrl(path: string | null | undefined): string | null;
}

interface RequestRuntime {
  fetch: typeof globalThis.fetch;
  origin: string;
  timeoutMs: number;
}

function timeoutMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < MIN_TIMEOUT_MS || resolved > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return resolved;
}

function assertSuiteId(value: string, name: string): string {
  const parsed = suiteIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`${name} must be a suite UUID`);
  }
  return parsed.data;
}

function assertLimit(value: number | undefined, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`limit must be between 1 and ${maximum}`);
  }
  return value;
}

function assertCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length < 1) {
    throw new TypeError('cursor must not be empty');
  }
  return value;
}

function visibleChannelIds(values: string[] | undefined): string[] {
  if (values === undefined || values.length === 0) return [];
  const unique = [...new Set(values.map((value) => assertSuiteId(value, 'channelIds')))].slice(
    0,
    MAX_VISIBLE_CHANNEL_IDS + 1,
  );
  if (unique.length > MAX_VISIBLE_CHANNEL_IDS) {
    throw new RangeError(`channelIds must contain at most ${MAX_VISIBLE_CHANNEL_IDS} unique IDs`);
  }
  return unique;
}

function appendChannelIds(search: URLSearchParams, channelIds: string[]): void {
  for (const channelId of channelIds) search.append('channel', channelId);
}

function canonicalSearchTimestamp(
  value: SearchTimestamp | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = value instanceof Date ? value.toISOString() : value;
  const parsed = canonicalUtcTimestampSchema.safeParse(timestamp);
  if (!parsed.success) {
    throw new TypeError(`${name} must be a canonical UTC timestamp or valid Date`);
  }
  return parsed.data;
}

function numericHeader(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function responseRateLimit(response: Response): KoharuRateLimit | null {
  const value = {
    limit: numericHeader(response.headers.get('RateLimit-Limit')),
    remaining: numericHeader(response.headers.get('RateLimit-Remaining')),
    resetAt: numericHeader(response.headers.get('RateLimit-Reset')),
  };
  return value.limit === null && value.remaining === null && value.resetAt === null ? null : value;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

async function requestJson<T>(
  runtime: RequestRuntime,
  path: string,
  schema: ZodType<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  if (callerSignal?.aborted) {
    throw KoharuError.aborted();
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), runtime.timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal;

  let response: Response;
  let body: string;
  try {
    response = await runtime.fetch(new URL(path, `${runtime.origin}/`), {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      method: 'GET',
      signal,
    });
    body = await response.text();
  } catch (cause) {
    if (callerSignal?.aborted) throw KoharuError.aborted();
    if (timeoutController.signal.aborted) throw KoharuError.timeout();
    throw KoharuError.network(cause);
  } finally {
    clearTimeout(timer);
  }

  const json = parseJson(body);
  if (!response.ok) {
    const parsedError = apiErrorResponseSchema.safeParse(json);
    throw KoharuError.http({
      code: parsedError.success ? parsedError.data.error.code : `http_${response.status}`,
      rateLimit: responseRateLimit(response),
      retryAfterSeconds: numericHeader(response.headers.get('Retry-After')),
      status: response.status,
    });
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw KoharuError.invalidResponse();
  }
  return parsed.data;
}

function messageListPath(options: ListMessagesOptions): string {
  const search = new URLSearchParams({
    channel: assertSuiteId(options.channelId, 'channelId'),
  });
  const limit = assertLimit(options.limit, 100);
  const cursor = assertCursor(options.cursor);
  if (limit !== undefined) search.set('limit', String(limit));
  if (cursor !== undefined) search.set('cursor', cursor);
  return `/api/v1/messages?${search.toString()}`;
}

function latestMessagesPath(options: LatestMessagesOptions): string {
  const search = new URLSearchParams();
  appendChannelIds(search, visibleChannelIds(options.channelIds));
  const limit = assertLimit(options.limit, 100);
  const cursor = assertCursor(options.cursor);
  if (limit !== undefined) search.set('limit', String(limit));
  if (cursor !== undefined) search.set('cursor', cursor);
  const query = search.toString();
  return `/api/v1/messages/latest${query ? `?${query}` : ''}`;
}

function searchMessagesPath(options: SearchMessagesOptions): string {
  const query = options.query.trim();
  const queryLength = Array.from(query).length;
  if (queryLength < 1 || queryLength > 200) {
    throw new RangeError('query must contain between 1 and 200 Unicode characters');
  }
  const channelId =
    options.channelId === undefined ? undefined : assertSuiteId(options.channelId, 'channelId');
  if (channelId !== undefined && options.channelIds !== undefined) {
    throw new TypeError('channelId and channelIds cannot be used together');
  }
  const channelIds = visibleChannelIds(options.channelIds);
  const from = canonicalSearchTimestamp(options.from, 'from');
  const to = canonicalSearchTimestamp(options.to, 'to');
  if (from !== undefined && to !== undefined && from >= to) {
    throw new RangeError('from must be earlier than to');
  }

  const shortQuery = queryLength < 3;
  const sort = options.sort;
  if (
    shortQuery &&
    ((channelId === undefined && channelIds.length !== 1) ||
      from === undefined ||
      to === undefined ||
      new Date(to).getTime() - new Date(from).getTime() > 31 * 24 * 60 * 60 * 1_000 ||
      (sort !== undefined && sort !== 'newest'))
  ) {
    throw new RangeError(
      '1-2 character searches require one channel, a UTC window of at most 31 days, and newest sorting',
    );
  }

  const search = new URLSearchParams({ q: query });
  const limit = assertLimit(options.limit, shortQuery ? 20 : 50);
  const cursor = assertCursor(options.cursor);
  if (channelId !== undefined) search.set('channel', channelId);
  appendChannelIds(search, channelIds);
  if (from !== undefined) search.set('from', from);
  if (to !== undefined) search.set('to', to);
  if (sort !== undefined) search.set('sort', sort);
  if (limit !== undefined) search.set('limit', String(limit));
  if (cursor !== undefined) search.set('cursor', cursor);
  return `/api/v1/search/messages?${search.toString()}`;
}

export function createKoharuClient(options: CreateKoharuClientOptions): KoharuClient {
  const origin = canonicalSuiteOrigin(options.baseUrl);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('A fetch implementation is required');
  }
  const runtime: RequestRuntime = {
    fetch: fetchImplementation,
    origin,
    timeoutMs: timeoutMs(options.timeoutMs),
  };

  return {
    channels: {
      list: (requestOptions = {}) =>
        requestJson(runtime, '/api/v1/channels', channelListResponseSchema, requestOptions.signal),
    },
    messages: {
      context: (requestOptions) =>
        requestJson(
          runtime,
          `/api/v1/messages/${encodeURIComponent(
            assertSuiteId(requestOptions.messageId, 'messageId'),
          )}/context`,
          messageContextSchema,
          requestOptions.signal,
        ),
      get: (requestOptions) =>
        requestJson(
          runtime,
          `/api/v1/messages/${encodeURIComponent(
            assertSuiteId(requestOptions.messageId, 'messageId'),
          )}`,
          publicMessageSchema,
          requestOptions.signal,
        ),
      latest: (requestOptions = {}) =>
        requestJson(
          runtime,
          latestMessagesPath(requestOptions),
          messagePageSchema,
          requestOptions.signal,
        ),
      list: (requestOptions) =>
        requestJson(
          runtime,
          messageListPath(requestOptions),
          messagePageSchema,
          requestOptions.signal,
        ),
    },
    resolveUrl: (path) => resolveSuiteUrl(origin, path),
    search: {
      messages: (requestOptions) =>
        requestJson(
          runtime,
          searchMessagesPath(requestOptions),
          searchMessagePageSchema,
          requestOptions.signal,
        ),
    },
    urls: {
      channelRss: (channelId) => channelRssUrl(origin, channelId),
      globalRss: () => globalRssUrl(origin),
    },
  };
}

export type { KoharuErrorKind, KoharuRateLimit } from './errors.js';
export { isKoharuError, KoharuError } from './errors.js';
export {
  canonicalSuiteOrigin,
  channelRssUrl,
  globalRssUrl,
  resolveSuiteUrl,
} from './urls.js';
