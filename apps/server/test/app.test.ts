import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type AppDependencies, createApp } from '../src/app.js';
import type { AdminPrincipal, RuntimeAuth } from '../src/auth/runtime-auth.js';
import { encodeMessageCursor } from '../src/http/cursor.js';
import type { MessageReader, PublicMessage } from '../src/messages/types.js';
import { channelPostFixture } from './fixtures/telegram.js';

const CHANNEL_ID = '019bf894-2b6c-7b18-bd70-0ad6349a4af1';
const OTHER_CHANNEL_ID = '019bf894-2b6c-7b18-bd70-0ad6349a4af2';
const MESSAGE_ID = '019bf895-0e70-7881-83b3-471b8dbb1b33';
const NEXT_MESSAGE_ID = '019bf895-0e70-7881-83b3-471b8dbb1b34';
const TASK_ID = '019bf895-0e70-7881-83b3-471b8dbb1b35';

const ownerPrincipal: AdminPrincipal = {
  actorId: 'owner-user-id',
  actorType: 'owner_session',
  email: 'owner@example.com',
  permissions: null,
  twoFactorEnabled: true,
};

const serviceTokenPrincipal: AdminPrincipal = {
  actorId: 'service-token-id',
  actorType: 'service_token',
  email: null,
  permissions: {
    admin: ['read'],
    content: ['write'],
    ingestion: ['write'],
  },
  twoFactorEnabled: null,
};

const message: PublicMessage = {
  authorSignature: 'Koharu',
  channel: {
    id: CHANNEL_ID,
    title: 'Koharu Test Channel',
    username: 'koharu_test',
  },
  content: {
    entities: [],
    html: 'First post',
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
    listMessages: async (channelId) =>
      channelId === CHANNEL_ID ? { items: [message], nextCursor: null } : null,
  };
}

function createAuthorizedAuth(
  principal: AdminPrincipal = ownerPrincipal,
  authorize: RuntimeAuth['authorize'] = vi.fn(async () => ({ allowed: true, principal })),
): RuntimeAuth {
  return {
    authorize,
    getSession: async () => null,
    handle: async () => new Response(null, { status: 204 }),
  };
}

function createOperations(): AppDependencies['operations'] {
  return {
    listBlockedTasks: vi.fn(async () => []),
    listConfiguredChannels: vi.fn(async () => []),
    rerenderOutdated: vi.fn(async () => ({
      currentVersion: 1,
      hasMore: false,
      updated: 0,
    })),
    retryTask: vi.fn(async () => undefined),
    setChannelEnabled: vi.fn(async (telegramChatId, enabled) => ({
      disabledAt: enabled ? null : '2026-07-24T12:00:00.000Z',
      enabled,
      telegramChatId: telegramChatId.toString(),
      title: 'Koharu Test Channel',
      username: 'koharu_test',
    })),
    skipTask: vi.fn(async () => undefined),
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
    await expect(listResponse.json()).resolves.toEqual({ items: [message], nextCursor: null });

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

  it('passes a bounded limit and decoded channel-bound cursor to the reader', async () => {
    const nextCursor = {
      channelId: CHANNEL_ID,
      messageId: NEXT_MESSAGE_ID,
      publishedAt: '2025-06-30T16:13:19.000Z',
    };
    const cursor = encodeMessageCursor({
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      publishedAt: message.publishedAt,
    });
    const listMessages = vi.fn(async () => ({
      items: [message],
      nextCursor,
    }));
    const reader: MessageReader = {
      ...createReader(),
      listMessages,
    };

    const response = await createApp({ messages: reader }).request(
      `/api/v1/messages?channel=${CHANNEL_ID}&limit=25&cursor=${cursor}`,
    );

    expect(response.status).toBe(200);
    expect(listMessages).toHaveBeenCalledWith(CHANNEL_ID, {
      cursor: {
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        publishedAt: message.publishedAt,
      },
      limit: 25,
    });
    await expect(response.json()).resolves.toEqual({
      items: [message],
      nextCursor: encodeMessageCursor(nextCursor),
    });
  });

  it.each([
    [`/api/v1/messages?channel=${CHANNEL_ID}&limit=0`, 'invalid_limit'],
    [`/api/v1/messages?channel=${CHANNEL_ID}&limit=101`, 'invalid_limit'],
    [`/api/v1/messages?channel=${CHANNEL_ID}&cursor=not-base64url!`, 'invalid_cursor'],
    [
      `/api/v1/messages?channel=${CHANNEL_ID}&cursor=${encodeMessageCursor({
        channelId: OTHER_CHANNEL_ID,
        messageId: MESSAGE_ID,
        publishedAt: message.publishedAt,
      })}`,
      'invalid_cursor',
    ],
  ])('rejects invalid pagination at %s', async (path, code) => {
    const response = await createApp({ messages: createReader() }).request(path);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });
});

