import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  mediaCacheActions,
  mediaCacheBlobs,
  mediaCacheObjectSources,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  messageMedia,
  messageRevisions,
  messages,
  telegramChannels,
} from '../../src/db/schema.js';
import {
  type MediaCacheEvictionError,
  PostgresMediaCacheEvictionRepository,
} from '../../src/media-cache/eviction-repository.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

interface ReadyPlanFixture {
  canonicalMediaId: string;
  objectId: string;
  planId: string;
  revisionId: string;
}

let fixtureSequence = 0;

async function createReadyPlan(
  connection: DatabaseConnection,
  input: {
    blobSha256: string;
    byteLength: bigint;
    planReadyBytes?: bigint;
    planState?: 'ready' | 'recovering' | 'settling';
  },
): Promise<ReadyPlanFixture> {
  fixtureSequence += 1;
  const [channel] = await connection.db
    .insert(telegramChannels)
    .values({
      telegramChatId: -1_005_000_000_000n - BigInt(fixtureSequence),
      title: `Eviction ${fixtureSequence}`,
    })
    .returning({ id: telegramChannels.id });
  if (!channel) {
    throw new Error('Fixture channel was not created');
  }
  const [message] = await connection.db
    .insert(messages)
    .values({
      channelId: channel.id,
      publishedAt: new Date('2026-07-24T00:00:00.000Z'),
      telegramMessageId: BigInt(fixtureSequence),
    })
    .returning({ id: messages.id });
  if (!message) {
    throw new Error('Fixture message was not created');
  }
  const [revision] = await connection.db
    .insert(messageRevisions)
    .values({
      contentKind: 'none',
      entities: [],
      messageId: message.id,
      revisionNumber: 1,
    })
    .returning({ id: messageRevisions.id });
  if (!revision) {
    throw new Error('Fixture revision was not created');
  }
  const [media] = await connection.db
    .insert(messageMedia)
    .values({
      kind: 'photo',
      position: 0,
      revisionId: revision.id,
      sourceKind: 'telegram_bot_update',
      telegramFileId: `file-${fixtureSequence}`,
      telegramFileUniqueId: `unique-${fixtureSequence}`,
    })
    .returning({ id: messageMedia.id });
  if (!media) {
    throw new Error('Fixture media was not created');
  }

  const state = input.planState ?? 'ready';
  const lease = state === 'ready' ? {} : liveLease();
  const [plan] = await connection.db
    .insert(mediaCachePostPlans)
    .values({
      ...lease,
      messageId: message.id,
      readyOriginalBytes: input.planReadyBytes ?? input.byteLength,
      revisionId: revision.id,
      state,
    })
    .returning({ id: mediaCachePostPlans.id });
  if (!plan) {
    throw new Error('Fixture plan was not created');
  }
  const [object] = await connection.db
    .insert(mediaCacheObjects)
    .values({
      actualBytes: input.byteLength,
      blobSha256: input.blobSha256,
      canonicalMediaId: media.id,
      ...(state === 'ready'
        ? {}
        : {
            ...lease,
            reservedBytes: input.byteLength,
          }),
      postPlanId: plan.id,
      recipeVersion: 1,
      revisionId: revision.id,
      state: state === 'ready' ? 'ready' : 'staging',
      variant: 'original',
    })
    .returning({ id: mediaCacheObjects.id });
  if (!object) {
    throw new Error('Fixture object was not created');
  }
  return {
    canonicalMediaId: media.id,
    objectId: object.id,
    planId: plan.id,
    revisionId: revision.id,
  };
}

async function addReadyThumbnail(
  connection: DatabaseConnection,
  fixture: ReadyPlanFixture,
  sha256: string,
  byteLength: bigint,
): Promise<string> {
  const [object] = await connection.db
    .insert(mediaCacheObjects)
    .values({
      actualBytes: byteLength,
      blobSha256: sha256,
      canonicalMediaId: fixture.canonicalMediaId,
      postPlanId: fixture.planId,
      recipeVersion: 1,
      revisionId: fixture.revisionId,
      state: 'ready',
      variant: 'thumbnail',
    })
    .returning({ id: mediaCacheObjects.id });
  if (!object) {
    throw new Error('Fixture thumbnail was not created');
  }
  return object.id;
}

