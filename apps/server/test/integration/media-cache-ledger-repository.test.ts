import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
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
  MEDIA_CACHE_ADVISORY_LOCK,
  PostgresMediaCacheLedgerRepository,
} from '../../src/media-cache/ledger-repository.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const MIB = 1024n * 1024n;

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
});
