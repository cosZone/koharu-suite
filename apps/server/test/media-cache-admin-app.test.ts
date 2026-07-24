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
    migrate: vi.fn<MediaCacheAdminMutations['migrate']>(async () => ({
      commandId: randomUUID(),
      operation: 'migrate',
      state: 'pending',
    })),
    previewPrune: vi.fn<MediaCacheAdminMutations['previewPrune']>(
      async ({ targetBackendId, targetBytes }) => ({
        candidates: 1,
        hasMore: false,
        projectedReadyBytes: targetBytes.toString(),
        readyBytes: '256',
        removableBytes: '128',
        targetBackendId,
        targetBytes: targetBytes.toString(),
      }),
    ),
    protect: vi.fn<MediaCacheAdminMutations['protect']>(async ({ expiresAt, objectId }) => ({
      alreadyApplied: false,
      expiresAt: expiresAt ?? null,
      objectId,
      protected: true,
      protectedAt: new Date('2026-07-24T08:00:00.000Z'),
    })),
    prune: vi.fn<MediaCacheAdminMutations['prune']>(async () => ({
      commandId: randomUUID(),
      operation: 'prune',
      state: 'pending',
    })),
    reconcile: vi.fn<MediaCacheAdminMutations['reconcile']>(async () => ({
      commandId: randomUUID(),
      operation: 'reconcile',
      state: 'pending',
    })),
    restore: vi.fn<MediaCacheAdminMutations['restore']>(async () => ({
      commandId: randomUUID(),
      operation: 'restore',
      state: 'pending',
    })),
    retry: vi.fn<MediaCacheAdminMutations['retry']>(async ({ objectId }) => ({
      objectIds: [objectId],
      planId: PLAN_ID,
      state: 'retry_wait',
      variant: 'original',
    })),
    setEvictedPolicy: vi.fn<MediaCacheAdminMutations['setEvictedPolicy']>(
      async ({ objectId, policy }) => ({
        alreadyApplied: false,
        objectId,
        policy,
      }),
    ),
    unprotect: vi.fn<MediaCacheAdminMutations['unprotect']>(async ({ objectId }) => ({
      alreadyApplied: false,
      expiresAt: null,
      objectId,
      protected: false,
      protectedAt: null,
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

  it('applies object protection and eviction policy synchronously for owner sessions', async () => {
    const mediaCacheMutations = mutations();
    const app = createApp({ auth: auth(owner), mediaCacheMutations });
    const expiresAt = '2027-07-24T08:00:00.000Z';

    const protect = await app.request(`/api/v1/admin/media-cache/objects/${OBJECT_ID}/protect`, {
      body: JSON.stringify({ expiresAt, reason: '  protect shared blob  ' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(protect.status).toBe(200);
    expect(mediaCacheMutations.protect).toHaveBeenCalledWith({
      expiresAt: new Date(expiresAt),
      initiatorId: owner.actorId,
      objectId: OBJECT_ID,
      reason: 'protect shared blob',
    });

    const policy = await app.request(`/api/v1/admin/media-cache/objects/${OBJECT_ID}/policy`, {
      body: JSON.stringify({ policy: 'stay_evicted', reason: 'keep it cold' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(policy.status).toBe(200);
    expect(mediaCacheMutations.setEvictedPolicy).toHaveBeenCalledWith({
      initiatorId: owner.actorId,
      objectId: OBJECT_ID,
      policy: 'stay_evicted',
      reason: 'keep it cold',
    });

    const unprotect = await app.request(
      `/api/v1/admin/media-cache/objects/${OBJECT_ID}/unprotect`,
      {
        body: JSON.stringify({ reason: 'allow pruning' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    expect(unprotect.status).toBe(200);
    expect(mediaCacheMutations.unprotect).toHaveBeenCalledWith({
      initiatorId: owner.actorId,
      objectId: OBJECT_ID,
      reason: 'allow pruning',
    });
  });

  it('queues copy, restore, and prune commands with owner-owned validated targets', async () => {
    const mediaCacheMutations = mutations();
    const app = createApp({ auth: auth(owner), mediaCacheMutations });

    const migrate = await app.request('/api/v1/admin/media-cache/migrate', {
      body: JSON.stringify({
        objectId: OBJECT_ID,
        reason: 'copy object to durable tier',
        sourceBackendId: 'local',
        targetBackendId: 's3-default',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(migrate.status).toBe(202);
    expect(mediaCacheMutations.migrate).toHaveBeenCalledWith({
      initiatorId: owner.actorId,
      objectId: OBJECT_ID,
      reason: 'copy object to durable tier',
      sourceBackendId: 'local',
      targetBackendId: 's3-default',
    });

    const restore = await app.request(`/api/v1/admin/media-cache/objects/${OBJECT_ID}/restore`, {
      body: JSON.stringify({ reason: 'restore hot copy', targetBackendId: 'local' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(restore.status).toBe(202);
    expect(mediaCacheMutations.restore).toHaveBeenCalledWith({
      initiatorId: owner.actorId,
      objectId: OBJECT_ID,
      reason: 'restore hot copy',
      targetBackendId: 'local',
    });

    const prune = await app.request('/api/v1/admin/media-cache/prune', {
      body: JSON.stringify({
        reason: 'bound durable storage',
        targetBackendId: 's3-default',
        targetBytes: '5368709120',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(prune.status).toBe(202);
    expect(mediaCacheMutations.prune).toHaveBeenCalledWith({
      initiatorId: owner.actorId,
      reason: 'bound durable storage',
      targetBackendId: 's3-default',
      targetBytes: 5_368_709_120n,
    });
  });

  it('allows read-scoped service tokens to preview prune without granting mutations', async () => {
    const mediaCacheMutations = mutations();
    const app = createApp({ auth: auth(serviceToken), mediaCacheMutations });

    const preview = await app.request('/api/v1/admin/media-cache/prune/preview', {
      body: JSON.stringify({ targetBackendId: 's3-default', targetBytes: '128' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      projectedReadyBytes: '128',
      targetBackendId: 's3-default',
      targetBytes: '128',
    });
    expect(mediaCacheMutations.previewPrune).toHaveBeenCalledWith({
      targetBackendId: 's3-default',
      targetBytes: 128n,
    });

    for (const [path, body] of [
      [
        `/api/v1/admin/media-cache/objects/${OBJECT_ID}/protect`,
        { reason: 'service cannot protect' },
      ],
      [
        '/api/v1/admin/media-cache/migrate',
        {
          reason: 'service cannot copy',
          sourceBackendId: 'local',
          targetBackendId: 's3-default',
        },
      ],
      [
        '/api/v1/admin/media-cache/prune',
        { reason: 'service cannot prune', targetBackendId: 'local', targetBytes: '0' },
      ],
    ] as const) {
      const response = await app.request(path, {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'owner_session_required' },
      });
    }
    expect(mediaCacheMutations.protect).not.toHaveBeenCalled();
    expect(mediaCacheMutations.migrate).not.toHaveBeenCalled();
    expect(mediaCacheMutations.prune).not.toHaveBeenCalled();
  });

  it('rejects non-canonical storage mutation bodies before calling the service', async () => {
    const mediaCacheMutations = mutations();
    const app = createApp({ auth: auth(owner), mediaCacheMutations });
    const invalidRequests = [
      {
        body: { reason: 'same backend', sourceBackendId: 'local', targetBackendId: 'local' },
        path: '/api/v1/admin/media-cache/migrate',
      },
      {
        body: { extra: true, reason: 'extra field' },
        path: `/api/v1/admin/media-cache/objects/${OBJECT_ID}/protect`,
      },
      {
        body: { reason: 'bad target', targetBackendId: 'local', targetBytes: '01' },
        path: '/api/v1/admin/media-cache/prune',
      },
      {
        body: { reason: 'not decimal', targetBackendId: 'local', targetBytes: '5e9' },
        path: '/api/v1/admin/media-cache/prune',
      },
      {
        body: { reason: 'zero is not a target', targetBackendId: 'local', targetBytes: '0' },
        path: '/api/v1/admin/media-cache/prune',
      },
      {
        body: { targetBackendId: 'local', targetBytes: '0' },
        path: '/api/v1/admin/media-cache/prune/preview',
      },
      {
        body: {
          targetBackendId: 's3-default',
          targetBytes: (5n * 1024n * 1024n * 1024n * 1024n + 1n).toString(),
        },
        path: '/api/v1/admin/media-cache/prune/preview',
      },
    ];
    for (const request of invalidRequests) {
      const response = await app.request(request.path, {
        body: JSON.stringify(request.body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'invalid_media_cache_action' },
      });
    }
    expect(mediaCacheMutations.migrate).not.toHaveBeenCalled();
    expect(mediaCacheMutations.protect).not.toHaveBeenCalled();
    expect(mediaCacheMutations.prune).not.toHaveBeenCalled();
    expect(mediaCacheMutations.previewPrune).not.toHaveBeenCalled();
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