describe('public HTTP policy', () => {
  it('emits CORS headers only for an exact configured origin', async () => {
    const app = createApp({
      publicApi: {
        corsOrigins: new Set(['https://blog.example.com']),
        rateLimitMax: 10,
        rateLimitWindowMs: 60_000,
        trustProxy: false,
      },
      publicClientAddress: () => '203.0.113.10',
    });

    const allowed = await app.request('/api/v1/health', {
      headers: { Origin: 'https://blog.example.com' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://blog.example.com');
    expect(allowed.headers.get('vary')).toBe('Origin');

    const lookalike = await app.request('/api/v1/health', {
      headers: { Origin: 'https://blog.example.com.evil.test' },
    });
    expect(lookalike.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rate limits each injected client address and leaves /healthz unmetered', async () => {
    const clientAddress = vi.fn(() => '203.0.113.11');
    const app = createApp({
      publicApi: {
        corsOrigins: new Set(),
        rateLimitMax: 1,
        rateLimitWindowMs: 60_000,
        trustProxy: false,
      },
      publicClientAddress: clientAddress,
    });

    const first = await app.request('/api/v1/health');
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-limit')).toBe('1');
    expect(first.headers.get('ratelimit-remaining')).toBe('0');

    const limited = await app.request('/api/v1/channels');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: 'rate_limited' },
    });

    const liveness = await app.request('/healthz');
    expect(liveness.status).toBe(200);
    expect(liveness.headers.get('ratelimit-limit')).toBeNull();
    expect(clientAddress).toHaveBeenCalledTimes(2);
  });
});

describe('owner admin endpoints', () => {
  const ownerAuth: RuntimeAuth = {
    authorize: async () => ({
      allowed: true,
      principal: ownerPrincipal,
    }),
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
    expect(anonymous.headers.get('vary')).toBe('Cookie, Authorization');

    const forbidden = await createApp({
      auth: {
        ...ownerAuth,
        authorize: async () => ({
          allowed: false,
          principal: {
            actorId: 'service-token-id',
            actorType: 'service_token',
            email: null,
            permissions: { 'admin:read': [] },
            twoFactorEnabled: null,
          },
        }),
      },
    }).request('/api/v1/admin/status');
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({
      error: { code: 'insufficient_scope' },
    });
  });

  it('serves owner status and reveals raw only through the explicit no-store endpoint', async () => {
    const rawUpdate = channelPostFixture();
    const app = createApp({
      admin: {
        getRawUpdate: async (messageId) => (messageId === MESSAGE_ID ? rawUpdate : null),
        getStatus: async () => ({
          counts: {
            activeChannels: 1,
            blockedTasks: 0,
            configuredChannels: 2,
            messages: 2,
            pendingTasks: 4,
            retryingTasks: 1,
            skippedTasks: 0,
            staleRendererRevisions: 0,
            updates: 3,
          },
          lastCheckpoint: '2026-07-24T12:00:00.000Z',
        }),
      },
      auth: ownerAuth,
      collectorState: () => 'running',
      owners: { isOwner: async () => true },
    });

    const status = await app.request('/api/v1/admin/status');
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      collector: 'running',
      counts: {
        activeChannels: 1,
        blockedTasks: 0,
        configuredChannels: 2,
        messages: 2,
        pendingTasks: 4,
        retryingTasks: 1,
        skippedTasks: 0,
        staleRendererRevisions: 0,
        updates: 3,
      },
      lastCheckpoint: '2026-07-24T12:00:00.000Z',
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
    expect(revealed.headers.get('vary')).toBe('Cookie, Authorization');
    await expect(revealed.json()).resolves.toEqual({ update: rawUpdate });
  });

  it('requests admin:read for a service-token status request and never makes it cacheable', async () => {
    const authorize = vi.fn(async (_headers: Headers) => ({
      allowed: true,
      principal: serviceTokenPrincipal,
    }));
    const response = await createApp({
      auth: createAuthorizedAuth(serviceTokenPrincipal, authorize),
    }).request('/api/v1/admin/status', {
      headers: { Authorization: 'Bearer khs_test' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(authorize).toHaveBeenCalledWith(expect.any(Headers), 'admin:read');
    const [headers] = authorize.mock.calls[0] ?? [];
    expect(headers?.get('Authorization')).toBe('Bearer khs_test');
  });

  it.each([
    ['retry', 'retryTask'],
    ['skip', 'skipTask'],
  ] as const)('requires and normalizes a reason for task %s', async (action, method) => {
    const operations = createOperations();
    const authorizationScopes: string[] = [];
    const app = createApp({
      auth: createAuthorizedAuth(serviceTokenPrincipal, async (_headers, scope) => {
        authorizationScopes.push(scope);
        return { allowed: true, principal: serviceTokenPrincipal };
      }),
      operations,
    });
    const path = `/api/v1/admin/tasks/${TASK_ID}/${action}`;

    const missingReason = await app.request(path, {
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(missingReason.status).toBe(400);
    expect(operations[method]).not.toHaveBeenCalled();

    const accepted = await app.request(path, {
      body: JSON.stringify({ reason: '  operator approved  ' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('private, no-store');
    expect(operations[method]).toHaveBeenCalledWith(
      TASK_ID,
      'operator approved',
      serviceTokenPrincipal,
    );
    expect(authorizationScopes).toEqual(['ingestion:write', 'ingestion:write']);
    await expect(accepted.json()).resolves.toEqual({ success: true });
  });

  it('validates and dispatches explicit channel enable/disable actions', async () => {
    const operations = createOperations();
    const authorizationScopes: string[] = [];
    const app = createApp({
      auth: createAuthorizedAuth(serviceTokenPrincipal, async (_headers, scope) => {
        authorizationScopes.push(scope);
        return { allowed: true, principal: serviceTokenPrincipal };
      }),
      operations,
    });

    const invalidAction = await app.request('/api/v1/admin/channels/-1002234260754/delete', {
      method: 'POST',
    });
    expect(invalidAction.status).toBe(400);
    await expect(invalidAction.json()).resolves.toMatchObject({
      error: { code: 'invalid_channel_action' },
    });

    const disabled = await app.request('/api/v1/admin/channels/-1002234260754/disable', {
      method: 'POST',
    });
    expect(disabled.status).toBe(200);
    expect(operations.setChannelEnabled).toHaveBeenCalledWith(
      -1_002_234_260_754n,
      false,
      serviceTokenPrincipal,
    );
    expect(authorizationScopes).toEqual(['ingestion:write', 'ingestion:write']);
    await expect(disabled.json()).resolves.toMatchObject({
      enabled: false,
      telegramChatId: '-1002234260754',
    });
  });

  it('uses content:write and returns the bounded rerender result', async () => {
    const authorize = vi.fn(async () => ({
      allowed: true,
      principal: serviceTokenPrincipal,
    }));
    const operations = createOperations();
    vi.mocked(operations.rerenderOutdated).mockResolvedValue({
      currentVersion: 3,
      hasMore: true,
      updated: 500,
    });
    const response = await createApp({
      auth: createAuthorizedAuth(serviceTokenPrincipal, authorize),
      operations,
    }).request('/api/v1/admin/rerender', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(authorize).toHaveBeenCalledWith(expect.any(Headers), 'content:write');
    expect(operations.rerenderOutdated).toHaveBeenCalledWith(serviceTokenPrincipal);
    await expect(response.json()).resolves.toEqual({
      currentVersion: 3,
      hasMore: true,
      updated: 500,
    });
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
