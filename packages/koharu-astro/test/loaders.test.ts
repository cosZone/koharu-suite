import { describe, expect, it, vi } from 'vitest';
import type { KoharuClient } from '../src/client.js';
import { KoharuError } from '../src/errors.js';
import { koharuChannelsLoader, koharuMessagesLoader } from '../src/loaders.js';
import { CHANNEL_ID, channel, MESSAGE_ID, message } from './fixtures.js';

function mockClient(): KoharuClient {
  return {
    channels: {
      list: vi.fn(async () => ({ items: [channel] })),
    },
    messages: {
      context: vi.fn(async () => ({ message, newer: null, older: null })),
      get: vi.fn(async () => message),
      latest: vi.fn(async () => ({ items: [message], nextCursor: null })),
      list: vi.fn(async () => ({ items: [message], nextCursor: 'not-exposed-by-loader' })),
    },
    resolveUrl: vi.fn((path) => path),
    search: {
      messages: vi.fn(async () => ({
        items: [],
        mode: 'trigram' as const,
        nextCursor: null,
      })),
    },
    urls: {
      channelRss: vi.fn(() => 'https://suite.example/channel.xml'),
      globalRss: vi.fn(() => 'https://suite.example/rss.xml'),
    },
  };
}

describe('Astro 6 Live Loaders', () => {
  it('maps channels to collection entries without a cache hint', async () => {
    const client = mockClient();
    const loader = koharuChannelsLoader({ client });

    const result = await loader.loadCollection({ collection: 'koharuChannels' });

    expect(result).toEqual({
      entries: [{ data: channel, id: CHANNEL_ID }],
    });
    expect(result).not.toHaveProperty('cacheHint');
  });

  it('finds a channel entry by suite ID and returns undefined when absent', async () => {
    const client = mockClient();
    const loader = koharuChannelsLoader({ client });

    await expect(
      loader.loadEntry({
        collection: 'koharuChannels',
        filter: { id: CHANNEL_ID },
      }),
    ).resolves.toEqual({ data: channel, id: CHANNEL_ID });
    await expect(
      loader.loadEntry({
        collection: 'koharuChannels',
        filter: { id: '019bf894-2b6c-7b18-bd70-0ad6349a4af2' },
      }),
    ).resolves.toBeUndefined();
  });

  it('loads exactly one message page and maps stored HTML to rendered content', async () => {
    const client = mockClient();
    const loader = koharuMessagesLoader({ client });

    const result = await loader.loadCollection({
      collection: 'koharuMessages',
      filter: { channelId: CHANNEL_ID, cursor: 'opaque', limit: 25 },
    });

    expect(client.messages.list).toHaveBeenCalledWith({
      channelId: CHANNEL_ID,
      cursor: 'opaque',
      limit: 25,
    });
    expect(result).toEqual({
      entries: [
        {
          data: message,
          id: MESSAGE_ID,
          rendered: { html: '<p>Koharu result</p>' },
        },
      ],
    });
    expect(result).not.toHaveProperty('nextCursor');
    expect(result).not.toHaveProperty('cacheHint');
  });

  it('loads message details and does not invent rendered content for null HTML', async () => {
    const client = mockClient();
    const withoutHtml = {
      ...message,
      content: { ...message.content, html: null },
    };
    client.messages.get = vi.fn(async () => withoutHtml);
    const loader = koharuMessagesLoader({ client });

    await expect(
      loader.loadEntry({
        collection: 'koharuMessages',
        filter: { id: MESSAGE_ID },
      }),
    ).resolves.toEqual({
      data: withoutHtml,
      id: MESSAGE_ID,
    });
  });

  it('returns the original KoharuError without flattening it to a string', async () => {
    const client = mockClient();
    const error = KoharuError.network(new Error('connection reset'));
    client.messages.get = vi.fn(async () => {
      throw error;
    });
    const loader = koharuMessagesLoader({ client });

    const result = await loader.loadEntry({
      collection: 'koharuMessages',
      filter: { id: MESSAGE_ID },
    });

    if (!result) throw new Error('Expected loader error');
    expect(result).toEqual({ error });
    expect('error' in result && result.error).toBe(error);
  });

  it('normalizes unexpected adapter failures and missing collection filters safely', async () => {
    const client = mockClient();
    client.channels.list = vi.fn(async () => {
      throw new Error('unexpected private detail');
    });
    const channelResult = await koharuChannelsLoader({ client }).loadCollection({
      collection: 'koharuChannels',
    });
    expect(channelResult).toMatchObject({
      error: { cause: undefined, kind: 'invalid_response' },
    });

    const messageResult = await koharuMessagesLoader({ client }).loadCollection({
      collection: 'koharuMessages',
    });
    expect(messageResult).toMatchObject({
      error: { cause: undefined, kind: 'invalid_response' },
    });
  });

  it('constructs a client lazily without reading environment variables or fetching', () => {
    const fetchMock = vi.fn();

    koharuChannelsLoader({
      baseUrl: 'https://suite.example',
      fetch: fetchMock as typeof fetch,
    });
    koharuMessagesLoader({
      baseUrl: 'https://suite.example',
      fetch: fetchMock as typeof fetch,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
