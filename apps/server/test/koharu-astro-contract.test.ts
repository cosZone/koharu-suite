import {
  apiErrorResponseSchema,
  channelListResponseSchema,
  messagePageSchema,
  publicMessageSchema,
  searchMessagePageSchema,
} from '@coszone/koharu-astro/schemas';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type {
  MessageDiscoveryReader,
  MessageReader,
  PublicMessage,
} from '../src/messages/types.js';

const CHANNEL_ID = '019bf894-2b6c-7b18-bd70-0ad6349a4af1';
const MESSAGE_ID = '019bf895-0e70-7881-83b3-471b8dbb1b33';

const message: PublicMessage = {
  authorSignature: 'Koharu',
  channel: {
    id: CHANNEL_ID,
    title: 'Koharu Contract',
    username: 'koharu_contract',
  },
  content: {
    entities: [
      {
        length: 6,
        offset: 0,
        type: 'future_telegram_entity',
      },
    ],
    html: '<p>Koharu contract</p>',
    kind: 'text',
    text: 'Koharu contract',
  },
  id: MESSAGE_ID,
  media: [
    {
      cacheStatus: 'ready',
      duration: null,
      fileName: 'contract.png',
      fileSize: '9007199254740993',
      height: 720,
      id: '019bf895-0e70-7881-83b3-471b8dbb1b34',
      kind: 'photo',
      mimeType: 'image/png',
      originalUrl: '/api/v1/media/019bf895-0e70-7881-83b3-471b8dbb1b35',
      thumbnailUrl: '/api/v1/media/019bf895-0e70-7881-83b3-471b8dbb1b36',
      width: 1280,
    },
  ],
  mediaGroupId: null,
  publishedAt: '2026-07-24T00:00:00.000Z',
  revision: 2,
  sourceUrl: 'https://t.me/koharu_contract/42',
};

function createMessages(): MessageReader {
  return {
    getMessage: async (id) => (id === MESSAGE_ID ? message : null),
    listChannels: async () => [message.channel],
    listMessages: async (channelId) =>
      channelId === CHANNEL_ID
        ? {
            items: [message],
            nextCursor: null,
          }
        : null,
  };
}

function createDiscovery(): MessageDiscoveryReader {
  return {
    getFeed: async () => null,
    searchMessages: async () => ({
      items: [
        {
          match: {
            score: 0.75,
            snippet: 'Koharu contract',
          },
          message,
        },
      ],
      mode: 'trigram',
      nextCursor: null,
    }),
  };
}

describe('@coszone/koharu-astro server contracts', () => {
  it('parses channels, message pages, details, and search responses from the real Hono routes', async () => {
    const app = createApp({
      discovery: createDiscovery(),
      messages: createMessages(),
    });

    const channels = await app.request('/api/v1/channels');
    expect(channels.status).toBe(200);
    expect(channelListResponseSchema.parse(await channels.json())).toEqual({
      items: [message.channel],
    });

    const page = await app.request(`/api/v1/messages?channel=${CHANNEL_ID}`);
    expect(page.status).toBe(200);
    expect(messagePageSchema.parse(await page.json())).toEqual({
      items: [message],
      nextCursor: null,
    });

    const detail = await app.request(`/api/v1/messages/${MESSAGE_ID}`);
    expect(detail.status).toBe(200);
    expect(publicMessageSchema.parse(await detail.json())).toEqual(message);

    const search = await app.request('/api/v1/search/messages?q=koharu');
    expect(search.status).toBe(200);
    expect(searchMessagePageSchema.parse(await search.json())).toEqual({
      items: [
        {
          match: {
            score: 0.75,
            snippet: 'Koharu contract',
          },
          message,
        },
      ],
      mode: 'trigram',
      nextCursor: null,
    });
  });

  it('parses the public API error envelope without closing the error-code vocabulary', async () => {
    const response = await createApp({ messages: createMessages() }).request(
      '/api/v1/messages/not-a-uuid',
    );

    expect(response.status).toBe(400);
    expect(apiErrorResponseSchema.parse(await response.json())).toEqual({
      error: {
        code: 'invalid_message_id',
        message: 'id must be a suite message UUID',
      },
    });
  });
});
