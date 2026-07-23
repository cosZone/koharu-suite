import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { RuntimeAuth } from '../src/auth/runtime-auth.js';
import type { MessageReader, PublicMessage } from '../src/messages/types.js';
import { channelPostFixture } from './fixtures/telegram.js';

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

describe('owner admin endpoints', () => {
  const ownerAuth: RuntimeAuth = {
    getSession: async () => ({
      user: {
        email: 'owner@example.com',
        id: 'owner-user-id',
        twoFactorEnabled: true,
      },
    }),
    handle: async () => new Response(null, { status: 204 }),
  };

  it('returns no-store 401 and 403 responses at the owner boundary', async () => {
    const anonymous = await createApp().request('/api/v1/admin/status');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
    expect(anonymous.headers.get('vary')).toBe('Cookie');

    const forbidden = await createApp({
      auth: ownerAuth,
      owners: { isOwner: async () => false },
    }).request('/api/v1/admin/status');
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({
      error: { code: 'owner_required' },
    });
  });

  it('serves owner status and reveals raw only through the explicit no-store endpoint', async () => {
    const rawUpdate = channelPostFixture();
    const app = createApp({
      admin: {
        getCounts: async () => ({ channels: 1, messages: 2, updates: 3 }),
        getRawUpdate: async (messageId) => (messageId === MESSAGE_ID ? rawUpdate : null),
      },
      auth: ownerAuth,
      collectorState: () => 'running',
      owners: { isOwner: async () => true },
    });

    const status = await app.request('/api/v1/admin/status');
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      collector: 'running',
      counts: { channels: 1, messages: 2, updates: 3 },
      owner: {
        email: 'owner@example.com',
        twoFactorEnabled: true,
      },
      version: '0.1.0',
    });

    const invalid = await app.request('/api/v1/admin/messages/not-a-uuid/raw');
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('cache-control')).toBe('private, no-store');

    const missing = await app.request(
      '/api/v1/admin/messages/019bf895-0e70-7881-83b3-471b8dbb1b34/raw',
    );
    expect(missing.status).toBe(404);

    const revealed = await app.request(`/api/v1/admin/messages/${MESSAGE_ID}/raw`);
    expect(revealed.status).toBe(200);
    expect(revealed.headers.get('cache-control')).toBe('private, no-store');
    expect(revealed.headers.get('vary')).toBe('Cookie');
    await expect(revealed.json()).resolves.toEqual({ update: rawUpdate });
  });
});

describe('production Admin assets', () => {
  it('redirects /admin and serves the built index and hashed assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-admin-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Owner Desk</title>');
    await writeFile(join(root, 'assets', 'app-hash.js'), 'console.log("owner desk");');

    try {
      const app = createApp({ adminAssetsRoot: root });
      const redirect = await app.request('/admin');
      expect(redirect.status).toBe(308);
      expect(redirect.headers.get('location')).toBe('/admin/');

      const index = await app.request('/admin/');
      expect(index.status).toBe(200);
      expect(index.headers.get('cache-control')).toBe('no-cache');
      await expect(index.text()).resolves.toContain('<title>Owner Desk</title>');

      const asset = await app.request('/admin/assets/app-hash.js');
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      await expect(asset.text()).resolves.toContain('owner desk');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
