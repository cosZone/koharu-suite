import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  mediaCacheActions,
  mediaCacheBlobs,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  messageMedia,
  messageRevisions,
  messages,
  telegramChannels,
} from '../../src/db/schema.js';
import { LocalMediaBlobStore } from '../../src/media-cache/blob-store.js';
import { MediaCacheMaintenanceService } from '../../src/media-cache/maintenance-service.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';

let container: StartedPostgreSqlContainer | undefined;
let connection: DatabaseConnection | undefined;
let root: string | undefined;
let store: LocalMediaBlobStore | undefined;
let fixtureSequence = 0;

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function key(sha256: string): string {
  return `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

async function insertReadyFixture(
  databaseConnection: DatabaseConnection,
  input: {
    bytes: Uint8Array;
    lastAccessedAt: Date;
    mode: 'corrupt' | 'missing' | 'present' | 'wrong_size';
  },
) {
  fixtureSequence += 1;
  const sha256 = hash(input.bytes);
  const relativeKey = key(sha256);
  if (!root) throw new Error('Blob root was not initialized');
  if (input.mode !== 'missing') {
    const path = join(root, relativeKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      input.mode === 'corrupt'
        ? Uint8Array.from(input.bytes, (value) => value ^ 0xff)
        : input.mode === 'wrong_size'
          ? input.bytes.slice(0, Math.max(1, input.bytes.byteLength - 1))
          : input.bytes,
      { mode: 0o600 },
    );
  }

  const [channel] = await databaseConnection.db
    .insert(telegramChannels)
    .values({
      telegramChatId: -1_008_000_000_000n - BigInt(fixtureSequence),
      title: `Maintenance ${fixtureSequence}`,
    })
    .returning({ id: telegramChannels.id });
  if (!channel) throw new Error('Fixture channel was not created');
  const [message] = await databaseConnection.db
    .insert(messages)
    .values({
      channelId: channel.id,
      publishedAt: input.lastAccessedAt,
      telegramMessageId: BigInt(fixtureSequence),
    })
    .returning({ id: messages.id });
  if (!message) throw new Error('Fixture message was not created');
  const [revision] = await databaseConnection.db
    .insert(messageRevisions)
    .values({
      contentKind: 'none',
      entities: [],
      messageId: message.id,
      revisionNumber: 1,
    })
    .returning({ id: messageRevisions.id });
  if (!revision) throw new Error('Fixture revision was not created');
  const [media] = await databaseConnection.db
    .insert(messageMedia)
    .values({
      kind: 'photo',
      position: 0,
      revisionId: revision.id,
      sourceKind: 'telegram_bot_update',
      telegramFileId: `maintenance-file-${fixtureSequence}`,
      telegramFileUniqueId: `maintenance-unique-${fixtureSequence}`,
    })
    .returning({ id: messageMedia.id });
  if (!media) throw new Error('Fixture media was not created');
  const byteLength = BigInt(input.bytes.byteLength);
  const [plan] = await databaseConnection.db
    .insert(mediaCachePostPlans)
    .values({
      messageId: message.id,
      readyOriginalBytes: byteLength,
      revisionId: revision.id,
      state: 'ready',
    })
    .returning({ id: mediaCachePostPlans.id });
  if (!plan) throw new Error('Fixture plan was not created');
  await databaseConnection.db.insert(mediaCacheBlobs).values({
    byteLength,
    detectedMime: 'image/jpeg',
    lastAccessedAt: input.lastAccessedAt,
    relativeKey,
    sha256,
    state: 'ready',
  });
  const [object] = await databaseConnection.db
    .insert(mediaCacheObjects)
    .values({
      actualBytes: byteLength,
      blobSha256: sha256,
      canonicalMediaId: media.id,
      postPlanId: plan.id,
      recipeVersion: 1,
      revisionId: revision.id,
      state: 'ready',
      variant: 'original',
    })
    .returning({ id: mediaCacheObjects.id });
  if (!object) throw new Error('Fixture object was not created');
  return { objectId: object.id, sha256 };
}

describe('PostgreSQL and filesystem media cache maintenance', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations(container.getConnectionUri());
    connection = createDatabaseConnection(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await container?.stop();
  }, 30_000);

  beforeEach(async () => {
    if (!connection) throw new Error('Database connection was not created');
    await connection.db.execute(sql`
      truncate table
        ${mediaCacheActions},
        ${mediaCacheObjects},
        ${mediaCacheBlobs},
        ${mediaCachePostPlans},
        ${mediaCacheRuntime},
        ${telegramChannels}
      cascade
    `);
    if (root) await rm(root, { force: true, recursive: true });
    root = await mkdtemp(join(tmpdir(), 'koharu-media-maintenance-'));
    store = new LocalMediaBlobStore(root);
    await store.initialize();
  });

  it('previews and applies a stable bounded LRU prune through the eviction service', async () => {
    if (!connection || !store) throw new Error('Maintenance fixture was not initialized');
    for (let index = 0; index < 3; index += 1) {
      await insertReadyFixture(connection, {
        bytes: Uint8Array.from({ length: 100 }, () => index + 1),
        lastAccessedAt: new Date(`2026-07-24T0${index + 1}:00:00.000Z`),
        mode: 'present',
      });
    }
    await connection.db.insert(mediaCacheRuntime).values({ readyBytes: 300n });
    const service = new MediaCacheMaintenanceService(connection.db, store, 'maintenance-test');
    const initiator = {
      id: 'local-cli',
      kind: 'local_operator' as const,
      reason: 'bounded prune test',
    };

    await expect(
      service.prune({ apply: false, initiator, targetBytes: 100n }),
    ).resolves.toMatchObject({
      applied: false,
      candidates: 2,
      hasMore: false,
      projectedReadyBytes: '100',
      readyBytes: '300',
      removedBytes: '200',
    });
    expect(
      await connection.db
        .select({ state: mediaCacheBlobs.state })
        .from(mediaCacheBlobs)
        .orderBy(asc(mediaCacheBlobs.lastAccessedAt)),
    ).toEqual([{ state: 'ready' }, { state: 'ready' }, { state: 'ready' }]);

    const localClock = vi.spyOn(Date, 'now').mockReturnValue(0);
    await expect(
      service.prune({ apply: true, initiator, targetBytes: 100n }),
    ).resolves.toMatchObject({
      applied: true,
      candidates: 2,
      hasMore: false,
      readyBytes: '100',
      removedBytes: '200',
    });
    localClock.mockRestore();
    expect(
      await connection.db
        .select({ state: mediaCacheBlobs.state })
        .from(mediaCacheBlobs)
        .orderBy(asc(mediaCacheBlobs.lastAccessedAt)),
    ).toEqual([{ state: 'evicted' }, { state: 'evicted' }, { state: 'ready' }]);
  });

  it('detects missing and checksum-mismatched blobs and repairs them without exposing identity', async () => {
    if (!connection || !store) throw new Error('Maintenance fixture was not initialized');
    await insertReadyFixture(connection, {
      bytes: Uint8Array.from({ length: 64 }, () => 1),
      lastAccessedAt: new Date('2026-07-24T01:00:00.000Z'),
      mode: 'present',
    });
    const missing = await insertReadyFixture(connection, {
      bytes: Uint8Array.from({ length: 64 }, () => 2),
      lastAccessedAt: new Date('2026-07-24T02:00:00.000Z'),
      mode: 'missing',
    });
    const corrupt = await insertReadyFixture(connection, {
      bytes: Uint8Array.from({ length: 64 }, () => 3),
      lastAccessedAt: new Date('2026-07-24T03:00:00.000Z'),
      mode: 'corrupt',
    });
    const wrongSize = await insertReadyFixture(connection, {
      bytes: Uint8Array.from({ length: 64 }, () => 4),
      lastAccessedAt: new Date('2026-07-24T04:00:00.000Z'),
      mode: 'wrong_size',
    });
    await connection.db.insert(mediaCacheRuntime).values({ readyBytes: 999n, reservedBytes: 7n });
    const service = new MediaCacheMaintenanceService(connection.db, store, 'maintenance-test');
    const initiator = {
      id: 'owner-user',
      kind: 'owner_session' as const,
      reason: 'verify restored volume',
    };

    const preview = await service.reconcile({ apply: false, initiator });
    expect(preview).toEqual({
      applied: false,
      checked: 4,
      checksumMismatch: 2,
      hasMore: false,
      ledger: {
        drift: true,
        expectedReadyBytes: '256',
        expectedReservedBytes: '0',
        readyBytes: '999',
        repaired: false,
        reservedBytes: '7',
      },
      missing: 1,
      nextCursor: null,
      orphans: { failed: 0, found: 0, recovered: 0 },
      repaired: 0,
      repairFailed: 0,
    });
    expect(JSON.stringify(preview)).not.toContain(missing.sha256);
    expect(JSON.stringify(preview)).not.toContain(corrupt.sha256);

    await expect(service.reconcile({ apply: true, initiator })).resolves.toMatchObject({
      applied: true,
      checked: 4,
      checksumMismatch: 2,
      missing: 1,
      repaired: 3,
      repairFailed: 0,
      ledger: {
        drift: true,
        expectedReadyBytes: '64',
        expectedReservedBytes: '0',
        readyBytes: '807',
        repaired: true,
        reservedBytes: '7',
      },
    });
    const repairedObjects = await connection.db
      .select({ id: mediaCacheObjects.id, state: mediaCacheObjects.state })
      .from(mediaCacheObjects)
      .where(
        inArray(mediaCacheObjects.id, [missing.objectId, corrupt.objectId, wrongSize.objectId]),
      );
    expect(repairedObjects).toEqual(
      expect.arrayContaining([
        { id: missing.objectId, state: 'evicted' },
        { id: corrupt.objectId, state: 'evicted' },
        { id: wrongSize.objectId, state: 'evicted' },
      ]),
    );
    const [runtime] = await connection.db
      .select({
        lastReconciledAt: mediaCacheRuntime.lastReconciledAt,
        readyBytes: mediaCacheRuntime.readyBytes,
      })
      .from(mediaCacheRuntime)
      .where(eq(mediaCacheRuntime.singletonKey, 'local'));
    expect(runtime?.readyBytes).toBe(64n);
    expect(runtime?.lastReconciledAt).toBeInstanceOf(Date);
  });

  it('continues after 100 blobs with an opaque object cursor and only marks a full pass complete', async () => {
    if (!connection || !store) throw new Error('Maintenance fixture was not initialized');
    for (let index = 0; index < 101; index += 1) {
      await insertReadyFixture(connection, {
        bytes: Uint8Array.of(index, index ^ 0xff, 1),
        lastAccessedAt: new Date('2026-07-24T01:00:00.000Z'),
        mode: 'present',
      });
    }
    await connection.db.insert(mediaCacheRuntime).values({ readyBytes: 303n });
    const service = new MediaCacheMaintenanceService(connection.db, store, 'maintenance-test');
    const initiator = {
      id: 'owner-user',
      kind: 'owner_session' as const,
      reason: 'bounded full-volume verification',
    };

    const first = await service.reconcile({ apply: true, initiator });
    expect(first).toMatchObject({
      checked: 100,
      hasMore: true,
      nextCursor: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      ),
    });
    expect(JSON.stringify(first)).not.toMatch(/[0-9a-f]{64}/u);
    const [partialRuntime] = await connection.db
      .select({ lastReconciledAt: mediaCacheRuntime.lastReconciledAt })
      .from(mediaCacheRuntime)
      .where(eq(mediaCacheRuntime.singletonKey, 'local'));
    expect(partialRuntime?.lastReconciledAt).toBeNull();

    const second = await service.reconcile({
      apply: true,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
      initiator,
    });
    expect(second).toMatchObject({
      checked: 1,
      hasMore: false,
      nextCursor: null,
    });
    const [completedRuntime] = await connection.db
      .select({ lastReconciledAt: mediaCacheRuntime.lastReconciledAt })
      .from(mediaCacheRuntime)
      .where(eq(mediaCacheRuntime.singletonKey, 'local'));
    expect(completedRuntime?.lastReconciledAt).toBeInstanceOf(Date);

    await expect(
      service.reconcile({ apply: false, cursor: randomUUID(), initiator }),
    ).rejects.toThrow('cursor is invalid');
  });

  it('cleans only stale temporary leases without active database provenance', async () => {
    if (!connection || !store || !root) throw new Error('Maintenance fixture was not initialized');
    const orphanLease = { leaseToken: randomUUID(), planId: randomUUID() };
    const orphanObjectId = randomUUID();
    await store.stage({
      lease: orphanLease,
      maxBytes: 64,
      objectId: orphanObjectId,
      source: new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.of(1, 2, 3));
          controller.close();
        },
      }),
    });

    const activeFixture = await insertReadyFixture(connection, {
      bytes: Uint8Array.of(4, 5, 6),
      lastAccessedAt: new Date('2026-07-24T01:00:00.000Z'),
      mode: 'present',
    });
    const [activeObject] = await connection.db
      .select({
        id: mediaCacheObjects.id,
        planId: mediaCacheObjects.postPlanId,
      })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.id, activeFixture.objectId));
    if (!activeObject) throw new Error('Active fixture object was not created');
    const activeLease = { leaseToken: randomUUID(), planId: activeObject.planId };
    await store.stage({
      lease: activeLease,
      maxBytes: 64,
      objectId: activeObject.id,
      source: new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.of(7, 8, 9));
          controller.close();
        },
      }),
    });
    await connection.db
      .update(mediaCachePostPlans)
      .set({
        leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
        leaseOwner: 'active-worker',
        leaseToken: activeLease.leaseToken,
        state: 'staging',
      })
      .where(eq(mediaCachePostPlans.id, activeLease.planId));
    const old = new Date('2000-01-01T00:00:00.000Z');
    await Promise.all([
      utimes(join(root, '.tmp', orphanLease.planId, orphanLease.leaseToken), old, old),
      utimes(join(root, '.tmp', activeLease.planId, activeLease.leaseToken), old, old),
    ]);
    const service = new MediaCacheMaintenanceService(connection.db, store, 'maintenance-test');
    const initiator = {
      id: 'owner-user',
      kind: 'owner_session' as const,
      reason: 'remove stale orphan staging',
    };

    await expect(service.reconcile({ apply: false, initiator })).resolves.toMatchObject({
      orphans: { failed: 0, found: 1, recovered: 0 },
    });
    await expect(service.reconcile({ apply: true, initiator })).resolves.toMatchObject({
      orphans: { failed: 0, found: 1, recovered: 1 },
    });
    await expect(store.recoverLease(orphanLease)).resolves.toEqual([]);
    await expect(store.recoverLease(activeLease)).resolves.toHaveLength(1);
    const recoverActions = await connection.db
      .select({ kind: mediaCacheActions.actionKind })
      .from(mediaCacheActions)
      .where(eq(mediaCacheActions.actionKind, 'recover_orphan'));
    expect(recoverActions).toHaveLength(1);
  });
});
