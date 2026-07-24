import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  mediaCacheActions,
  mediaCacheBlobs,
  mediaCacheCommands,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  messageMedia,
  messageRevisions,
  messages,
  telegramChannels,
} from '../../src/db/schema.js';
import { PostgresMediaCacheAdminService } from '../../src/media-cache/admin-service.js';
import {
  MediaCacheCommandProcessor,
  PostgresMediaCacheCommandQueue,
} from '../../src/media-cache/command-queue.js';
import { MediaCacheEvictionService } from '../../src/media-cache/eviction-repository.js';
import { PostgresMediaCacheLedgerRepository } from '../../src/media-cache/ledger-repository.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const SHA256 = 'a'.repeat(64);
const SECOND_SHA256 = 'b'.repeat(64);
let container: StartedPostgreSqlContainer | undefined;
let connection: DatabaseConnection | undefined;
let fixtureIndex = 0;

async function createFixture(input: {
  objectCount?: number;
  planState?: 'blocked' | 'ready';
  state?: 'blocked' | 'ready';
  variant?: 'original' | 'thumbnail';
}) {
  if (!connection) throw new Error('Database connection was not created');
  fixtureIndex += 1;
  const [channel] = await connection.db
    .insert(telegramChannels)
    .values({
      telegramChatId: -1_008_000_000_000n - BigInt(fixtureIndex),
      title: `Admin service ${fixtureIndex}`,
    })
    .returning({ id: telegramChannels.id });
  if (!channel) throw new Error('Fixture channel was not created');
  const [message] = await connection.db
    .insert(messages)
    .values({
      channelId: channel.id,
      publishedAt: new Date('2026-07-24T08:00:00.000Z'),
      telegramMessageId: BigInt(fixtureIndex),
    })
    .returning({ id: messages.id });
  if (!message) throw new Error('Fixture message was not created');
  const [revision] = await connection.db
    .insert(messageRevisions)
    .values({
      contentKind: 'none',
      entities: [],
      messageId: message.id,
      revisionNumber: 1,
    })
    .returning({ id: messageRevisions.id });
  if (!revision) throw new Error('Fixture revision was not created');
  const objectCount = input.objectCount ?? 1;
  const media = [];
  for (let position = 0; position < objectCount; position += 1) {
    const [item] = await connection.db
      .insert(messageMedia)
      .values({
        kind: 'photo',
        position,
        revisionId: revision.id,
        sourceKind: 'telegram_bot_update',
        telegramFileId: `private-file-${fixtureIndex}-${position}`,
        telegramFileUniqueId: `private-unique-${fixtureIndex}-${position}`,
      })
      .returning({ id: messageMedia.id });
    if (!item) throw new Error('Fixture media was not created');
    media.push(item);
  }
  const state = input.state ?? 'blocked';
  if (state === 'ready') {
    await connection.db
      .insert(mediaCacheBlobs)
      .values({
        byteLength: 128n,
        detectedMime: 'image/jpeg',
        relativeKey: `blobs/${SHA256.slice(0, 2)}/${SHA256.slice(2, 4)}/${SHA256}`,
        sha256: SHA256,
        state: 'ready',
      })
      .onConflictDoNothing();
  }
  const [plan] = await connection.db
    .insert(mediaCachePostPlans)
    .values({
      messageId: message.id,
      readyOriginalBytes:
        input.variant !== 'thumbnail' && state === 'ready' ? BigInt(128 * objectCount) : 0n,
      revisionId: revision.id,
      state: input.planState ?? (state === 'ready' ? 'ready' : 'blocked'),
    })
    .returning({ id: mediaCachePostPlans.id });
  if (!plan) throw new Error('Fixture plan was not created');
  const objects = await connection.db
    .insert(mediaCacheObjects)
    .values(
      media.map((item) => ({
        actualBytes: state === 'ready' ? 128n : null,
        attemptCount: state === 'blocked' ? 10 : 0,
        blobSha256: state === 'ready' ? SHA256 : null,
        canonicalMediaId: item.id,
        lastErrorClass: state === 'blocked' ? 'upstream' : null,
        lastErrorCode: state === 'blocked' ? 'download_failed' : null,
        postPlanId: plan.id,
        recipeVersion: 1,
        revisionId: revision.id,
        state,
        variant: input.variant ?? 'original',
      })),
    )
    .returning({ id: mediaCacheObjects.id });
  return {
    media,
    messageId: message.id,
    objectIds: objects.map(({ id }) => id),
    planId: plan.id,
    revisionId: revision.id,
  };
}

