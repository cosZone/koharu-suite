import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getTableName, sql } from 'drizzle-orm';
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
  messageSourceMediaObservations,
  messageSourceObservations,
  messages,
  telegramChannels,
} from '../../src/db/schema.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';

async function createMediaFixture(connection: DatabaseConnection, sequence: number) {
  const [channel] = await connection.db
    .insert(telegramChannels)
    .values({
      telegramChatId: -1_002_000_000_000n - BigInt(sequence),
      title: `Media Cache Fixture ${sequence}`,
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

  const [media] = await connection.db
    .insert(messageMedia)
    .values({
      kind: 'photo',
      position: 0,
      revisionId: revision.id,
      sourceKind: 'telegram_bot_update',
      telegramFileId: `file-${sequence}`,
      telegramFileUniqueId: `unique-${sequence}`,
    })
    .returning({ id: messageMedia.id });
  if (!media) {
    throw new Error('Fixture media was not created');
  }

  return {
    channelId: channel.id,
    mediaId: media.id,
    messageId: message.id,
    revisionId: revision.id,
  };
}

async function createDesktopEvidence(
  connection: DatabaseConnection,
  fixture: Awaited<ReturnType<typeof createMediaFixture>>,
  sequence: number,
  options: {
    availability?: 'available' | 'exceeds_maximum_size' | 'not_included' | 'unavailable';
    mediaKind?: 'animation' | 'audio' | 'document' | 'photo' | 'video' | 'voice';
    position?: number;
    resolution?: 'conflict' | 'created' | 'matched' | 'stale';
  } = {},
) {
  const availability = options.availability ?? 'available';
  const [observation] = await connection.db
    .insert(messageSourceObservations)
    .values({
      channelId: fixture.channelId,
      contentFingerprint: `fingerprint-${sequence}`,
      contentFingerprintVersion: 1,
      messageId: fixture.messageId,
      rawJson: {},
      resolution: options.resolution ?? 'matched',
      revisionId: fixture.revisionId,
      sourceKey: `desktop:${sequence}`,
      sourceKind: 'telegram_desktop_json',
      telegramMessageId: BigInt(sequence),
    })
    .returning({ id: messageSourceObservations.id });
  if (!observation) {
    throw new Error('Fixture observation was not created');
  }

  const [mediaObservation] = await connection.db
    .insert(messageSourceMediaObservations)
    .values({
      availability,
      desktopSourcePath: availability === 'available' ? `photos/photo-${sequence}.jpg` : null,
      mediaKind: options.mediaKind ?? 'photo',
      observationId: observation.id,
      position: options.position ?? 0,
      sourceKind: 'telegram_desktop_json',
    })
    .returning({ id: messageSourceMediaObservations.id });
  if (!mediaObservation) {
    throw new Error('Fixture media observation was not created');
  }
  return mediaObservation.id;
}

describe('G2.3 media cache schema', () => {
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

  it('installs the complete cache state and ledger schema on PostgreSQL 18', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const [result] = await connection.db.execute<{
      tables: string[];
    }>(sql`
      select array_agg(table_name order by table_name) as tables
      from information_schema.tables
      where table_schema = 'public'
        and table_name like 'media_cache_%'
    `);

    expect(result?.tables).toEqual(
      [
        mediaCacheActions,
        mediaCacheBlobs,
        mediaCacheObjects,
        mediaCacheObjectSources,
        mediaCachePostPlans,
        mediaCacheRuntime,
      ]
        .map(getTableName)
        .sort(),
    );
  });

  it('keeps settling bytes conservatively double-counted and refuses new admission', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    await expect(
      connection.db.insert(mediaCacheRuntime).values({
        maxBytes: 100n,
        readyBytes: 90n,
        reservedBytes: 20n,
      }),
    ).resolves.toBeDefined();

    const admitted = await connection.db.execute<{ singletonKey: string }>(sql`
      update ${mediaCacheRuntime}
      set reserved_bytes = reserved_bytes + 1
      where singleton_key = 'local'
        and ready_bytes + reserved_bytes + 1 <= max_bytes
      returning singleton_key as "singletonKey"
    `);

    expect(admitted).toHaveLength(0);
  });

  it('caps each global ledger counter at 5 GiB without capping their settling sum', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const fiveGiB = 5n * 1024n * 1024n * 1024n;
    await expect(
      connection.db.insert(mediaCacheRuntime).values({
        maxBytes: fiveGiB,
        readyBytes: fiveGiB,
        reservedBytes: fiveGiB,
      }),
    ).resolves.toBeDefined();

    await expect(
      connection.db.execute(sql`
        update ${mediaCacheRuntime}
        set ready_bytes = ${fiveGiB + 1n}
        where singleton_key = 'local'
      `),
    ).rejects.toThrow();
    await expect(
      connection.db.execute(sql`
        update ${mediaCacheRuntime}
        set reserved_bytes = ${fiveGiB + 1n}
        where singleton_key = 'local'
      `),
    ).rejects.toThrow();
  });

  it('binds every post plan to the matching canonical message revision', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const first = await createMediaFixture(connection, 1);
    const second = await createMediaFixture(connection, 2);

    await expect(
      connection.db.insert(mediaCachePostPlans).values({
        messageId: first.messageId,
        revisionId: first.revisionId,
      }),
    ).resolves.toBeDefined();

    await expect(
      connection.db.insert(mediaCachePostPlans).values({
        messageId: second.messageId,
        revisionId: first.revisionId,
      }),
    ).rejects.toThrow();
  });

  it('requires fenced leases for active plan states and caps each post ledger at 50 MiB', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const settling = await createMediaFixture(connection, 3);
    const missingLease = await createMediaFixture(connection, 4);
    const overBudget = await createMediaFixture(connection, 5);

    await expect(
      connection.db.insert(mediaCachePostPlans).values({
        leaseExpiresAt: new Date('2026-07-24T00:05:00.000Z'),
        leaseOwner: 'worker-1',
        leaseToken: randomUUID(),
        messageId: settling.messageId,
        readyOriginalBytes: 0n,
        reservedOriginalBytes: 50n * 1024n * 1024n,
        revisionId: settling.revisionId,
        state: 'settling',
      }),
    ).resolves.toBeDefined();

    await expect(
      connection.db.insert(mediaCachePostPlans).values({
        messageId: missingLease.messageId,
        revisionId: missingLease.revisionId,
        state: 'settling',
      }),
    ).rejects.toThrow();

    await expect(
      connection.db.insert(mediaCachePostPlans).values({
        messageId: overBudget.messageId,
        readyOriginalBytes: 50n * 1024n * 1024n,
        reservedOriginalBytes: 1n,
        revisionId: overBudget.revisionId,
      }),
    ).rejects.toThrow();
  });

  it('persists Desktop waiting and object integrity conflicts without an active lease', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const fixture = await createMediaFixture(connection, 13);
    const [plan] = await connection.db
      .insert(mediaCachePostPlans)
      .values({
        messageId: fixture.messageId,
        revisionId: fixture.revisionId,
        state: 'awaiting_local_source',
      })
      .returning({ id: mediaCachePostPlans.id });
    if (!plan) {
      throw new Error('Fixture plan was not created');
    }

    await expect(
      connection.db.insert(mediaCacheObjects).values({
        canonicalMediaId: fixture.mediaId,
        postPlanId: plan.id,
        reasonCode: 'integrity_conflict',
        recipeVersion: 1,
        revisionId: fixture.revisionId,
        state: 'integrity_conflict',
        variant: 'original',
      }),
    ).resolves.toBeDefined();
  });

  it('binds cache objects to one plan revision and its canonical media', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const first = await createMediaFixture(connection, 6);
    const second = await createMediaFixture(connection, 7);
    const [firstPlan] = await connection.db
      .insert(mediaCachePostPlans)
      .values({
        messageId: first.messageId,
        revisionId: first.revisionId,
      })
      .returning({ id: mediaCachePostPlans.id });
    if (!firstPlan) {
      throw new Error('Fixture plan was not created');
    }

    await expect(
      connection.db.insert(mediaCacheObjects).values({
        canonicalMediaId: first.mediaId,
        postPlanId: firstPlan.id,
        recipeVersion: 1,
        revisionId: first.revisionId,
        variant: 'original',
      }),
    ).resolves.toBeDefined();

    await expect(
      connection.db.insert(mediaCacheObjects).values({
        canonicalMediaId: second.mediaId,
        postPlanId: firstPlan.id,
        recipeVersion: 1,
        revisionId: first.revisionId,
        variant: 'original',
      }),
    ).rejects.toThrow();
    await expect(
      connection.db.insert(mediaCacheObjects).values({
        canonicalMediaId: second.mediaId,
        postPlanId: firstPlan.id,
        recipeVersion: 1,
        revisionId: second.revisionId,
        variant: 'original',
      }),
    ).rejects.toThrow();
  });

  it('accepts only canonical blobs and fences the two-phase deleting state', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const readyHash = 'a'.repeat(64);
    await expect(
      connection.db.insert(mediaCacheBlobs).values({
        byteLength: 128n,
        detectedMime: 'image/jpeg',
        relativeKey: `blobs/aa/aa/${readyHash}`,
        sha256: readyHash,
        state: 'ready',
      }),
    ).resolves.toBeDefined();

    const deletingHash = 'b'.repeat(64);
    await expect(
      connection.db.insert(mediaCacheBlobs).values({
        byteLength: 256n,
        detectedMime: 'video/mp4',
        evictionExpiresAt: new Date('2026-07-24T00:05:00.000Z'),
        evictionOwner: 'worker-1',
        evictionToken: randomUUID(),
        relativeKey: `blobs/bb/bb/${deletingHash}`,
        sha256: deletingHash,
        state: 'deleting',
      }),
    ).resolves.toBeDefined();

    const wrongKeyHash = 'c'.repeat(64);
    await expect(
      connection.db.insert(mediaCacheBlobs).values({
        byteLength: 128n,
        detectedMime: 'image/png',
        relativeKey: `blobs/cc/cc/${readyHash}`,
        sha256: wrongKeyHash,
        state: 'ready',
      }),
    ).rejects.toThrow();

    const unfencedHash = 'd'.repeat(64);
    await expect(
      connection.db.insert(mediaCacheBlobs).values({
        byteLength: 128n,
        detectedMime: 'image/webp',
        relativeKey: `blobs/dd/dd/${unfencedHash}`,
        sha256: unfencedHash,
        state: 'deleting',
      }),
    ).rejects.toThrow();
  });

  it('keeps a public media object bound to its first blob hash', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const fixture = await createMediaFixture(connection, 8);
    const [plan] = await connection.db
      .insert(mediaCachePostPlans)
      .values({
        messageId: fixture.messageId,
        readyOriginalBytes: 128n,
        revisionId: fixture.revisionId,
        state: 'ready',
      })
      .returning({ id: mediaCachePostPlans.id });
    if (!plan) {
      throw new Error('Fixture plan was not created');
    }

    const firstHash = 'e'.repeat(64);
    const secondHash = 'f'.repeat(64);
    await connection.db.insert(mediaCacheBlobs).values([
      {
        byteLength: 128n,
        detectedMime: 'image/jpeg',
        relativeKey: `blobs/ee/ee/${firstHash}`,
        sha256: firstHash,
        state: 'ready',
      },
      {
        byteLength: 128n,
        detectedMime: 'image/jpeg',
        relativeKey: `blobs/ff/ff/${secondHash}`,
        sha256: secondHash,
        state: 'ready',
      },
    ]);
    const [object] = await connection.db
      .insert(mediaCacheObjects)
      .values({
        actualBytes: 128n,
        blobSha256: firstHash,
        canonicalMediaId: fixture.mediaId,
        postPlanId: plan.id,
        recipeVersion: 1,
        revisionId: fixture.revisionId,
        state: 'ready',
        variant: 'original',
      })
      .returning({ id: mediaCacheObjects.id });
    if (!object) {
      throw new Error('Fixture object was not created');
    }

    await expect(
      connection.db.execute(sql`
        update ${mediaCacheObjects}
        set blob_sha256 = ${secondHash}
        where id = ${object.id}
      `),
    ).rejects.toThrow();
  });

  it('keeps every public media object identity field immutable', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const database = connection.db;
    const first = await createMediaFixture(connection, 21);
    const second = await createMediaFixture(connection, 22);
    const [firstPlan, secondPlan] = await Promise.all(
      [first, second].map(async (fixture) => {
        const [plan] = await database
          .insert(mediaCachePostPlans)
          .values({
            messageId: fixture.messageId,
            revisionId: fixture.revisionId,
          })
          .returning({ id: mediaCachePostPlans.id });
        return plan;
      }),
    );
    if (!firstPlan || !secondPlan) {
      throw new Error('Fixture plans were not created');
    }

    const [object] = await connection.db
      .insert(mediaCacheObjects)
      .values({
        canonicalMediaId: first.mediaId,
        postPlanId: firstPlan.id,
        recipeVersion: 1,
        revisionId: first.revisionId,
        variant: 'original',
      })
      .returning({ id: mediaCacheObjects.id });
    if (!object) {
      throw new Error('Fixture object was not created');
    }

    await expect(
      connection.db.execute(sql`
        update ${mediaCacheObjects}
        set post_plan_id = ${secondPlan.id},
          revision_id = ${second.revisionId},
          canonical_media_id = ${second.mediaId}
        where id = ${object.id}
      `),
    ).rejects.toThrow();
    await expect(
      connection.db.execute(sql`
        update ${mediaCacheObjects}
        set variant = 'thumbnail',
          recipe_version = 2
        where id = ${object.id}
      `),
    ).rejects.toThrow();
  });

  it('keeps content-addressed blob identity metadata immutable', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const hash = '1'.repeat(64);
    await connection.db.insert(mediaCacheBlobs).values({
      byteLength: 128n,
      detectedMime: 'image/jpeg',
      relativeKey: `blobs/11/11/${hash}`,
      sha256: hash,
      state: 'ready',
    });

    for (const assignment of [
      sql`byte_length = 129`,
      sql`detected_mime = 'image/png'`,
      sql`relative_key = ${`blobs/11/11/${'2'.repeat(64)}`}`,
    ]) {
      await expect(
        connection.db.execute(sql`
          update ${mediaCacheBlobs}
          set ${assignment}
          where sha256 = ${hash}
        `),
      ).rejects.toThrow();
    }
  });

  it('enforces immutable recipe identity, ready bindings, and per-variant reservations', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const database = connection.db;
    const original = await createMediaFixture(connection, 9);
    const thumbnail = await createMediaFixture(connection, 10);
    const [originalPlan, thumbnailPlan] = await Promise.all(
      [original, thumbnail].map(async (fixture) => {
        const [plan] = await database
          .insert(mediaCachePostPlans)
          .values({
            messageId: fixture.messageId,
            revisionId: fixture.revisionId,
          })
          .returning({ id: mediaCachePostPlans.id });
        return plan;
      }),
    );
    if (!originalPlan || !thumbnailPlan) {
      throw new Error('Fixture plans were not created');
    }

    await expect(
      connection.db.insert(mediaCacheObjects).values({
        canonicalMediaId: original.mediaId,
        postPlanId: originalPlan.id,
        recipeVersion: 2,
        revisionId: original.revisionId,
        variant: 'original',
      }),
    ).rejects.toThrow();

    await expect(
      connection.db.insert(mediaCacheObjects).values({
        canonicalMediaId: original.mediaId,
        postPlanId: originalPlan.id,
        recipeVersion: 1,
        revisionId: original.revisionId,
        state: 'ready',
        variant: 'original',
      }),
    ).rejects.toThrow();

    await expect(
      connection.db.insert(mediaCacheObjects).values({
        canonicalMediaId: thumbnail.mediaId,
        postPlanId: thumbnailPlan.id,
        recipeVersion: 1,
        reservedBytes: 1_048_577n,
        revisionId: thumbnail.revisionId,
        variant: 'thumbnail',
      }),
    ).rejects.toThrow();
  });

  it('requires object leases exactly while reserved, downloading, or staging', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const databaseConnection = connection;
    const database = databaseConnection.db;
    const fixtures = await Promise.all(
      [23, 24, 25].map((sequence) => createMediaFixture(databaseConnection, sequence)),
    );
    const plans = await Promise.all(
      fixtures.map(async (fixture) => {
        const [plan] = await database
          .insert(mediaCachePostPlans)
          .values({
            messageId: fixture.messageId,
            revisionId: fixture.revisionId,
          })
          .returning({ id: mediaCachePostPlans.id });
        return plan;
      }),
    );
    const [missingLeaseFixture, validLeaseFixture, staleLeaseFixture] = fixtures;
    const [missingLeasePlan, validLeasePlan, staleLeasePlan] = plans;
    if (
      !missingLeaseFixture ||
      !validLeaseFixture ||
      !staleLeaseFixture ||
      !missingLeasePlan ||
      !validLeasePlan ||
      !staleLeasePlan
    ) {
      throw new Error('Fixture plans were not created');
    }

    await expect(
      connection.db.insert(mediaCacheObjects).values({
        canonicalMediaId: missingLeaseFixture.mediaId,
        postPlanId: missingLeasePlan.id,
        recipeVersion: 1,
        revisionId: missingLeaseFixture.revisionId,
        state: 'reserved',
        variant: 'original',
      }),
    ).rejects.toThrow();

    await expect(
      connection.db.insert(mediaCacheObjects).values({
        canonicalMediaId: validLeaseFixture.mediaId,
        leaseExpiresAt: new Date('2026-07-24T00:05:00.000Z'),
        leaseOwner: 'worker-1',
        leaseToken: randomUUID(),
        postPlanId: validLeasePlan.id,
        recipeVersion: 1,
        revisionId: validLeaseFixture.revisionId,
        state: 'staging',
        variant: 'original',
      }),
    ).resolves.toBeDefined();

    await expect(
      connection.db.insert(mediaCacheObjects).values({
        canonicalMediaId: staleLeaseFixture.mediaId,
        leaseExpiresAt: new Date('2026-07-24T00:05:00.000Z'),
        leaseOwner: 'worker-1',
        leaseToken: randomUUID(),
        postPlanId: staleLeasePlan.id,
        recipeVersion: 1,
        revisionId: staleLeaseFixture.revisionId,
        state: 'discovered',
        variant: 'original',
      }),
    ).rejects.toThrow();
  });

  it('orders source evidence explicitly and preserves it with restrictive lineage', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const fixture = await createMediaFixture(connection, 11);
    const firstEvidenceId = await createDesktopEvidence(connection, fixture, 11);
    const secondEvidenceId = await createDesktopEvidence(connection, fixture, 12);
    const [plan] = await connection.db
      .insert(mediaCachePostPlans)
      .values({
        messageId: fixture.messageId,
        revisionId: fixture.revisionId,
      })
      .returning({ id: mediaCachePostPlans.id });
    if (!plan) {
      throw new Error('Fixture plan was not created');
    }
    const [object] = await connection.db
      .insert(mediaCacheObjects)
      .values({
        canonicalMediaId: fixture.mediaId,
        postPlanId: plan.id,
        recipeVersion: 1,
        revisionId: fixture.revisionId,
        variant: 'original',
      })
      .returning({ id: mediaCacheObjects.id });
    if (!object) {
      throw new Error('Fixture object was not created');
    }

    await expect(
      connection.db.insert(mediaCacheObjectSources).values({
        objectId: object.id,
        sourceMediaObservationId: firstEvidenceId,
        sourcePriority: 0,
      }),
    ).resolves.toBeDefined();
    await expect(
      connection.db.insert(mediaCacheObjectSources).values({
        objectId: object.id,
        sourceMediaObservationId: secondEvidenceId,
        sourcePriority: -1,
      }),
    ).rejects.toThrow();
    await expect(
      connection.db.execute(sql`
        delete from ${messageSourceMediaObservations}
        where id = ${firstEvidenceId}
      `),
    ).rejects.toThrow();
  });

  it('maps only current matching available source evidence to a cache object', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const fixture = await createMediaFixture(connection, 14);
    const foreignFixture = await createMediaFixture(connection, 15);
    const [plan] = await connection.db
      .insert(mediaCachePostPlans)
      .values({
        messageId: fixture.messageId,
        revisionId: fixture.revisionId,
      })
      .returning({ id: mediaCachePostPlans.id });
    if (!plan) {
      throw new Error('Fixture plan was not created');
    }
    const [object] = await connection.db
      .insert(mediaCacheObjects)
      .values({
        canonicalMediaId: fixture.mediaId,
        postPlanId: plan.id,
        recipeVersion: 1,
        revisionId: fixture.revisionId,
        variant: 'original',
      })
      .returning({ id: mediaCacheObjects.id });
    if (!object) {
      throw new Error('Fixture object was not created');
    }

    const validEvidence = await createDesktopEvidence(connection, fixture, 14);
    await expect(
      connection.db.insert(mediaCacheObjectSources).values({
        objectId: object.id,
        sourceMediaObservationId: validEvidence,
        sourcePriority: 0,
      }),
    ).resolves.toBeDefined();

    for (const sourceMediaObservationId of [
      await createDesktopEvidence(connection, foreignFixture, 15),
      await createDesktopEvidence(connection, fixture, 16, { resolution: 'stale' }),
      await createDesktopEvidence(connection, fixture, 17, { mediaKind: 'video' }),
      await createDesktopEvidence(connection, fixture, 18, { availability: 'unavailable' }),
      await createDesktopEvidence(connection, fixture, 26, { position: 1 }),
    ]) {
      await expect(
        connection.db.insert(mediaCacheObjectSources).values({
          objectId: object.id,
          sourceMediaObservationId,
          sourcePriority: 1,
        }),
      ).rejects.toThrow();
    }

    const nonCurrentEvidence = await createDesktopEvidence(connection, fixture, 19);
    await connection.db.execute(sql`
      update ${messages}
      set current_revision_number = 2
      where id = ${fixture.messageId}
    `);
    await expect(
      connection.db.insert(mediaCacheObjectSources).values({
        objectId: object.id,
        sourceMediaObservationId: nonCurrentEvidence,
        sourcePriority: 1,
      }),
    ).rejects.toThrow();

    const tombstonedEvidence = await createDesktopEvidence(connection, fixture, 20);
    await connection.db.execute(sql`
      update ${messages}
      set current_revision_number = 1,
        tombstoned_at = now()
      where id = ${fixture.messageId}
    `);
    await expect(
      connection.db.insert(mediaCacheObjectSources).values({
        objectId: object.id,
        sourceMediaObservationId: tombstonedEvidence,
        sourcePriority: 1,
      }),
    ).rejects.toThrow();
  });

  it('requires operator reasons and keeps service tokens out of cache mutations', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    await expect(
      connection.db.insert(mediaCacheActions).values({
        actionKind: 'reconcile',
        initiatorKind: 'worker',
      }),
    ).resolves.toBeDefined();
    await expect(
      connection.db.insert(mediaCacheActions).values({
        actionKind: 'reconcile',
        initiatorKind: 'owner_session',
        reason: '   ',
      }),
    ).rejects.toThrow();
    await expect(
      connection.db.execute(sql`
        insert into ${mediaCacheActions} (
          action_kind,
          initiator_kind,
          reason
        ) values (
          'evict',
          'service_token',
          'must not mutate cache'
        )
      `),
    ).rejects.toThrow();
  });

  it('indexes the settling pin exclusion and deterministic LRU query paths', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const indexes = await connection.db.execute<{ indexName: string }>(sql`
      select indexname as "indexName"
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'media_cache_actions_created_idx',
          'media_cache_blobs_lru_idx',
          'media_cache_blobs_state_idx',
          'media_cache_objects_blob_plan_idx',
          'media_cache_objects_plan_state_idx',
          'media_cache_objects_state_updated_idx',
          'message_source_media_observations_discovery_idx',
          'media_cache_post_plans_state_idx'
        )
      order by indexname
    `);

    expect(indexes.map(({ indexName }) => indexName)).toEqual([
      'media_cache_actions_created_idx',
      'media_cache_blobs_lru_idx',
      'media_cache_blobs_state_idx',
      'media_cache_objects_blob_plan_idx',
      'media_cache_objects_plan_state_idx',
      'media_cache_objects_state_updated_idx',
      'media_cache_post_plans_state_idx',
      'message_source_media_observations_discovery_idx',
    ]);
  });
});