async function insertBlob(
  connection: DatabaseConnection,
  sha256: string,
  byteLength: bigint,
  lastAccessedAt: Date,
): Promise<void> {
  await connection.db.insert(mediaCacheBlobs).values({
    byteLength,
    detectedMime: 'image/jpeg',
    lastAccessedAt,
    relativeKey: `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`,
    sha256,
    state: 'ready',
  });
}

function liveLease() {
  return {
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseOwner: 'worker-fixture',
    leaseToken: randomUUID(),
  };
}

function claimInput(
  selection: { kind: 'least_recently_used' } | { kind: 'specific_blob'; sha256: string } = {
    kind: 'least_recently_used',
  },
) {
  return {
    evictionExpiresAt: new Date(Date.now() + 60_000),
    evictionOwner: 'eviction-worker',
    evictionToken: randomUUID(),
    selection,
  } as const;
}

describe('PostgreSQL media cache eviction repository', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let connection: DatabaseConnection | undefined;

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
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    await connection.db.execute(sql`
      truncate table
        ${mediaCacheActions},
        ${mediaCacheObjectSources},
        ${mediaCacheObjects},
        ${mediaCacheBlobs},
        ${mediaCachePostPlans},
        ${mediaCacheRuntime},
        ${telegramChannels}
      cascade
    `);
  });

  it('writes at most 100 coalesced blob accesses and never moves access time backwards', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const initial = new Date('2026-07-24T01:00:00.000Z');
    const newest = new Date('2026-07-24T03:00:00.000Z');
    await insertBlob(connection, SHA_A, 100n, initial);
    const repository = new PostgresMediaCacheEvictionRepository(connection.db);

    await repository.writeAccesses([
      { observedAt: newest, sha256: SHA_A },
      { observedAt: new Date('2026-07-24T02:00:00.000Z'), sha256: SHA_A },
    ]);
    await repository.writeAccesses([
      { observedAt: new Date('2026-07-24T00:00:00.000Z'), sha256: SHA_A },
    ]);

    const [blob] = await connection.db
      .select({ lastAccessedAt: mediaCacheBlobs.lastAccessedAt })
      .from(mediaCacheBlobs)
      .where(eq(mediaCacheBlobs.sha256, SHA_A));
    expect(blob?.lastAccessedAt).toEqual(newest);
    await expect(
      repository.writeAccesses(
        Array.from({ length: 101 }, (_, index) => ({
          observedAt: newest,
          sha256: index % 2 === 0 ? SHA_A : SHA_B,
        })),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' } satisfies Partial<MediaCacheEvictionError>);
  });

  it('uses deterministic LRU order and excludes blobs pinned by settling or recovery', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const oldest = new Date('2026-07-24T01:00:00.000Z');
    await insertBlob(connection, SHA_A, 100n, oldest);
    await insertBlob(connection, SHA_B, 100n, oldest);
    await insertBlob(connection, SHA_C, 100n, new Date('2026-07-24T02:00:00.000Z'));
    await createReadyPlan(connection, {
      blobSha256: SHA_A,
      byteLength: 100n,
      planState: 'settling',
    });
    await createReadyPlan(connection, {
      blobSha256: SHA_C,
      byteLength: 100n,
      planState: 'recovering',
    });
    await connection.db.insert(mediaCacheRuntime).values({ readyBytes: 300n });
    const repository = new PostgresMediaCacheEvictionRepository(connection.db);

    const lruClaim = await repository.claimEviction(claimInput());
    expect(lruClaim?.sha256).toBe(SHA_B);
    await expect(
      repository.claimEviction(claimInput({ kind: 'specific_blob', sha256: SHA_A })),
    ).resolves.toBeNull();
    await expect(
      repository.claimEviction(claimInput({ kind: 'specific_blob', sha256: SHA_C })),
    ).resolves.toBeNull();

    const [runtime] = await connection.db.select().from(mediaCacheRuntime);
    expect(runtime?.readyBytes).toBe(300n);
  });

  it('evicts one shared physical blob and subtracts every original plan exactly once', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    await insertBlob(connection, SHA_A, 100n, new Date('2026-07-24T01:00:00.000Z'));
    const first = await createReadyPlan(connection, {
      blobSha256: SHA_A,
      byteLength: 100n,
    });
    const second = await createReadyPlan(connection, {
      blobSha256: SHA_A,
      byteLength: 100n,
    });
    const thumbnailId = await addReadyThumbnail(connection, second, SHA_A, 100n);
    await connection.db.insert(mediaCacheRuntime).values({ readyBytes: 100n });
    const repository = new PostgresMediaCacheEvictionRepository(connection.db);
    const claim = claimInput({ kind: 'specific_blob', sha256: SHA_A });

    await expect(repository.claimEviction(claim)).resolves.toMatchObject({ sha256: SHA_A });
    const completed = await repository.completeEviction({
      evictionToken: claim.evictionToken,
      initiator: {
        initiatorId: 'owner-1',
        kind: 'owner_session',
        reason: 'Remove cached copies from this device',
      },
      sha256: SHA_A,
    });

    expect(completed).toEqual({
      evictedObjectIds: [first.objectId, second.objectId, thumbnailId].sort(),
      physicalBytesRemoved: 100n,
      planLogicalBytesRemoved: [
        { bytes: 100n, planId: first.planId },
        { bytes: 100n, planId: second.planId },
      ].sort((left, right) => left.planId.localeCompare(right.planId)),
      readyBytes: 0n,
    });
    const plans = await connection.db
      .select({
        id: mediaCachePostPlans.id,
        readyOriginalBytes: mediaCachePostPlans.readyOriginalBytes,
      })
      .from(mediaCachePostPlans)
      .orderBy(asc(mediaCachePostPlans.id));
    expect(plans).toEqual(
      [
        { id: first.planId, readyOriginalBytes: 0n },
        { id: second.planId, readyOriginalBytes: 0n },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    const objects = await connection.db
      .select({ id: mediaCacheObjects.id, state: mediaCacheObjects.state })
      .from(mediaCacheObjects)
      .orderBy(asc(mediaCacheObjects.id));
    expect(objects).toEqual(
      [first.objectId, second.objectId, thumbnailId].sort().map((id) => ({ id, state: 'evicted' })),
    );
    const [action] = await connection.db.select().from(mediaCacheActions);
    expect(action).toMatchObject({
      actionKind: 'evict',
      blobSha256: SHA_A,
      initiatorId: 'owner-1',
      initiatorKind: 'owner_session',
      reason: 'Remove cached copies from this device',
    });
  });

  it('restores a failed unlink only for its token and rejects stale completion', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    await insertBlob(connection, SHA_A, 100n, new Date('2026-07-24T01:00:00.000Z'));
    await connection.db.insert(mediaCacheRuntime).values({ readyBytes: 100n });
    const repository = new PostgresMediaCacheEvictionRepository(connection.db);
    const firstClaim = claimInput({ kind: 'specific_blob', sha256: SHA_A });
    await repository.claimEviction(firstClaim);
    const staleToken = randomUUID();

    await expect(
      repository.restoreEviction({ evictionToken: staleToken, sha256: SHA_A }),
    ).rejects.toMatchObject({ code: 'stale_lease' } satisfies Partial<MediaCacheEvictionError>);
    await expect(
      repository.completeEviction({
        evictionToken: staleToken,
        initiator: { kind: 'worker' },
        sha256: SHA_A,
      }),
    ).rejects.toMatchObject({ code: 'stale_lease' } satisfies Partial<MediaCacheEvictionError>);
    await repository.restoreEviction({
      evictionToken: firstClaim.evictionToken,
      sha256: SHA_A,
    });

    const secondClaim = claimInput({ kind: 'specific_blob', sha256: SHA_A });
    await repository.claimEviction(secondClaim);
    await expect(
      repository.completeEviction({
        evictionToken: firstClaim.evictionToken,
        initiator: { kind: 'worker' },
        sha256: SHA_A,
      }),
    ).rejects.toMatchObject({ code: 'stale_lease' } satisfies Partial<MediaCacheEvictionError>);
    const [runtime] = await connection.db.select().from(mediaCacheRuntime);
    expect(runtime?.readyBytes).toBe(100n);
  });

  it('uses a fixed audit reason for worker LRU eviction', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    await insertBlob(connection, SHA_A, 100n, new Date('2026-07-24T01:00:00.000Z'));
    await connection.db.insert(mediaCacheRuntime).values({ readyBytes: 100n });
    const repository = new PostgresMediaCacheEvictionRepository(connection.db);
    const claim = claimInput();
    await repository.claimEviction(claim);

    await repository.completeEviction({
      evictionToken: claim.evictionToken,
      initiator: { kind: 'worker' },
      sha256: SHA_A,
    });

    const [action] = await connection.db.select().from(mediaCacheActions);
    expect(action?.reason).toBe('lru_capacity_pressure');
  });
});