function service() {
  if (!connection) throw new Error('Database connection was not created');
  return new PostgresMediaCacheAdminService(connection.db);
}

describe('PostgreSQL media cache Admin service', () => {
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
        ${mediaCacheCommands},
        ${mediaCacheRuntime},
        ${mediaCacheObjects},
        ${mediaCacheBlobs},
        ${mediaCachePostPlans},
        ${telegramChannels}
      cascade
    `);
  });

  it('atomically resets the complete original post plan and audits the owner action', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const fixture = await createFixture({ objectCount: 2 });

    const result = await service().retry({
      initiatorId: 'owner-user-id',
      objectId: fixture.objectIds[0] ?? '',
      reason: 'retry the complete original set',
    });

    expect(result).toEqual({
      objectIds: [...fixture.objectIds].sort(),
      planId: fixture.planId,
      state: 'retry_wait',
      variant: 'original',
    });
    const [plan] = await connection.db
      .select()
      .from(mediaCachePostPlans)
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    expect(plan).toMatchObject({
      attemptCount: 0,
      lastErrorClass: null,
      lastErrorCode: null,
      state: 'retry_wait',
    });
    const objects = await connection.db
      .select()
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.postPlanId, fixture.planId));
    expect(objects).toHaveLength(2);
    expect(objects.every((object) => object.state === 'retry_wait')).toBe(true);
    expect(objects.every((object) => object.attemptCount === 0)).toBe(true);

    const [action] = await connection.db.select().from(mediaCacheActions);
    expect(action).toMatchObject({
      actionKind: 'retry',
      initiatorId: 'owner-user-id',
      initiatorKind: 'owner_session',
      objectId: fixture.objectIds[0],
      reason: 'retry the complete original set',
    });
    expect(JSON.stringify(action?.beforeState)).not.toContain('private-file');
  });

  it('resets only a terminal thumbnail and preserves its ready original plan', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const original = await createFixture({ planState: 'ready', state: 'ready' });
    const [thumbnail] = await connection.db
      .insert(mediaCacheObjects)
      .values({
        attemptCount: 10,
        canonicalMediaId: original.media[0]?.id ?? '',
        lastErrorClass: 'transform',
        lastErrorCode: 'thumbnail_failed',
        postPlanId: original.planId,
        recipeVersion: 1,
        revisionId: original.revisionId,
        state: 'blocked',
        variant: 'thumbnail',
      })
      .returning({ id: mediaCacheObjects.id });
    if (!thumbnail) throw new Error('Fixture thumbnail was not created');

    const result = await service().retry({
      initiatorId: 'owner-user-id',
      objectId: thumbnail.id,
      reason: 'retry thumbnail transform',
    });

    expect(result).toMatchObject({ objectIds: [thumbnail.id], variant: 'thumbnail' });
    const [readyOriginal] = await connection.db
      .select({ state: mediaCacheObjects.state })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.id, original.objectIds[0] ?? ''));
    expect(readyOriginal?.state).toBe('ready');
    const [plan] = await connection.db
      .select({ state: mediaCachePostPlans.state })
      .from(mediaCachePostPlans)
      .where(eq(mediaCachePostPlans.id, original.planId));
    expect(plan?.state).toBe('ready');
  });

  it('recaches one LRU-evicted original while preserving ready siblings', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const fixture = await createFixture({ objectCount: 2 });
    await connection.db.insert(mediaCacheBlobs).values([
      {
        byteLength: 128n,
        detectedMime: 'image/jpeg',
        relativeKey: `blobs/${SHA256.slice(0, 2)}/${SHA256.slice(2, 4)}/${SHA256}`,
        sha256: SHA256,
        state: 'ready',
      },
      {
        byteLength: 128n,
        detectedMime: 'image/jpeg',
        relativeKey: `blobs/${SECOND_SHA256.slice(0, 2)}/${SECOND_SHA256.slice(2, 4)}/${SECOND_SHA256}`,
        sha256: SECOND_SHA256,
        state: 'ready',
      },
    ]);
    await connection.db
      .update(mediaCacheObjects)
      .set({ actualBytes: 128n, blobSha256: SHA256, state: 'ready' })
      .where(eq(mediaCacheObjects.id, fixture.objectIds[0] ?? ''));
    await connection.db
      .update(mediaCacheObjects)
      .set({ actualBytes: 128n, blobSha256: SECOND_SHA256, state: 'ready' })
      .where(eq(mediaCacheObjects.id, fixture.objectIds[1] ?? ''));
    await connection.db
      .update(mediaCachePostPlans)
      .set({ readyOriginalBytes: 256n, state: 'ready' })
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    await connection.db.insert(mediaCacheRuntime).values({
      maxBytes: 5n * 1024n * 1024n * 1024n,
      readyBytes: 256n,
      singletonKey: 'local',
    });
    const eviction = new MediaCacheEvictionService(connection.db, {
      evict: async () => 'removed' as const,
    });
    await eviction.evict({
      evictionExpiresAt: new Date(Date.now() + 60_000),
      evictionOwner: 'worker:test',
      evictionToken: randomUUID(),
      initiator: { kind: 'worker' },
      selection: { kind: 'specific_blob', sha256: SHA256 },
    });

    await expect(
      service().retry({
        initiatorId: 'owner-user-id',
        objectId: fixture.objectIds[0] ?? '',
        reason: 'restore one evicted original',
      }),
    ).resolves.toMatchObject({ objectIds: [fixture.objectIds[0]], state: 'retry_wait' });

    const ledger = new PostgresMediaCacheLedgerRepository(connection.db);
    const leaseToken = randomUUID();
    await expect(
      ledger.claimPostPlan({
        leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseOwner: 'worker:test',
        leaseToken,
        planId: fixture.planId,
      }),
    ).resolves.toMatchObject({ objectIds: [fixture.objectIds[0]], requestedBytes: 128n });
    await ledger.recordPublishedObjects({
      leaseToken,
      objects: [
        {
          byteLength: 128n,
          detectedMime: 'image/jpeg',
          objectId: fixture.objectIds[0] ?? '',
          relativeKey: `blobs/${SHA256.slice(0, 2)}/${SHA256.slice(2, 4)}/${SHA256}`,
          sha256: SHA256,
        },
      ],
      planId: fixture.planId,
      publish: async () => undefined,
    });
    await ledger.completeSettlement({ leaseToken, planId: fixture.planId });

    const originals = await connection.db
      .select({ state: mediaCacheObjects.state })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.postPlanId, fixture.planId));
    expect(originals.every(({ state }) => state === 'ready')).toBe(true);
    const [plan] = await connection.db
      .select({
        readyOriginalBytes: mediaCachePostPlans.readyOriginalBytes,
        state: mediaCachePostPlans.state,
      })
      .from(mediaCachePostPlans)
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    expect(plan).toEqual({ readyOriginalBytes: 256n, state: 'ready' });
  });

  it('restores every current shared-blob reference when one owner retry republishes it', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const first = await createFixture({ planState: 'ready', state: 'ready' });
    const second = await createFixture({ planState: 'ready', state: 'ready' });
    await connection.db.insert(mediaCacheRuntime).values({
      maxBytes: 5n * 1024n * 1024n * 1024n,
      readyBytes: 128n,
      singletonKey: 'local',
    });
    const eviction = new MediaCacheEvictionService(connection.db, {
      evict: async () => 'removed' as const,
    });
    await eviction.evict({
      evictionExpiresAt: new Date(Date.now() + 60_000),
      evictionOwner: 'worker:test',
      evictionToken: randomUUID(),
      initiator: { kind: 'worker' },
      selection: { kind: 'specific_blob', sha256: SHA256 },
    });
    await service().retry({
      initiatorId: 'owner-user-id',
      objectId: first.objectIds[0] ?? '',
      reason: 'restore one shared blob',
    });

    const ledger = new PostgresMediaCacheLedgerRepository(connection.db);
    const leaseToken = randomUUID();
    await ledger.claimPostPlan({
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseOwner: 'worker:test',
      leaseToken,
      planId: first.planId,
    });
    await ledger.recordPublishedObjects({
      leaseToken,
      objects: [
        {
          byteLength: 128n,
          detectedMime: 'image/jpeg',
          objectId: first.objectIds[0] ?? '',
          relativeKey: `blobs/${SHA256.slice(0, 2)}/${SHA256.slice(2, 4)}/${SHA256}`,
          sha256: SHA256,
        },
      ],
      planId: first.planId,
      publish: async () => undefined,
    });
    const [restoredSecondObject] = await connection.db
      .select({ state: mediaCacheObjects.state })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.id, second.objectIds[0] ?? ''));
    const [restoredSecondPlan] = await connection.db
      .select({
        readyOriginalBytes: mediaCachePostPlans.readyOriginalBytes,
        state: mediaCachePostPlans.state,
      })
      .from(mediaCachePostPlans)
      .where(eq(mediaCachePostPlans.id, second.planId));
    expect(restoredSecondObject).toEqual({ state: 'ready' });
    expect(restoredSecondPlan).toEqual({ readyOriginalBytes: 128n, state: 'ready' });

    await ledger.completeSettlement({ leaseToken, planId: first.planId });
    const plans = await connection.db
      .select({
        readyOriginalBytes: mediaCachePostPlans.readyOriginalBytes,
        state: mediaCachePostPlans.state,
      })
      .from(mediaCachePostPlans);
    expect(plans).toHaveLength(2);
    expect(plans.every((plan) => plan.state === 'ready' && plan.readyOriginalBytes === 128n)).toBe(
      true,
    );
    const [runtime] = await connection.db.select().from(mediaCacheRuntime);
    expect(runtime).toMatchObject({ readyBytes: 128n, reservedBytes: 0n });
  });

  it('resolves an opaque ready object internally and enqueues a sanitized worker command', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const fixture = await createFixture({ planState: 'ready', state: 'ready' });

    const result = await service().evict({
      initiatorId: 'owner-user-id',
      objectId: fixture.objectIds[0] ?? '',
      reason: 'free local cache space',
    });

    expect(result).toMatchObject({
      operation: 'evict',
      state: 'pending',
    });
    const [command] = await connection.db
      .select()
      .from(mediaCacheCommands)
      .where(eq(mediaCacheCommands.id, result.commandId));
    expect(command).toMatchObject({
      initiatorId: 'owner-user-id',
      objectId: fixture.objectIds[0],
      operation: 'evict',
      reason: 'free local cache space',
      state: 'pending',
    });
    expect(JSON.stringify(result)).not.toContain(SHA256);
  });

  it('executes an eviction command once and never exposes its blob identity in the result', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const fixture = await createFixture({ planState: 'ready', state: 'ready' });
    const receipt = await service().evict({
      initiatorId: 'owner-user-id',
      objectId: fixture.objectIds[0] ?? '',
      reason: 'execute through worker queue',
    });
    const evict = vi.fn(async () => ({
      evictedObjectIds: fixture.objectIds,
      fileOutcome: 'removed' as const,
      physicalBytesRemoved: 128n,
      planLogicalBytesRemoved: [{ bytes: 128n, planId: fixture.planId }],
      readyBytes: 0n,
    }));
    const queue = new PostgresMediaCacheCommandQueue(connection.db);
    const processor = new MediaCacheCommandProcessor(
      connection.db,
      queue,
      { evict },
      { reconcile: vi.fn() },
      'worker:test',
    );

    await expect(processor.runOnce()).resolves.toBe(true);
    await expect(processor.runOnce()).resolves.toBe(false);
    expect(evict).toHaveBeenCalledOnce();
    const [command] = await connection.db
      .select()
      .from(mediaCacheCommands)
      .where(eq(mediaCacheCommands.id, receipt.commandId));
    expect(command).toMatchObject({
      errorCode: null,
      state: 'succeeded',
    });
    expect(command?.result).toMatchObject({
      evictedObjectCount: 1,
      fileOutcome: 'removed',
      physicalBytesRemoved: '128',
    });
    expect(JSON.stringify(command?.result)).not.toContain(SHA256);
  });

  it('takes over an expired command lease and fences the stale owner', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const receipt = await service().reconcile({
      initiatorId: 'owner-user-id',
      reason: 'take over crashed worker',
    });
    const firstQueue = new PostgresMediaCacheCommandQueue(connection.db);
    const stale = await firstQueue.claim({ leaseOwner: 'worker:old' });
    if (!stale) throw new Error('Command was not claimed');
    await connection.db
      .update(mediaCacheCommands)
      .set({ leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(mediaCacheCommands.id, receipt.commandId));

    const reconcile = vi.fn(async () => reconcilePage(null));
    const newQueue = new PostgresMediaCacheCommandQueue(connection.db);
    const processor = new MediaCacheCommandProcessor(
      connection.db,
      newQueue,
      { evict: vi.fn() },
      { reconcile },
      'worker:new',
    );
    await expect(processor.runOnce()).resolves.toBe(true);
    await expect(firstQueue.succeed(stale, { stale: true })).rejects.toThrow('stale');
    const [command] = await connection.db
      .select()
      .from(mediaCacheCommands)
      .where(eq(mediaCacheCommands.id, receipt.commandId));
    expect(command).toMatchObject({ attemptCount: 2, state: 'succeeded' });
  });

  it('finishes reconcile pagination inside one durable command', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const cursor = randomUUID();
    const receipt = await service().reconcile({
      initiatorId: 'owner-user-id',
      reason: 'complete all reconcile pages',
    });
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce(reconcilePage(cursor))
      .mockResolvedValueOnce(reconcilePage(null));
    const processor = new MediaCacheCommandProcessor(
      connection.db,
      new PostgresMediaCacheCommandQueue(connection.db),
      { evict: vi.fn() },
      { reconcile },
      'worker:test',
    );

    await expect(processor.runOnce()).resolves.toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile.mock.calls[1]?.[0]).toMatchObject({ cursor });
    const [command] = await connection.db
      .select()
      .from(mediaCacheCommands)
      .where(eq(mediaCacheCommands.id, receipt.commandId));
    expect(command).toMatchObject({ state: 'succeeded' });
    expect(command?.result).toMatchObject({ checked: 2, pages: 2 });
  });
});

function reconcilePage(nextCursor: string | null) {
  return {
    applied: true,
    checked: 1,
    checksumMismatch: 0,
    hasMore: nextCursor !== null,
    ledger: {
      drift: false,
      expectedReadyBytes: '0',
      expectedReservedBytes: '0',
      readyBytes: '0',
      repaired: false,
      reservedBytes: '0',
    },
    missing: 0,
    nextCursor,
    orphans: { failed: 0, found: 0, recovered: 0 },
    repaired: 0,
    repairFailed: 0,
  };
}
