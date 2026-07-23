import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { MessageReader, PublicMessage } from '../src/messages/types.js';

const CHANNEL_ID = '019bf894-2b6c-7b18-bd70-0ad6349a4af1';
const MESSAGE_ID = '019bf895-0e70-7881-83b3-471b8dbb1b33';

const message: PublicMessage = {
  authorSignature: 'Koharu',
  channel: {
    id: CHANNEL_ID,
    title: 'Koharu Test Channel',
    username: 'koharu_test',
  },
  content: {
    entities: [],
    kind: 'text',
    text: 'First post',
  },
  id: MESSAGE_ID,
  media: [],
  mediaGroupId: null,
  publishedAt: '2025-06-30T16:13:20.000Z',
  revision: 1,
  sourceUrl: 'https://t.me/koharu_test/42',
};

function createReader(): MessageReader {
  return {
    getMessage: async (id) => (id === MESSAGE_ID ? message : null),
    listChannels: async () => [message.channel],
    listMessages: async (channelId) => (channelId === CHANNEL_ID ? [message] : null),
  };
}

describe('health endpoints', () => {
  it.each(['/healthz', '/api/v1/health'])('reports health at %s', async (path) => {
    const response = await createApp().request(path);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      service: 'koharu-suite',
      status: 'ok',
      version: '0.1.0',
    });
  });
});

describe('public message endpoints', () => {
  it('discovers channels and returns stable suite message resources', async () => {
    const app = createApp({ messages: createReader() });

    const channelsResponse = await app.request('/api/v1/channels');
    expect(channelsResponse.status).toBe(200);
    await expect(channelsResponse.json()).resolves.toEqual({ items: [message.channel] });

    const listResponse = await app.request(`/api/v1/messages?channel=${CHANNEL_ID}`);
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({ items: [message] });

    const detailResponse = await app.request(`/api/v1/messages/${MESSAGE_ID}`);
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toEqual(message);
  });

  it.each([
    ['/api/v1/messages', 'invalid_channel'],
    ['/api/v1/messages?channel=not-a-uuid', 'invalid_channel'],
    ['/api/v1/messages/not-a-uuid', 'invalid_message_id'],
  ])('rejects an invalid request at %s', async (path, code) => {
    const response = await createApp({ messages: createReader() }).request(path);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code },
    });
  });

  it.each([
    [`/api/v1/messages?channel=019bf894-2b6c-7b18-bd70-0ad6349a4af2`, 'channel_not_found'],
    [`/api/v1/messages/019bf895-0e70-7881-83b3-471b8dbb1b34`, 'message_not_found'],
  ])('returns not found at %s without leaking storage details', async (path, code) => {
    const response = await createApp({ messages: createReader() }).request(path);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code },
    });
  });
});
