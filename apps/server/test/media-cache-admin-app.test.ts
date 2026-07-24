import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AdminPrincipal, RuntimeAuth } from '../src/auth/runtime-auth.js';
import type { MediaCacheAdminReader } from '../src/media-cache/admin-repository.js';
import {
  MediaCacheAdminConflictError,
  type MediaCacheAdminMutations,
  MediaCacheAdminNotFoundError,
} from '../src/media-cache/admin-service.js';

const OBJECT_ID = randomUUID();
const PLAN_ID = randomUUID();

const owner: AdminPrincipal = {
  actorId: 'owner-user-id',
  actorType: 'owner_session',
  email: 'owner@example.com',
  permissions: null,
  twoFactorEnabled: true,
};
const serviceToken: AdminPrincipal = {
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

function auth(principal: AdminPrincipal): RuntimeAuth {
  return {
    authorize: vi.fn(async () => ({ allowed: true, principal })),
    getSession: vi.fn(async () => null),
    handle: vi.fn(async () => new Response(null, { status: 204 })),
  };
}

function reader(): MediaCacheAdminReader {
  return {
    getStatus: vi.fn<MediaCacheAdminReader['getStatus']>(async () => ({
      commands: [],
      enabled: true,
      failures: [],
      stateCounts: {
        blobs: [{ count: 1, state: 'ready' }],
        objects: [{ count: 1, state: 'ready' }],
        plans: [{ count: 1, state: 'ready' }],
      },
      usage: {
        lastReconciledAt: null,
        maxBytes: '5368709120',
        readyBytes: '128',
        reservedBytes: '0',
        updatedAt: '2026-07-24T08:00:00.000Z',
      },
    })),
    listObjects: vi.fn<MediaCacheAdminReader['listObjects']>(async () => ({
      items: [
        {
          actualBytes: '128',
          canonicalMediaId: randomUUID(),
          declaredBytes: '128',
          id: OBJECT_ID,
          kind: 'photo',
          messageId: randomUUID(),
          planId: PLAN_ID,
          planState: 'ready',
          reasonCode: null,
          state: 'ready',
          updatedAt: '2026-07-24T08:00:00.000Z',
          variant: 'original',
        },
      ],
      nextCursor: null,
    })),
  };
}

function mutations(): MediaCacheAdminMutations {
  return {
    evict: vi.fn<MediaCacheAdminMutations['evict']>(async () => ({
      commandId: randomUUID(),
      operation: 'evict',
      state: 'pending',
    })),
    reconcile: vi.fn<MediaCacheAdminMutations['reconcile']>(async () => ({
      commandId: randomUUID(),
      operation: 'reconcile',
      state: 'pending',
    })),
    retry: vi.fn<MediaCacheAdminMutations['retry']>(async ({ objectId }) => ({
      objectIds: [objectId],
      planId: PLAN_ID,
      state: 'retry_wait',
      variant: 'original',
    })),
  };
}

describe('media cache Admin API', () => {
  it('reports a disabled cache and rejects mutations when no cache runtime is wired', async () => {
    const app = createApp({ auth: auth(owner) });

    const status = await app.request('/api/v1/admin/media-cache/status');
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ enabled: false });

    const retry = await app.request(`/api/v1/admin/media-cache/objects/${OBJECT_ID}/retry`, {
      body: JSON.stringify({ reason: 'retry disabled cache' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toMatchObject({
      error: { code: 'media_cache_conflict', message: 'Media cache is disabled' },
    });
  });

  it('returns sanitized status and bounded opaque object pages to admin readers', async () => {
    const mediaCacheAdmin = reader();
    const app = createApp({ auth: auth(serviceToken), mediaCacheAdmin });

    const status = await app.request('/api/v1/admin/media-cache/status');
    expect(status.status).toBe(200);
    expect(status.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(status.json()).resolves.toMatchObject({
      enabled: true,
      usage: { readyBytes: '128' },
    });

    const objects = await app.request('/api/v1/admin/media-cache/objects?limit=25');
    expect(objects.status).toBe(200);
    const body = await objects.json();
    expect(body.items[0]).toMatchObject({ id: OBJECT_ID, planId: PLAN_ID });
    expect(JSON.stringify(body)).not.toContain('blobs/');
    expect(JSON.stringify(body)).not.toContain('sha256');
    expect(mediaCacheAdmin.listObjects).toHaveBeenCalledWith({ limit: 25 });
  });

  it('rejects invalid object page input and maps repository cursor failures', async () => {
    const mediaCacheAdmin = reader();
    const app = createApp({ auth: auth(owner), mediaCacheAdmin });
    const invalidLimit = await app.request('/api/v1/admin/media-cache/objects?limit=101');
    expect(invalidLimit.status).toBe(400);
    expect(mediaCacheAdmin.listObjects).not.toHaveBeenCalled();

    vi.mocked(mediaCacheAdmin.listObjects).mockRejectedValueOnce(
      new RangeError('Media cache object cursor is invalid'),
    );
    const invalidCursor = await app.request('/api/v1/admin/media-cache/objects?cursor=invalid');
    expect(invalidCursor.status).toBe(400);
    await expect(invalidCursor.json()).resolves.toMatchObject({
      error: { code: 'invalid_media_cache_query' },
    });
  });

  it.each(['retry', 'evict'] as const)(
    'requires an owner session for %s even when a service token has every content scope',
    async (action) => {
      const mediaCacheMutations = mutations();
      const response = await createApp({
        auth: auth(serviceToken),
        mediaCacheMutations,
      }).request(`/api/v1/admin/media-cache/objects/${OBJECT_ID}/${action}`, {
        body: JSON.stringify({ reason: 'owner-approved cache repair' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(403);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'owner_session_required' },
      });
      expect(mediaCacheMutations[action]).not.toHaveBeenCalled();
    },
  );

  it('requires an owner session for global reconciliation', async () => {
    const mediaCacheMutations = mutations();
    const response = await createApp({
      auth: auth(serviceToken),
      mediaCacheMutations,
    }).request('/api/v1/admin/media-cache/reconcile', {
      body: JSON.stringify({ reason: 'verify disk and ledger' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mediaCacheMutations.reconcile).not.toHaveBeenCalled();
  });

  it('passes only the opaque object id, owner id, and bounded reason to mutations', async () => {
    const mediaCacheMutations = mutations();
    const app = createApp({ auth: auth(owner), mediaCacheMutations });

    for (const action of ['retry', 'evict'] as const) {
      const response = await app.request(
        `/api/v1/admin/media-cache/objects/${OBJECT_ID}/${action}`,
        {
          body: JSON.stringify({ reason: '  owner-approved cache repair  ' }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      expect(response.status).toBe(action === 'evict' ? 202 : 200);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(mediaCacheMutations[action]).toHaveBeenCalledWith({
        initiatorId: owner.actorId,
        objectId: OBJECT_ID,
        reason: 'owner-approved cache repair',
      });
    }
  });

  it('queues one worker-owned reconcile command and rejects server-side pagination input', async () => {
    const mediaCacheMutations = mutations();
    const app = createApp({ auth: auth(owner), mediaCacheMutations });

    const response = await app.request('/api/v1/admin/media-cache/reconcile', {
      body: JSON.stringify({ reason: 'run complete bounded cache verification' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(202);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      operation: 'reconcile',
      state: 'pending',
    });
    expect(mediaCacheMutations.reconcile).toHaveBeenCalledWith({
      initiatorId: owner.actorId,
      reason: 'run complete bounded cache verification',
    });

    const invalid = await app.request('/api/v1/admin/media-cache/reconcile', {
      body: JSON.stringify({ cursor: randomUUID(), reason: 'cursor belongs to worker' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(invalid.status).toBe(400);
    expect(mediaCacheMutations.reconcile).toHaveBeenCalledTimes(1);
  });

  it('returns sanitized mutation errors', async () => {
    const mediaCacheMutations = mutations();
    const app = createApp({ auth: auth(owner), mediaCacheMutations });

    vi.mocked(mediaCacheMutations.retry).mockRejectedValueOnce(new MediaCacheAdminNotFoundError());
    const missing = await app.request(`/api/v1/admin/media-cache/objects/${OBJECT_ID}/retry`, {
      body: JSON.stringify({ reason: 'retry missing object' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(missing.status).toBe(404);

    vi.mocked(mediaCacheMutations.evict).mockRejectedValueOnce(
      new MediaCacheAdminConflictError('Media cache object is not ready for eviction'),
    );
    const conflict = await app.request(`/api/v1/admin/media-cache/objects/${OBJECT_ID}/evict`, {
      body: JSON.stringify({ reason: 'evict object' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'media_cache_conflict' },
    });
  });
});
