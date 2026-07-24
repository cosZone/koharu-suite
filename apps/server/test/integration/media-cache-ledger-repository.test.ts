import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { PostgresMediaCacheAdminService } from '../../src/media-cache/admin-service.js';
import { LocalMediaBlobStore } from '../../src/media-cache/blob-store.js';
import { MediaCacheEvictionService } from '../../src/media-cache/eviction-repository.js';
import {
  MEDIA_CACHE_ADVISORY_LOCK,
  PostgresMediaCacheLedgerRepository,
} from '../../src/media-cache/ledger-repository.js';
import { PostgresPublicMediaObjectRepository } from '../../src/media-cache/public-reader.js';
import { PostgresMediaCacheThumbnailLedgerRepository } from '../../src/media-cache/thumbnail-ledger-repository.js';
import { MediaCacheWorker } from '../../src/media-cache/worker.js';
import { PostgresMediaCacheWorkerRepository } from '../../src/media-cache/worker-repository.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const MIB = 1024n * 1024n;
const JPEG_FIXTURE = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const MP4_20_MIB_FIXTURE = new Uint8Array(20 * Number(MIB));
MP4_20_MIB_FIXTURE.set([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);

interface PlanFixture {
  objectIds: string[];
  planId: string;
}

async function createPlanFixture(
  connection: DatabaseConnection,
  sequence: number,
  kinds: readonly ('animation' | 'photo' | 'video')[],
): Promise<PlanFixture> {
  const [channel] = await connection.db
    .insert(telegramChannels)
    .values({
      telegramChatId: -1_003_000_000_000n - BigInt(sequence),
      title: `Ledger fixture ${sequence}`,
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
      telegramMessageId: BigInt(sequence),
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

  const media = await connection.db
    .insert(messageMedia)
    .values(
      kinds.map((kind, position) => ({
        kind,
        position,
        revisionId: revision.id,
        sourceKind: 'telegram_bot_update' as const,
        telegramFileId: `file-${sequence}-${position}`,
        telegramFileUniqueId: `unique-${sequence}-${position}`,
      })),
    )
    .returning({ id: messageMedia.id });

  const [plan] = await connection.db
    .insert(mediaCachePostPlans)
    .values({
      messageId: message.id,
      revisionId: revision.id,
    })
    .returning({ id: mediaCachePostPlans.id });
  if (!plan) {
    throw new Error('Fixture plan was not created');
  }

  const objects = await connection.db
    .insert(mediaCacheObjects)
    .values(
      media.map((item) => ({
        canonicalMediaId: item.id,
        postPlanId: plan.id,
        recipeVersion: 1,
        revisionId: revision.id,
        variant: 'original' as const,
      })),
    )
    .returning({ id: mediaCacheObjects.id });

  return {
    objectIds: objects.map((object) => object.id),
    planId: plan.id,
  };
}

function publishedObject(
  objectId: string,
  character: string,
  byteLength: bigint,
  detectedMime: 'image/jpeg' | 'video/mp4' = 'video/mp4',
) {
  const sha256 = character.repeat(64);
  return {
    byteLength,
    detectedMime,
    objectId,
    relativeKey: `blobs/${character}${character}/${character}${character}/${sha256}`,
    sha256,
  } as const;
}

function leaseExpiry(milliseconds = 30_000): Date {
  return new Date(Date.now() + milliseconds);
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('PostgreSQL media cache ledger repository', () => {
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
    await connection?.db.execute(sql`
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

  it('reports admission headroom so deterministic LRU can make a near-full plan claimable', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 32, ['photo']);
    const existingSha = 'e'.repeat(64);
    await connection.db.insert(mediaCacheRuntime).values({
      maxBytes: 10n * MIB,
      readyBytes: 9n * MIB,
      singletonKey: 'local',
    });
    await connection.db.insert(mediaCacheBlobs).values({
      byteLength: 9n * MIB,
      detectedMime: 'image/jpeg',
      relativeKey: `blobs/ee/ee/${existingSha}`,
      sha256: existingSha,
      state: 'ready',
    });
    const ledger = new PostgresMediaCacheLedgerRepository(connection.db);
    await expect(ledger.requiredHeadroomBytes()).resolves.toBe(9n * MIB);

    const eviction = new MediaCacheEvictionService(connection.db, {
      evict: async () => 'removed' as const,
    });
    await eviction.evict({
      evictionExpiresAt: leaseExpiry(),
      evictionOwner: 'capacity-test',
      evictionToken: randomUUID(),
      initiator: { kind: 'worker' },
      selection: { kind: 'least_recently_used' },
    });
    const leaseToken = randomUUID();
    await expect(
      ledger.claimPostPlan({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'capacity-test',
        leaseToken,
        planId: fixture.planId,
      }),
    ).resolves.toMatchObject({
      objectIds: fixture.objectIds,
      requestedBytes: 10n * MIB,
    });
  });

  it('reserves a 50 MiB post and keeps its published bytes conservative until settlement', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 1, ['video', 'video', 'video']);
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const leaseToken = randomUUID();

    const claim = await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-1',
      leaseToken,
      planId: fixture.planId,
    });

    expect(claim).toEqual({
      objectIds: fixture.objectIds,
      planId: fixture.planId,
      requestedBytes: 50n * MIB,
    });

    const published = await repository.recordPublishedObjects({
      leaseToken,
      objects: fixture.objectIds.map((objectId, index) =>
        publishedObject(objectId, String(index + 1), 16n * MIB),
      ),
      planId: fixture.planId,
      publish: async () => undefined,
    });

    expect(published).toEqual({
      physicalBytesAdded: 48n * MIB,
      readyBytes: 48n * MIB,
      reservedBytes: 50n * MIB,
    });

    const completed = await repository.completeSettlement({
      leaseToken,
      planId: fixture.planId,
    });

    expect(completed).toEqual({
      logicalReadyBytes: 48n * MIB,
      readyBytes: 48n * MIB,
      releasedReservationBytes: 50n * MIB,
      reservedBytes: 0n,
    });
  });

  it('rejects a specific eligible plan when ready, reserved, and requested bytes exceed max', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 2, ['photo']);
    await connection.db.insert(mediaCacheRuntime).values({
      maxBytes: 100n * MIB,
      readyBytes: 89n * MIB,
      reservedBytes: 2n * MIB,
    });
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);

    await expect(
      repository.claimPostPlan({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-1',
        leaseToken: randomUUID(),
        planId: fixture.planId,
      }),
    ).resolves.toBeNull();

    await expect(
      repository.claimPostPlan({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-2',
        leaseToken: randomUUID(),
        planId: fixture.planId,
      }),
    ).resolves.toBeNull();
  });

  it('serializes concurrent plan admission against the shared physical budget', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const first = await createPlanFixture(connection, 9, ['photo']);
    const second = await createPlanFixture(connection, 10, ['photo']);
    await connection.db.insert(mediaCacheRuntime).values({
      maxBytes: 15n * MIB,
    });
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);

    const results = await Promise.all(
      [first, second].map((fixture, index) =>
        repository.claimPostPlan({
          leaseExpiresAt: leaseExpiry(),
          leaseOwner: `worker-${index + 1}`,
          leaseToken: randomUUID(),
          planId: fixture.planId,
        }),
      ),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(results.find((result) => result !== null)?.requestedBytes).toBe(10n * MIB);
  });

  it('holds the shared ledger lock across publication and rolls back when the callback fails', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const publishing = await createPlanFixture(connection, 11, ['photo']);
    const waiting = await createPlanFixture(connection, 12, ['photo']);
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const publishingToken = randomUUID();
    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-1',
      leaseToken: publishingToken,
      planId: publishing.planId,
    });

    let enterCallback: (() => void) | undefined;
    const callbackEntered = new Promise<void>((resolve) => {
      enterCallback = resolve;
    });
    let releaseCallback: (() => void) | undefined;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const failedFinalize = repository.recordPublishedObjects({
      leaseToken: publishingToken,
      objects: [publishedObject(publishing.objectIds[0] ?? '', '9', 5n * MIB, 'image/jpeg')],
      planId: publishing.planId,
      publish: async () => {
        enterCallback?.();
        await callbackGate;
        throw new Error('simulated filesystem publication failure');
      },
    });
    await callbackEntered;

    let waitingClaimSettled = false;
    const waitingClaim = repository
      .claimPostPlan({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-2',
        leaseToken: randomUUID(),
        planId: waiting.planId,
      })
      .then((result) => {
        waitingClaimSettled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(waitingClaimSettled).toBe(false);

    releaseCallback?.();
    await expect(failedFinalize).rejects.toThrow('simulated filesystem publication failure');
    await expect(waitingClaim).resolves.toMatchObject({
      planId: waiting.planId,
      requestedBytes: 10n * MIB,
    });

    await expect(
      repository.recordPublishedObjects({
        leaseToken: publishingToken,
        objects: [publishedObject(publishing.objectIds[0] ?? '', '9', 5n * MIB, 'image/jpeg')],
        planId: publishing.planId,
        publish: async () => undefined,
      }),
    ).resolves.toEqual({
      physicalBytesAdded: 5n * MIB,
      readyBytes: 5n * MIB,
      reservedBytes: 20n * MIB,
    });
  });

  it('fences both finalize transactions with the live plan lease token', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 3, ['photo']);
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const leaseToken = randomUUID();
    const staleToken = randomUUID();
    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-1',
      leaseToken,
      planId: fixture.planId,
    });
    const identity = publishedObject(fixture.objectIds[0] ?? '', 'a', 8n * MIB, 'image/jpeg');

    await expect(
      repository.recordPublishedObjects({
        leaseToken: staleToken,
        objects: [identity],
        planId: fixture.planId,
        publish: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'stale_lease' });

    await expect(
      repository.recordPublishedObjects({
        leaseToken,
        objects: [identity],
        planId: fixture.planId,
        publish: async () => undefined,
      }),
    ).resolves.toMatchObject({
      physicalBytesAdded: 8n * MIB,
      reservedBytes: 10n * MIB,
    });

    await expect(
      repository.completeSettlement({
        leaseToken: staleToken,
        planId: fixture.planId,
      }),
    ).rejects.toMatchObject({ code: 'stale_lease' });

    await expect(
      repository.completeSettlement({
        leaseToken,
        planId: fixture.planId,
      }),
    ).resolves.toMatchObject({
      logicalReadyBytes: 8n * MIB,
      reservedBytes: 0n,
    });
  });

  it('accounts one physical blob for within-plan and cross-plan deduplication', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const first = await createPlanFixture(connection, 4, ['photo', 'photo']);
    const second = await createPlanFixture(connection, 5, ['photo']);
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const firstToken = randomUUID();
    const secondToken = randomUUID();

    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-1',
      leaseToken: firstToken,
      planId: first.planId,
    });
    const firstFinalize = await repository.recordPublishedObjects({
      leaseToken: firstToken,
      objects: first.objectIds.map((objectId) =>
        publishedObject(objectId, 'b', 6n * MIB, 'image/jpeg'),
      ),
      planId: first.planId,
      publish: async () => undefined,
    });
    expect(firstFinalize).toEqual({
      physicalBytesAdded: 6n * MIB,
      readyBytes: 6n * MIB,
      reservedBytes: 20n * MIB,
    });
    await expect(
      repository.completeSettlement({
        leaseToken: firstToken,
        planId: first.planId,
      }),
    ).resolves.toMatchObject({
      logicalReadyBytes: 12n * MIB,
      readyBytes: 6n * MIB,
    });

    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-2',
      leaseToken: secondToken,
      planId: second.planId,
    });
    const secondFinalize = await repository.recordPublishedObjects({
      leaseToken: secondToken,
      objects: [publishedObject(second.objectIds[0] ?? '', 'b', 6n * MIB, 'image/jpeg')],
      planId: second.planId,
      publish: async () => undefined,
    });
    expect(secondFinalize).toEqual({
      physicalBytesAdded: 0n,
      readyBytes: 6n * MIB,
      reservedBytes: 10n * MIB,
    });
    await expect(
      repository.completeSettlement({
        leaseToken: secondToken,
        planId: second.planId,
      }),
    ).resolves.toEqual({
      logicalReadyBytes: 6n * MIB,
      readyBytes: 6n * MIB,
      releasedReservationBytes: 10n * MIB,
      reservedBytes: 0n,
    });
  });

  it('counts a non-ready database blob once even when the final file could already exist', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 6, ['photo']);
    const sha256 = 'c'.repeat(64);
    await connection.db.insert(mediaCacheBlobs).values({
      byteLength: 5n * MIB,
      detectedMime: 'image/jpeg',
      relativeKey: `blobs/cc/cc/${sha256}`,
      sha256,
      state: 'evicted',
    });
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const leaseToken = randomUUID();
    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-1',
      leaseToken,
      planId: fixture.planId,
    });

    await expect(
      repository.recordPublishedObjects({
        leaseToken,
        objects: [publishedObject(fixture.objectIds[0] ?? '', 'c', 5n * MIB, 'image/jpeg')],
        planId: fixture.planId,
        publish: async () => undefined,
      }),
    ).resolves.toEqual({
      physicalBytesAdded: 5n * MIB,
      readyBytes: 5n * MIB,
      reservedBytes: 10n * MIB,
    });
  });

  it('fails closed on a sticky object hash conflict without consuming the lease transaction', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 7, ['photo']);
    const stickyHash = 'd'.repeat(64);
    await connection.db.insert(mediaCacheBlobs).values({
      byteLength: 4n * MIB,
      detectedMime: 'image/jpeg',
      relativeKey: `blobs/dd/dd/${stickyHash}`,
      sha256: stickyHash,
      state: 'evicted',
    });
    await connection.db
      .update(mediaCacheObjects)
      .set({ blobSha256: stickyHash })
      .where(sql`${mediaCacheObjects.id} = ${fixture.objectIds[0]}`);

    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const leaseToken = randomUUID();
    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-1',
      leaseToken,
      planId: fixture.planId,
    });

    await expect(
      repository.recordPublishedObjects({
        leaseToken,
        objects: [publishedObject(fixture.objectIds[0] ?? '', 'e', 4n * MIB, 'image/jpeg')],
        planId: fixture.planId,
        publish: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'sticky_hash_conflict' });

    await expect(
      repository.recordPublishedObjects({
        leaseToken,
        objects: [publishedObject(fixture.objectIds[0] ?? '', 'd', 4n * MIB, 'image/jpeg')],
        planId: fixture.planId,
        publish: async () => undefined,
      }),
    ).resolves.toMatchObject({
      physicalBytesAdded: 4n * MIB,
      reservedBytes: 10n * MIB,
    });
  });

  it('rolls back earlier blob and ledger transitions when a later blob identity conflicts', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 8, ['photo', 'photo']);
    const conflictingHash = 'f'.repeat(64);
    await connection.db.insert(mediaCacheBlobs).values({
      byteLength: 5n * MIB,
      detectedMime: 'image/jpeg',
      relativeKey: `blobs/ff/ff/${conflictingHash}`,
      sha256: conflictingHash,
      state: 'evicted',
    });
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const leaseToken = randomUUID();
    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-1',
      leaseToken,
      planId: fixture.planId,
    });
    const [firstObjectId = '', secondObjectId = ''] = fixture.objectIds;

    await expect(
      repository.recordPublishedObjects({
        leaseToken,
        objects: [
          publishedObject(firstObjectId, 'e', 6n * MIB, 'image/jpeg'),
          publishedObject(secondObjectId, 'f', 5n * MIB, 'video/mp4'),
        ],
        planId: fixture.planId,
        publish: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'blob_identity_conflict' });

    await expect(
      repository.recordPublishedObjects({
        leaseToken,
        objects: [
          publishedObject(firstObjectId, 'e', 6n * MIB, 'image/jpeg'),
          publishedObject(secondObjectId, 'f', 5n * MIB, 'image/jpeg'),
        ],
        planId: fixture.planId,
        publish: async () => undefined,
      }),
    ).resolves.toEqual({
      physicalBytesAdded: 11n * MIB,
      readyBytes: 11n * MIB,
      reservedBytes: 20n * MIB,
    });
  });

  it('claims no subset when any original in the plan is not runnable', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 13, ['photo', 'photo']);
    const unavailableObjectId = fixture.objectIds[1];
    if (!unavailableObjectId) {
      throw new Error('Fixture did not create both originals');
    }
    await connection.db
      .update(mediaCacheObjects)
      .set({ state: 'awaiting_local_source' })
      .where(eq(mediaCacheObjects.id, unavailableObjectId));
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);

    await expect(
      repository.claimPostPlan({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-atomic',
        leaseToken: randomUUID(),
        planId: fixture.planId,
      }),
    ).resolves.toBeNull();

    const objects = await connection.db
      .select({
        reservedBytes: mediaCacheObjects.reservedBytes,
        state: mediaCacheObjects.state,
      })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.postPlanId, fixture.planId));
    expect(objects).toEqual(
      expect.arrayContaining([
        { reservedBytes: 0n, state: 'discovered' },
        { reservedBytes: 0n, state: 'awaiting_local_source' },
      ]),
    );
    const [runtime] = await connection.db.select().from(mediaCacheRuntime);
    expect(runtime?.reservedBytes ?? 0n).toBe(0n);
  });

  it('requires an explicit local claim and returns an expired Desktop lease to awaiting state', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 21, ['photo']);
    await connection.db
      .update(mediaCachePostPlans)
      .set({ state: 'awaiting_local_source' })
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    await connection.db
      .update(mediaCacheObjects)
      .set({ state: 'awaiting_local_source' })
      .where(eq(mediaCacheObjects.postPlanId, fixture.planId));
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);

    await expect(
      repository.claimPostPlan({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-must-not-claim',
        leaseToken: randomUUID(),
        planId: fixture.planId,
      }),
    ).resolves.toBeNull();

    const previousLeaseToken = randomUUID();
    await expect(
      repository.claimPostPlan({
        allowAwaitingLocalSource: true,
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'desktop-cli:123',
        leaseToken: previousLeaseToken,
        planId: fixture.planId,
      }),
    ).resolves.toMatchObject({ planId: fixture.planId });
    await connection.db
      .update(mediaCachePostPlans)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    await connection.db
      .update(mediaCacheObjects)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(mediaCacheObjects.postPlanId, fixture.planId));

    await expect(
      repository.recoverExpiredPostPlan({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-recovery',
        leaseToken: randomUUID(),
        planId: fixture.planId,
        recover: async () => undefined,
      }),
    ).resolves.toEqual({
      nextState: 'awaiting_local_source',
      planId: fixture.planId,
      releasedReservationBytes: 10n * MIB,
    });
    const [plan] = await connection.db
      .select()
      .from(mediaCachePostPlans)
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    expect(plan).toMatchObject({
      attemptCount: 0,
      leaseOwner: null,
      reservedOriginalBytes: 0n,
      state: 'awaiting_local_source',
    });
  });

  it('keeps policy-skipped originals outside the atomic eligible set', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 20, ['photo', 'photo']);
    const [eligibleObjectId = '', skippedObjectId = ''] = fixture.objectIds;
    await connection.db
      .update(mediaCacheObjects)
      .set({ reasonCode: 'skipped_kind_limit', state: 'skipped' })
      .where(eq(mediaCacheObjects.id, skippedObjectId));
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const leaseToken = randomUUID();

    await expect(
      repository.claimPostPlan({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-skipped',
        leaseToken,
        planId: fixture.planId,
      }),
    ).resolves.toEqual({
      objectIds: [eligibleObjectId],
      planId: fixture.planId,
      requestedBytes: 10n * MIB,
    });
    await repository.recordPublishedObjects({
      leaseToken,
      objects: [publishedObject(eligibleObjectId, '5', 5n * MIB, 'image/jpeg')],
      planId: fixture.planId,
      publish: async () => undefined,
    });
    await repository.completeSettlement({ leaseToken, planId: fixture.planId });

    const objects = await connection.db
      .select({ id: mediaCacheObjects.id, state: mediaCacheObjects.state })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.postPlanId, fixture.planId));
    expect(objects).toEqual(
      expect.arrayContaining([
        { id: eligibleObjectId, state: 'ready' },
        { id: skippedObjectId, state: 'skipped' },
      ]),
    );
  });

  it('rejects an object larger than its reservation before filesystem publication', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 14, ['photo']);
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const leaseToken = randomUUID();
    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-limit',
      leaseToken,
      planId: fixture.planId,
    });
    let published = false;

    await expect(
      repository.recordPublishedObjects({
        leaseToken,
        objects: [publishedObject(fixture.objectIds[0] ?? '', '1', 11n * MIB, 'image/jpeg')],
        planId: fixture.planId,
        publish: async () => {
          published = true;
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(published).toBe(false);
  });

  it('fails closed without changing an active deleting blob lease or accounting', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 15, ['photo']);
    const sha256 = '2'.repeat(64);
    const evictionToken = randomUUID();
    await connection.db.insert(mediaCacheBlobs).values({
      byteLength: 5n * MIB,
      detectedMime: 'image/jpeg',
      evictionExpiresAt: leaseExpiry(),
      evictionOwner: 'evictor',
      evictionToken,
      relativeKey: `blobs/22/22/${sha256}`,
      sha256,
      state: 'deleting',
    });
    await connection.db.insert(mediaCacheRuntime).values({ readyBytes: 5n * MIB });
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const leaseToken = randomUUID();
    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-delete-race',
      leaseToken,
      planId: fixture.planId,
    });
    let published = false;

    await expect(
      repository.recordPublishedObjects({
        leaseToken,
        objects: [publishedObject(fixture.objectIds[0] ?? '', '2', 5n * MIB, 'image/jpeg')],
        planId: fixture.planId,
        publish: async () => {
          published = true;
        },
      }),
    ).rejects.toMatchObject({ code: 'blob_deleting' });
    expect(published).toBe(false);
    const [blob] = await connection.db
      .select()
      .from(mediaCacheBlobs)
      .where(eq(mediaCacheBlobs.sha256, sha256));
    expect(blob).toMatchObject({
      evictionOwner: 'evictor',
      evictionToken,
      state: 'deleting',
    });
    const [runtime] = await connection.db.select().from(mediaCacheRuntime);
    expect(runtime).toMatchObject({
      readyBytes: 5n * MIB,
      reservedBytes: 10n * MIB,
    });
  });

  it('uses the database clock after lock wait and after the publish callback', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const waiting = await createPlanFixture(connection, 16, ['photo']);
    const waitingRepository = new PostgresMediaCacheLedgerRepository(connection.db);
    let lockAcquired: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    let releaseLock: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockHolder = connection.db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${MEDIA_CACHE_ADVISORY_LOCK})`);
      lockAcquired?.();
      await gate;
    });
    await acquired;
    const waitingClaim = waitingRepository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(500),
      leaseOwner: 'worker-waiting',
      leaseToken: randomUUID(),
      planId: waiting.planId,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    releaseLock?.();
    await lockHolder;
    await expect(waitingClaim).rejects.toMatchObject({ code: 'stale_lease' });

    const publishing = await createPlanFixture(connection, 17, ['photo']);
    const publishingToken = randomUUID();
    await waitingRepository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(800),
      leaseOwner: 'worker-publishing',
      leaseToken: publishingToken,
      planId: publishing.planId,
    });
    await expect(
      waitingRepository.recordPublishedObjects({
        leaseToken: publishingToken,
        objects: [publishedObject(publishing.objectIds[0] ?? '', '3', 5n * MIB, 'image/jpeg')],
        planId: publishing.planId,
        publish: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_100));
        },
      }),
    ).rejects.toMatchObject({ code: 'stale_lease' });
    const [publishedBlob] = await connection.db
      .select()
      .from(mediaCacheBlobs)
      .where(eq(mediaCacheBlobs.sha256, '3'.repeat(64)));
    expect(publishedBlob).toBeUndefined();
  });

  it('recovers an expired precommit lease only after cleanup and releases its reservation', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 18, ['photo', 'video']);
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const previousLeaseToken = randomUUID();
    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-old',
      leaseToken: previousLeaseToken,
      planId: fixture.planId,
    });
    await connection.db
      .update(mediaCachePostPlans)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    await connection.db
      .update(mediaCacheObjects)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(mediaCacheObjects.postPlanId, fixture.planId));

    const newLeaseToken = randomUUID();
    await expect(
      repository.recoverExpiredPostPlan({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-failed-recovery',
        leaseToken: newLeaseToken,
        planId: fixture.planId,
        recover: async () => {
          throw new Error('simulated cleanup failure');
        },
      }),
    ).rejects.toThrow('simulated cleanup failure');
    const [preservedPlan] = await connection.db
      .select()
      .from(mediaCachePostPlans)
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    expect(preservedPlan).toMatchObject({
      leaseToken: previousLeaseToken,
      reservedOriginalBytes: 30n * MIB,
      state: 'staging',
    });
    const [preservedRuntime] = await connection.db.select().from(mediaCacheRuntime);
    expect(preservedRuntime?.reservedBytes).toBe(30n * MIB);

    let snapshotSeen = false;
    const recovered = await repository.recoverExpiredPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-new',
      leaseToken: newLeaseToken,
      planId: fixture.planId,
      recover: async (snapshot) => {
        snapshotSeen = true;
        expect(snapshot).toMatchObject({
          phase: 'precommit',
          planId: fixture.planId,
          previousLeaseToken,
        });
        expect(snapshot.objects.map(({ objectId }) => objectId).sort()).toEqual(
          [...fixture.objectIds].sort(),
        );
      },
    });

    expect(snapshotSeen).toBe(true);
    expect(recovered).toEqual({
      nextState: 'retry_wait',
      planId: fixture.planId,
      releasedReservationBytes: 30n * MIB,
    });
    const [plan] = await connection.db
      .select()
      .from(mediaCachePostPlans)
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    expect(plan).toMatchObject({
      leaseToken: null,
      reservedOriginalBytes: 0n,
      state: 'retry_wait',
    });
    const [runtime] = await connection.db.select().from(mediaCacheRuntime);
    expect(runtime?.reservedBytes).toBe(0n);
  });

  it('keeps an exhausted recovery runnable until cleanup succeeds and blocks precommit work', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 181, ['photo']);
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const work = new PostgresMediaCacheWorkerRepository(connection.db);
    const previousLeaseToken = randomUUID();
    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-old',
      leaseToken: previousLeaseToken,
      planId: fixture.planId,
    });
    await connection.db
      .update(mediaCachePostPlans)
      .set({
        attemptCount: 9,
        leaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    await connection.db
      .update(mediaCacheObjects)
      .set({
        attemptCount: 9,
        leaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(eq(mediaCacheObjects.postPlanId, fixture.planId));

    await expect(
      repository.recoverExpiredPostPlan({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-recovery',
        leaseToken: randomUUID(),
        planId: fixture.planId,
        recover: async () => {
          throw new Error('simulated cleanup failure');
        },
      }),
    ).rejects.toThrow('simulated cleanup failure');
    await expect(
      repository.markExpiredRecoveryFailed({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-recovery',
        leaseToken: randomUUID(),
        planId: fixture.planId,
      }),
    ).resolves.toBe(true);

    const [failedRecovery] = await connection.db
      .select()
      .from(mediaCachePostPlans)
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    expect(failedRecovery).toMatchObject({
      attemptCount: 10,
      leaseToken: previousLeaseToken,
      reservedOriginalBytes: 10n * MIB,
      state: 'recovering',
    });
    await expect(work.listExpiredPostPlanIds(1)).resolves.toEqual([]);

    await connection.db
      .update(mediaCachePostPlans)
      .set({ availableAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    await expect(work.listExpiredPostPlanIds(1)).resolves.toEqual([fixture.planId]);

    await expect(
      repository.recoverExpiredPostPlan({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-recovered',
        leaseToken: randomUUID(),
        planId: fixture.planId,
        recover: async (snapshot) => {
          expect(snapshot).toMatchObject({
            phase: 'precommit',
            previousLeaseToken,
          });
        },
      }),
    ).resolves.toEqual({
      nextState: 'blocked',
      planId: fixture.planId,
      releasedReservationBytes: 10n * MIB,
    });
    const [blockedPlan] = await connection.db
      .select()
      .from(mediaCachePostPlans)
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    expect(blockedPlan).toMatchObject({
      attemptCount: 10,
      leaseToken: null,
      reservedOriginalBytes: 0n,
      state: 'blocked',
    });
    const [runtime] = await connection.db.select().from(mediaCacheRuntime);
    expect(runtime?.reservedBytes).toBe(0n);
  });

  it('recovers expired postcommit provenance onto a fresh token and completes settlement', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 19, ['photo']);
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const previousLeaseToken = randomUUID();
    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-old',
      leaseToken: previousLeaseToken,
      planId: fixture.planId,
    });
    await repository.recordPublishedObjects({
      leaseToken: previousLeaseToken,
      objects: [publishedObject(fixture.objectIds[0] ?? '', '4', 5n * MIB, 'image/jpeg')],
      planId: fixture.planId,
      publish: async () => undefined,
    });
    await connection.db
      .update(mediaCachePostPlans)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    await connection.db
      .update(mediaCacheObjects)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(mediaCacheObjects.postPlanId, fixture.planId));

    const newLeaseToken = randomUUID();
    await expect(
      repository.recoverExpiredPostPlan({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-new',
        leaseToken: newLeaseToken,
        planId: fixture.planId,
        recover: async (snapshot) => {
          expect(snapshot).toMatchObject({
            phase: 'postcommit',
            previousLeaseToken,
          });
          expect(snapshot.objects).toEqual([
            expect.objectContaining({
              actualBytes: 5n * MIB,
              blobSha256: '4'.repeat(64),
            }),
          ]);
        },
      }),
    ).resolves.toEqual({
      leaseToken: newLeaseToken,
      nextState: 'settling',
      planId: fixture.planId,
      releasedReservationBytes: 0n,
    });
    await expect(
      repository.completeSettlement({
        leaseToken: previousLeaseToken,
        planId: fixture.planId,
      }),
    ).rejects.toMatchObject({ code: 'stale_lease' });
    await expect(
      repository.completeSettlement({
        leaseToken: newLeaseToken,
        planId: fixture.planId,
      }),
    ).resolves.toMatchObject({
      logicalReadyBytes: 5n * MIB,
      reservedBytes: 0n,
    });
  });

  it('releases a failed live plan into bounded retry backoff only after staging cleanup', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 20, ['photo']);
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const leaseToken = randomUUID();
    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-1',
      leaseToken,
      planId: fixture.planId,
    });
    let cleanupCompleted = false;

    await expect(
      repository.failClaimedPostPlan({
        cleanup: async () => {
          cleanupCompleted = true;
        },
        errorClass: 'source',
        errorCode: 'telegram_media_source_transient',
        leaseToken,
        planId: fixture.planId,
      }),
    ).resolves.toMatchObject({
      attemptCount: 1,
      nextState: 'retry_wait',
      releasedReservationBytes: 10n * MIB,
    });
    expect(cleanupCompleted).toBe(true);

    const [plan] = await connection.db
      .select()
      .from(mediaCachePostPlans)
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    expect(plan).toMatchObject({
      attemptCount: 1,
      lastErrorClass: 'source',
      lastErrorCode: 'telegram_media_source_transient',
      leaseToken: null,
      reservedOriginalBytes: 0n,
      state: 'retry_wait',
    });
    expect(plan?.availableAt.getTime()).toBeGreaterThan(plan?.updatedAt.getTime() ?? 0);
    const [object] = await connection.db
      .select()
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.id, fixture.objectIds[0] ?? ''));
    expect(object).toMatchObject({
      attemptCount: 1,
      lastErrorClass: 'source',
      lastErrorCode: 'telegram_media_source_transient',
      leaseToken: null,
      reservedBytes: 0n,
      state: 'retry_wait',
    });
    const [runtime] = await connection.db.select().from(mediaCacheRuntime);
    expect(runtime?.reservedBytes).toBe(0n);
  });

  it('atomically skips a post when streamed originals actually exceed 50 MiB', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 30, ['video', 'video', 'video']);
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const root = await mkdtemp(join(tmpdir(), 'koharu-ledger-post-limit-'));
    const blobs = new LocalMediaBlobStore(root);
    await blobs.initialize();
    const publish = vi.spyOn(blobs, 'publish');
    const leaseToken = randomUUID();
    const worker = new MediaCacheWorker({
      blobStore: blobs,
      discovery: {
        discoverBatch: async () => ({
          cursor: null,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        }),
      },
      ledger: repository,
      leaseOwner: 'integration-post-limit',
      randomUuid: () => leaseToken,
      source: {
        open: async () => ({
          declaredBytes: null,
          stream: byteStream(MP4_20_MIB_FIXTURE),
        }),
      },
      work: {
        ensureThumbnailObjects: async () => 0,
        listExpiredPostPlanIds: async () => [],
        listRunnablePostPlanIds: async () => [fixture.planId],
        loadClaimedOriginals: async () =>
          fixture.objectIds.map((objectId, position) => ({
            kind: 'video' as const,
            objectId,
            position,
            sources: [{ fileId: `actual-20-mib-${position}` }],
          })),
      },
    });

    try {
      await expect(worker.runOnce()).resolves.toMatchObject({
        completedPlans: 0,
        failedPlans: 1,
      });
      expect(publish).not.toHaveBeenCalled();
      await expect(blobs.recoverLease({ leaseToken, planId: fixture.planId })).resolves.toEqual([]);

      const [plan] = await connection.db
        .select()
        .from(mediaCachePostPlans)
        .where(eq(mediaCachePostPlans.id, fixture.planId));
      expect(plan).toMatchObject({
        lastErrorCode: 'skipped_post_limit',
        leaseToken: null,
        reasonCode: 'skipped_post_limit',
        reservedOriginalBytes: 0n,
        state: 'skipped',
      });
      const objects = await connection.db
        .select()
        .from(mediaCacheObjects)
        .where(eq(mediaCacheObjects.postPlanId, fixture.planId));
      expect(objects).toHaveLength(3);
      expect(objects).toEqual(
        expect.arrayContaining(
          fixture.objectIds.map((id) =>
            expect.objectContaining({
              id,
              leaseToken: null,
              reasonCode: 'skipped_post_limit',
              reservedBytes: 0n,
              state: 'skipped',
            }),
          ),
        ),
      );
      const [runtime] = await connection.db.select().from(mediaCacheRuntime);
      expect(runtime).toMatchObject({ readyBytes: 0n, reservedBytes: 0n });
      expect(await connection.db.select().from(mediaCacheBlobs)).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('terminally fences changed bytes against a sticky hash and permits an audited owner retry', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 31, ['photo']);
    const objectId = fixture.objectIds[0];
    if (!objectId) {
      throw new Error('Fixture object was not created');
    }
    const stickyHash = 'd'.repeat(64);
    await connection.db.insert(mediaCacheBlobs).values({
      byteLength: BigInt(JPEG_FIXTURE.byteLength),
      detectedMime: 'image/jpeg',
      relativeKey: `blobs/dd/dd/${stickyHash}`,
      sha256: stickyHash,
      state: 'evicted',
    });
    await connection.db
      .update(mediaCacheObjects)
      .set({ blobSha256: stickyHash })
      .where(eq(mediaCacheObjects.id, objectId));

    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const root = await mkdtemp(join(tmpdir(), 'koharu-ledger-sticky-conflict-'));
    const blobs = new LocalMediaBlobStore(root);
    await blobs.initialize();
    const publish = vi.spyOn(blobs, 'publish');
    const leaseToken = randomUUID();
    const worker = new MediaCacheWorker({
      blobStore: blobs,
      discovery: {
        discoverBatch: async () => ({
          cursor: null,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        }),
      },
      ledger: repository,
      leaseOwner: 'integration-sticky-conflict',
      randomUuid: () => leaseToken,
      source: {
        open: async () => ({
          declaredBytes: BigInt(JPEG_FIXTURE.byteLength),
          stream: byteStream(JPEG_FIXTURE),
        }),
      },
      work: {
        ensureThumbnailObjects: async () => 0,
        listExpiredPostPlanIds: async () => [],
        listRunnablePostPlanIds: async () => [fixture.planId],
        loadClaimedOriginals: async () => [
          {
            kind: 'photo',
            objectId,
            position: 0,
            sources: [{ fileId: 'changed-bytes' }],
          },
        ],
      },
    });

    try {
      await expect(worker.runOnce()).resolves.toMatchObject({
        completedPlans: 0,
        failedPlans: 1,
      });
      expect(publish).not.toHaveBeenCalled();
      await expect(blobs.recoverLease({ leaseToken, planId: fixture.planId })).resolves.toEqual([]);

      const [plan] = await connection.db
        .select()
        .from(mediaCachePostPlans)
        .where(eq(mediaCachePostPlans.id, fixture.planId));
      expect(plan).toMatchObject({
        attemptCount: 1,
        lastErrorClass: 'integrity',
        lastErrorCode: 'sticky_hash_conflict',
        leaseToken: null,
        reasonCode: 'integrity_conflict',
        reservedOriginalBytes: 0n,
        state: 'blocked',
      });
      const [object] = await connection.db
        .select()
        .from(mediaCacheObjects)
        .where(eq(mediaCacheObjects.id, objectId));
      expect(object).toMatchObject({
        attemptCount: 1,
        blobSha256: stickyHash,
        lastErrorClass: 'integrity',
        lastErrorCode: 'sticky_hash_conflict',
        leaseToken: null,
        reasonCode: 'integrity_conflict',
        reservedBytes: 0n,
        state: 'integrity_conflict',
      });
      const [runtime] = await connection.db.select().from(mediaCacheRuntime);
      expect(runtime).toMatchObject({ readyBytes: 0n, reservedBytes: 0n });
      await expect(
        new PostgresPublicMediaObjectRepository(connection.db).findReadyObject(objectId),
      ).resolves.toBeNull();

      const admin = new PostgresMediaCacheAdminService(connection.db);
      await expect(
        admin.retry({
          initiatorId: 'owner-integration-test',
          objectId,
          reason: 'source was corrected',
        }),
      ).resolves.toMatchObject({
        objectIds: [objectId],
        planId: fixture.planId,
        state: 'retry_wait',
      });
      const [retriedObject] = await connection.db
        .select()
        .from(mediaCacheObjects)
        .where(eq(mediaCacheObjects.id, objectId));
      expect(retriedObject).toMatchObject({
        attemptCount: 0,
        blobSha256: stickyHash,
        lastErrorCode: null,
        reasonCode: null,
        state: 'retry_wait',
      });
      const [retryAction] = await connection.db
        .select()
        .from(mediaCacheActions)
        .where(eq(mediaCacheActions.objectId, objectId));
      expect(retryAction).toMatchObject({
        actionKind: 'retry',
        initiatorId: 'owner-integration-test',
        initiatorKind: 'owner_session',
        reason: 'source was corrected',
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('skips one permanently unavailable original while preserving all-or-nothing publication for the rest', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 21, ['photo', 'photo']);
    const repository = new PostgresMediaCacheLedgerRepository(connection.db);
    const leaseToken = randomUUID();
    await repository.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-1',
      leaseToken,
      planId: fixture.planId,
    });
    let cleanupCompleted = false;

    await expect(
      repository.skipClaimedObject({
        cleanup: async () => {
          cleanupCompleted = true;
        },
        leaseToken,
        objectId: fixture.objectIds[0] ?? '',
        planId: fixture.planId,
        reasonCode: 'unsupported_content',
      }),
    ).resolves.toBe(true);
    expect(cleanupCompleted).toBe(true);

    await expect(
      repository.recordPublishedObjects({
        leaseToken,
        objects: [publishedObject(fixture.objectIds[1] ?? '', '5', 1n * MIB, 'image/jpeg')],
        planId: fixture.planId,
        publish: async () => undefined,
      }),
    ).resolves.toMatchObject({ physicalBytesAdded: 1n * MIB });
    await expect(
      repository.completeSettlement({ leaseToken, planId: fixture.planId }),
    ).resolves.toMatchObject({ logicalReadyBytes: 1n * MIB });

    const objects = await connection.db
      .select({
        id: mediaCacheObjects.id,
        reasonCode: mediaCacheObjects.reasonCode,
        state: mediaCacheObjects.state,
      })
      .from(mediaCacheObjects);
    expect(objects).toEqual(
      expect.arrayContaining([
        {
          id: fixture.objectIds[0],
          reasonCode: 'unsupported_content',
          state: 'skipped',
        },
        { id: fixture.objectIds[1], reasonCode: null, state: 'ready' },
      ]),
    );
  });

  it('reserves, publishes, deduplicates, and settles thumbnail bytes independently from original post bytes', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createPlanFixture(connection, 22, ['photo']);
    const originals = new PostgresMediaCacheLedgerRepository(connection.db);
    const originalToken = randomUUID();
    await originals.claimPostPlan({
      leaseExpiresAt: leaseExpiry(),
      leaseOwner: 'worker-original',
      leaseToken: originalToken,
      planId: fixture.planId,
    });
    await originals.recordPublishedObjects({
      leaseToken: originalToken,
      objects: [publishedObject(fixture.objectIds[0] ?? '', '7', 1n * MIB, 'image/jpeg')],
      planId: fixture.planId,
      publish: async () => undefined,
    });
    await originals.completeSettlement({ leaseToken: originalToken, planId: fixture.planId });

    const work = new PostgresMediaCacheWorkerRepository(connection.db);
    await expect(work.ensureThumbnailObjects(fixture.planId)).resolves.toBe(1);
    const [thumbnailId] = await work.listRunnableThumbnailObjectIds();
    if (!thumbnailId) {
      throw new Error('Thumbnail job was not created');
    }
    const thumbnails = new PostgresMediaCacheThumbnailLedgerRepository(connection.db);
    const thumbnailToken = randomUUID();
    await expect(
      thumbnails.claim({
        leaseExpiresAt: leaseExpiry(),
        leaseOwner: 'worker-thumbnail',
        leaseToken: thumbnailToken,
        objectId: thumbnailId,
      }),
    ).resolves.toMatchObject({
      objectId: thumbnailId,
      original: {
        byteLength: 1n * MIB,
        detectedMime: 'image/jpeg',
        sha256: '7'.repeat(64),
      },
      planId: fixture.planId,
    });
    const thumbnailSha = '8'.repeat(64);
    await thumbnails.recordPublished({
      leaseToken: thumbnailToken,
      object: {
        byteLength: 500n,
        detectedMime: 'image/webp',
        objectId: thumbnailId,
        relativeKey: `blobs/88/88/${thumbnailSha}`,
        sha256: thumbnailSha,
      },
      publish: async () => undefined,
    });
    const [duringSettlement] = await connection.db.select().from(mediaCacheRuntime);
    expect(duringSettlement).toMatchObject({
      readyBytes: 1n * MIB + 500n,
      reservedBytes: 1n * MIB,
    });

    await thumbnails.complete({ leaseToken: thumbnailToken, objectId: thumbnailId });
    const [runtime] = await connection.db.select().from(mediaCacheRuntime);
    expect(runtime).toMatchObject({
      readyBytes: 1n * MIB + 500n,
      reservedBytes: 0n,
    });
    const [plan] = await connection.db
      .select()
      .from(mediaCachePostPlans)
      .where(eq(mediaCachePostPlans.id, fixture.planId));
    expect(plan).toMatchObject({ readyOriginalBytes: 1n * MIB, state: 'ready' });
  });
});
