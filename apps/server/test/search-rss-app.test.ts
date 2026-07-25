import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { messageSearchQueryHash } from '../src/messages/search.js';
import type { MessageDiscoveryReader, PublicMessage } from '../src/messages/types.js';

const CHANNEL_ID = '019bf894-2b6c-7b18-bd70-0ad6349a4af1';
const OTHER_CHANNEL_ID = '019bf894-2b6c-7b18-bd70-0ad6349a4af2';
const MESSAGE_ID = '019bf895-0e70-7881-83b3-471b8dbb1b33';
const message: PublicMessage = {
  authorSignature: null,
  channel: { id: CHANNEL_ID, title: 'Koharu Test', username: 'koharu_test' },
  content: { entities: [], html: '<p>Koharu result</p>', kind: 'text', text: 'Koharu result' },
  id: MESSAGE_ID,
  media: [],
  mediaGroupId: null,
  publishedAt: '2026-07-24T00:00:00.000Z',
  revision: 1,
  sourceUrl: 'https://t.me/koharu_test/42',
};

function createDiscovery(): MessageDiscoveryReader {
  return {
    getFeed: vi.fn(async (channelId) =>
      channelId && channelId !== CHANNEL_ID
        ? null
        : {
            channel:
              channelId === undefined
                ? null
                : {
                    ...message.channel,
                    updatedAt: '2026-07-24T01:00:00.000Z',
                  },
            items: [message],
            updatedAt: '2026-07-24T01:00:00.000Z',
          },
    ),
    searchMessages: vi.fn(async (options) => ({
      items: [
        {
          match: { score: options.sort === 'relevance' ? 0.8 : null, snippet: 'Koharu result' },
          message,
        },
      ],
      mode: options.query.length < 3 ? ('short_substring' as const) : ('trigram' as const),
      nextCursor: {
        messageId: MESSAGE_ID,
        publishedAt: message.publishedAt,
        queryHash: messageSearchQueryHash(options),
        score: options.sort === 'relevance' ? 0.8 : null,
        snapshotAt: '2026-07-24T02:00:00.000Z',
      },
    })),
  };
}

describe('search and RSS HTTP routes', () => {
  it('normalizes search input and returns an opaque query-bound cursor', async () => {
    const discovery = createDiscovery();
    const response = await createApp({ discovery }).request(
      `/api/v1/search/messages?q=%20koharu%20&channel=${CHANNEL_ID}&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z&limit=10`,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      items: [{ match: { score: 0.8, snippet: 'Koharu result' }, message: { id: MESSAGE_ID } }],
      mode: 'trigram',
    });
    expect(body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(discovery.searchMessages).toHaveBeenCalledWith({
      channelId: CHANNEL_ID,
      from: '2026-07-01T00:00:00.000Z',
      limit: 10,
      query: 'koharu',
      sort: 'relevance',
      to: '2026-08-01T00:00:00.000Z',
    });
  });

  it('passes deduped multi-channel visibility filters without changing singular behavior', async () => {
    const discovery = createDiscovery();
    const response = await createApp({ discovery }).request(
      `/api/v1/search/messages?q=koharu&channel=${CHANNEL_ID}&channel=${OTHER_CHANNEL_ID}&channel=${CHANNEL_ID}`,
    );

    expect(response.status).toBe(200);
    expect(discovery.searchMessages).toHaveBeenCalledWith({
      channelId: null,
      channelIds: [CHANNEL_ID, OTHER_CHANNEL_ID],
      from: null,
      limit: 20,
      query: 'koharu',
      sort: 'relevance',
      to: null,
    });
  });

  it.each([
    ['/api/v1/search/messages', 'invalid_query'],
    ['/api/v1/search/messages?q=abc&sort=random', 'invalid_sort'],
    ['/api/v1/search/messages?q=abc&from=2026-07-01', 'invalid_time_range'],
    ['/api/v1/search/messages?q=爱', 'short_query_requires_bounded_scope'],
    [
      `/api/v1/search/messages?q=爱&channel=${CHANNEL_ID}&from=2026-01-01T00%3A00%3A00.000Z&to=2026-03-01T00%3A00%3A00.000Z`,
      'short_query_requires_bounded_scope',
    ],
    [
      `/api/v1/search/messages?q=爱&channel=${CHANNEL_ID}&from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-02T00%3A00%3A00.000Z&sort=relevance`,
      'short_query_requires_bounded_scope',
    ],
  ])('rejects invalid search contract at %s', async (path, code) => {
    const response = await createApp({ discovery: createDiscovery() }).request(path);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });

  it('returns channel_not_found for a well-formed missing search channel', async () => {
    const discovery = createDiscovery();
    discovery.searchMessages = vi.fn(async () => null);
    const response = await createApp({ discovery }).request(
      `/api/v1/search/messages?q=koharu&channel=${CHANNEL_ID}`,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'channel_not_found' } });
  });

  it('serves deterministic global RSS with GET, HEAD, and conditional 304', async () => {
    const app = createApp({
      canonicalOrigin: 'https://suite.example',
      discovery: createDiscovery(),
    });
    const get = await app.request('/api/v1/rss.xml', {
      headers: { Host: 'attacker.example' },
    });
    const body = await get.text();

    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
    expect(get.headers.get('cache-control')).toBe('public, no-cache');
    expect(body).toContain('https://suite.example/api/v1/rss.xml');
    expect(body).not.toContain('attacker.example');
    const etag = get.headers.get('etag');
    expect(etag).toBeTruthy();

    const head = await app.request('/api/v1/rss.xml', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('etag')).toBe(etag);
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'));

    const cached = await app.request('/api/v1/rss.xml', {
      headers: { 'If-None-Match': etag ?? '' },
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
  });

  it('validates channel feeds and applies public CORS/rate-limit policy', async () => {
    const app = createApp({
      canonicalOrigin: 'https://suite.example',
      discovery: createDiscovery(),
      publicApi: {
        corsOrigins: new Set(['https://reader.example']),
        rateLimitMax: 1,
        rateLimitWindowMs: 60_000,
        trustProxy: false,
      },
      publicClientAddress: () => '203.0.113.10',
    });
    const feed = await app.request(`/api/v1/channels/${CHANNEL_ID}/rss.xml`, {
      headers: { Origin: 'https://reader.example' },
    });
    expect(feed.status).toBe(200);
    expect(feed.headers.get('access-control-allow-origin')).toBe('https://reader.example');
    expect(feed.headers.get('ratelimit-limit')).toBe('1');

    const limited = await app.request('/api/v1/search/messages?q=koharu');
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: 'rate_limited' } });

    const invalid = await createApp({ discovery: createDiscovery() }).request(
      '/api/v1/channels/not-a-uuid/rss.xml',
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'invalid_channel' } });

    const missing = await createApp({ discovery: createDiscovery() }).request(
      '/api/v1/channels/019bf894-2b6c-7b18-bd70-0ad6349a4af2/rss.xml',
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'channel_not_found' } });
  });
});
