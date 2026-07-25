import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKoharuClient, isKoharuError, type KoharuError } from '../src/client.js';
import { CHANNEL_ID, channel, MESSAGE_ID, message } from './fixtures.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

async function rejected(request: Promise<unknown>): Promise<KoharuError> {
  try {
    await request;
  } catch (error) {
    expect(isKoharuError(error)).toBe(true);
    return error as KoharuError;
  }
  throw new Error('Expected request to reject');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('typed client', () => {
  it('parses channel, message list, and message detail responses with no-store requests', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/channels') return jsonResponse({ items: [channel] });
      if (url.pathname === `/api/v1/messages/${MESSAGE_ID}`) return jsonResponse(message);
      return jsonResponse({ items: [message], nextCursor: 'next-page' });
    });
    const client = createKoharuClient({
      baseUrl: 'https://suite.example',
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.channels.list()).resolves.toEqual({ items: [channel] });
    await expect(
      client.messages.list({ channelId: CHANNEL_ID, cursor: 'opaque cursor', limit: 25 }),
    ).resolves.toMatchObject({ nextCursor: 'next-page' });
    await expect(client.messages.get({ messageId: MESSAGE_ID })).resolves.toEqual(message);

    const listUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(listUrl.searchParams.get('channel')).toBe(CHANNEL_ID);
    expect(listUrl.searchParams.get('cursor')).toBe('opaque cursor');
    expect(listUrl.searchParams.get('limit')).toBe('25');
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        method: 'GET',
      });
    }
  });

  it('canonicalizes dates, trims the query, and omits undefined search parameters', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        items: [{ match: { score: 0.8, snippet: 'Astro 6' }, message }],
        mode: 'trigram',
        nextCursor: null,
      }),
    );
    const client = createKoharuClient({
      baseUrl: 'https://suite.example',
      fetch: fetchMock as typeof fetch,
    });

    await client.search.messages({
      cursor: 'opaque+cursor',
      from: new Date('2026-07-01T00:00:00.000Z'),
      query: '  Astro 6  ',
      sort: 'newest',
      to: '2026-08-01T00:00:00.000Z',
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v1/search/messages');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      cursor: 'opaque+cursor',
      from: '2026-07-01T00:00:00.000Z',
      q: 'Astro 6',
      sort: 'newest',
      to: '2026-08-01T00:00:00.000Z',
    });
    expect(url.searchParams.has('channel')).toBe(false);
    expect(url.searchParams.has('limit')).toBe(false);
  });

  it('validates short search boundaries before issuing a request', async () => {
    const fetchMock = vi.fn();
    const client = createKoharuClient({
      baseUrl: 'https://suite.example',
      fetch: fetchMock as typeof fetch,
    });

    expect(() => client.search.messages({ query: '星' })).toThrow('1-2 character searches require');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes API and fallback HTTP errors without retaining response bodies', async () => {
    const apiClient = createKoharuClient({
      baseUrl: 'https://suite.example',
      fetch: vi.fn(async () =>
        jsonResponse(
          { error: { code: 'message_not_found', message: 'sensitive server detail' } },
          { status: 404 },
        ),
      ) as typeof fetch,
    });
    const apiError = await rejected(apiClient.messages.get({ messageId: MESSAGE_ID }));
    expect(apiError).toMatchObject({
      cause: undefined,
      code: 'message_not_found',
      kind: 'http',
      status: 404,
    });
    expect(apiError.message).not.toContain('sensitive server detail');

    const htmlClient = createKoharuClient({
      baseUrl: 'https://suite.example',
      fetch: vi.fn(
        async () => new Response('<article>private response body</article>', { status: 500 }),
      ) as typeof fetch,
    });
    const htmlError = await rejected(htmlClient.channels.list());
    expect(htmlError).toMatchObject({ code: 'http_500', kind: 'http', status: 500 });
    expect(htmlError.message).not.toContain('private response body');
    expect(htmlError.cause).toBeUndefined();
  });

  it('preserves bounded rate-limit metadata on 429', async () => {
    const client = createKoharuClient({
      baseUrl: 'https://suite.example',
      fetch: vi.fn(async () =>
        jsonResponse(
          { error: { code: 'rate_limited', message: 'Too many requests' } },
          {
            headers: {
              'RateLimit-Limit': '120',
              'RateLimit-Remaining': '0',
              'RateLimit-Reset': '1784887260',
              'Retry-After': '42',
            },
            status: 429,
          },
        ),
      ) as typeof fetch,
    });

    const error = await rejected(client.channels.list());
    expect(error).toMatchObject({
      code: 'rate_limited',
      rateLimit: { limit: 120, remaining: 0, resetAt: 1_784_887_260 },
      retryAfterSeconds: 42,
      status: 429,
    });
  });

  it('classifies invalid success responses without exposing content', async () => {
    const invalidJsonClient = createKoharuClient({
      baseUrl: 'https://suite.example',
      fetch: vi.fn(async () => new Response('private invalid JSON')) as typeof fetch,
    });
    const jsonError = await rejected(invalidJsonClient.channels.list());
    expect(jsonError).toMatchObject({
      cause: undefined,
      code: null,
      kind: 'invalid_response',
      status: null,
    });
    expect(jsonError.message).not.toContain('private invalid JSON');

    const driftClient = createKoharuClient({
      baseUrl: 'https://suite.example',
      fetch: vi.fn(async () => jsonResponse({ items: 'not-an-array' })) as typeof fetch,
    });
    const driftError = await rejected(driftClient.channels.list());
    expect(driftError.kind).toBe('invalid_response');
    expect(driftError.cause).toBeUndefined();
  });

  it('preserves a network cause while using a safe normalized message', async () => {
    const cause = new Error('low-level connection failure');
    const client = createKoharuClient({
      baseUrl: 'https://suite.example',
      fetch: vi.fn(async () => {
        throw cause;
      }) as typeof fetch,
    });

    const error = await rejected(client.channels.list());
    expect(error).toMatchObject({ code: null, kind: 'network', status: null });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('Koharu Suite request failed');
  });

  it('gives caller abort precedence and does not retain its reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('private caller reason'));
    const fetchMock = vi.fn();
    const client = createKoharuClient({
      baseUrl: 'https://suite.example',
      fetch: fetchMock as typeof fetch,
    });

    const error = await rejected(client.channels.list({ signal: controller.signal }));
    expect(error).toMatchObject({ cause: undefined, kind: 'aborted' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies the package timeout without retaining adapter rejection details', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('private timeout adapter detail'));
          });
        }),
    );
    const client = createKoharuClient({
      baseUrl: 'https://suite.example',
      fetch: fetchMock as typeof fetch,
      timeoutMs: 1_000,
    });

    const errorRequest = rejected(client.channels.list());
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await errorRequest;
    expect(error).toMatchObject({ cause: undefined, kind: 'timeout' });
    expect(error.message).not.toContain('private timeout adapter detail');
  });

  it('rejects unsafe origins, invalid IDs, and out-of-range timeouts before fetch', () => {
    expect(() => createKoharuClient({ baseUrl: 'https://suite.example/' })).toThrow(TypeError);
    expect(() => createKoharuClient({ baseUrl: 'https://suite.example', timeoutMs: 999 })).toThrow(
      RangeError,
    );

    const client = createKoharuClient({ baseUrl: 'https://suite.example' });
    expect(() => client.messages.get({ messageId: 'not-a-uuid' })).toThrow(TypeError);
  });
});
