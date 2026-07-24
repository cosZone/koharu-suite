import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  mediaBlobLocations,
  mediaCacheActions,
  mediaCacheBlobs,
  mediaCacheCommands,
  mediaCacheObjectProtections,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaStorageBackends,
  messageMedia,
  messageRevisions,
  messages,
  telegramChannels,
} from '../../src/db/schema.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const SHA256 = 'a'.repeat(64);
const STORAGE_KEY = `blobs/${SHA256.slice(0, 2)}/${SHA256.slice(2, 4)}/${SHA256}`;

let container: StartedPostgreSqlContainer | undefined;
let connection: DatabaseConnection | undefined;

async function insertObjectFixture(databaseConnection: DatabaseConnection) {
  const now = new Date('2026-07-24T09:00:00.000Z');
  const [channel] = await databaseConnection.db
    .insert(telegramChannels)
    .values({
      telegramChatId: -1_007_240_000_001n,
      title: 'G2.4 storage schema',
    })
    .returning({ id: telegramChannels.id });
  if (!channel) throw new Error('Fixture channel was not created');

  const [message] = await databaseConnection.db
    .insert(messages)
    .values({
      channelId: channel.id,
      publishedAt: now,
      telegramMessageId: 1n,
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
      telegramFileId: 'private-g24-file-id',
      telegramFileUniqueId: 'private-g24-unique-id',
    })
    .returning({ id: messageMedia.id });
  if (!media) throw new Error('Fixture media was not created');

  const [plan] = await databaseConnection.db
    .insert(mediaCachePostPlans)
    .values({
      messageId: message.id,
      revisionId: revision.id,
      state: 'blocked',
    })
    .returning({ id: mediaCachePostPlans.id });
  if (!plan) throw new Error('Fixture plan was not created');

  const [object] = await databaseConnection.db
    .insert(mediaCacheObjects)
    .values({
      canonicalMediaId: media.id,
      postPlanId: plan.id,
      recipeVersion: 1,
      revisionId: revision.id,
      state: 'blocked',
      variant: 'original',
    })
    .returning({
      evictedPolicy: mediaCacheObjects.evictedPolicy,
      id: mediaCacheObjects.id,
    });
  if (!object) throw new Error('Fixture object was not created');
  return object;
}

describe('G2.4 media storage schema', () => {
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
        ${mediaCacheObjectProtections},
        ${mediaCacheActions},
        ${mediaCacheCommands},
        ${mediaBlobLocations},
        ${mediaStorageBackends},
        ${mediaCacheObjects},
        ${mediaCacheBlobs},
        ${mediaCachePostPlans},
        ${telegramChannels}
      cascade
    `);
  }, 30_000);

  it('enforces backend capabilities and verified per-backend location identity', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const database = connection.db;
    const fingerprint = 'f'.repeat(64);

    await database.insert(mediaStorageBackends).values({
      configFingerprint: fingerprint,
      id: 'local',
      kind: 'local',
      label: 'Local hot cache',
      maxBytes: 5_368_709_120n,
      readPriority: 0,
      writePriority: 0,
    });
    await expect(
      database.insert(mediaStorageBackends).values({
        configFingerprint: fingerprint,
        id: 'other_local',
        kind: 'local',
        label: 'Duplicate local backend',
        maxBytes: 1_024n,
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(mediaStorageBackends).values({
        configFingerprint: fingerprint,
        id: 'over_budget_s3',
        kind: 's3',
        label: 'S3 awaiting prune',
        maxBytes: 1_024n,
        readyBytes: 2_048n,
      }),
    ).resolves.toBeDefined();
    await expect(
      database.insert(mediaStorageBackends).values({
        configFingerprint: fingerprint,
        enabled: true,
        id: 'disabled_capabilities',
        kind: 's3',
        label: 'Invalid enabled backend',
        maxBytes: 1_024n,
        readable: false,
        writable: false,
      }),
    ).rejects.toThrow();

    await database.insert(mediaCacheBlobs).values({
      byteLength: 128n,
      detectedMime: 'image/jpeg',
      relativeKey: STORAGE_KEY,
      sha256: SHA256,
      state: 'ready',
    });
    const verifiedAt = new Date('2026-07-24T09:01:00.000Z');
    await database.insert(mediaBlobLocations).values({
      backendId: 'local',
      blobSha256: SHA256,
      providerEtag: 'opaque-transport-etag',
      state: 'ready',
      storageKey: STORAGE_KEY,
      verifiedAt,
      verifiedByteLength: 128n,
      verifiedSha256: SHA256,
    });

    await expect(
      database.insert(mediaBlobLocations).values({
        backendId: 'local',
        blobSha256: SHA256,
        state: 'ready',
        storageKey: STORAGE_KEY,
      }),
    ).rejects.toThrow();
    await expect(
      database
        .update(mediaBlobLocations)
        .set({ verifiedByteLength: 129n })
        .where(
          sql`${mediaBlobLocations.backendId} = 'local' and ${mediaBlobLocations.blobSha256} = ${SHA256}`,
        ),
    ).rejects.toThrow();
    await expect(
      database
        .update(mediaBlobLocations)
        .set({ storageKey: 'operator/chosen/key' })
        .where(
          sql`${mediaBlobLocations.backendId} = 'local' and ${mediaBlobLocations.blobSha256} = ${SHA256}`,
        ),
    ).rejects.toThrow();
    await expect(
      database
        .update(mediaBlobLocations)
        .set({
          mutationExpiresAt: null,
          mutationOwner: null,
          mutationToken: null,
          state: 'deleting',
        })
        .where(
          sql`${mediaBlobLocations.backendId} = 'local' and ${mediaBlobLocations.blobSha256} = ${SHA256}`,
        ),
    ).rejects.toThrow();

    const [location] = await database
      .select({
        backendId: mediaBlobLocations.backendId,
        providerEtag: mediaBlobLocations.providerEtag,
        state: mediaBlobLocations.state,
        verifiedByteLength: mediaBlobLocations.verifiedByteLength,
      })
      .from(mediaBlobLocations)
      .where(eq(mediaBlobLocations.blobSha256, SHA256));
    expect(location).toEqual({
      backendId: 'local',
      providerEtag: 'opaque-transport-etag',
      state: 'ready',
      verifiedByteLength: 128n,
    });
  }, 30_000);

  it('defaults object recache policy and validates owner protection records', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const database = connection.db;
    const object = await insertObjectFixture(connection);
    expect(object.evictedPolicy).toBe('recache_on_access');

    await database
      .update(mediaCacheObjects)
      .set({ evictedPolicy: 'stay_evicted' })
      .where(eq(mediaCacheObjects.id, object.id));
    const protectedAt = new Date('2026-07-24T09:02:00.000Z');
    await database.insert(mediaCacheObjectProtections).values({
      expiresAt: new Date('2026-08-24T09:02:00.000Z'),
      objectId: object.id,
      ownerId: 'owner-user-id',
      ownerKind: 'owner_session',
      protectedAt,
      reason: 'Keep the shared original available',
    });
    await expect(
      database.insert(mediaCacheActions).values({
        actionKind: 'protect',
        afterState: { protected: true },
        beforeState: { protected: false },
        initiatorId: 'owner-user-id',
        initiatorKind: 'owner_session',
        objectId: object.id,
        reason: 'Keep the shared original available',
      }),
    ).resolves.toBeDefined();
    await expect(
      database.insert(mediaCacheActions).values({
        actionKind: 'set_evicted_policy',
        afterState: { evictedPolicy: 'stay_evicted' },
        beforeState: { evictedPolicy: 'recache_on_access' },
        initiatorId: 'owner-user-id',
        initiatorKind: 'owner_session',
        objectId: object.id,
        reason: 'Require explicit restore after eviction',
      }),
    ).resolves.toBeDefined();

    await expect(
      database
        .update(mediaCacheObjectProtections)
        .set({ expiresAt: protectedAt })
        .where(eq(mediaCacheObjectProtections.objectId, object.id)),
    ).rejects.toThrow();
    await expect(
      database
        .update(mediaCacheObjectProtections)
        .set({ reason: '   ' })
        .where(eq(mediaCacheObjectProtections.objectId, object.id)),
    ).rejects.toThrow();

    const [result] = await database
      .select({
        evictedPolicy: mediaCacheObjects.evictedPolicy,
        ownerId: mediaCacheObjectProtections.ownerId,
        reason: mediaCacheObjectProtections.reason,
      })
      .from(mediaCacheObjects)
      .innerJoin(
        mediaCacheObjectProtections,
        eq(mediaCacheObjectProtections.objectId, mediaCacheObjects.id),
      )
      .where(eq(mediaCacheObjects.id, object.id));
    expect(result).toEqual({
      evictedPolicy: 'stay_evicted',
      ownerId: 'owner-user-id',
      reason: 'Keep the shared original available',
    });
  }, 30_000);

  it('accepts only typed storage operation command targets', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const database = connection.db;
    const object = await insertObjectFixture(connection);
    const fingerprint = 'f'.repeat(64);
    await database.insert(mediaStorageBackends).values([
      {
        configFingerprint: fingerprint,
        id: 'local',
        kind: 'local',
        label: 'Local hot cache',
        maxBytes: 5_368_709_120n,
      },
      {
        configFingerprint: fingerprint,
        id: 's3-default',
        kind: 's3',
        label: 'S3 durable cache',
        maxBytes: 5_368_709_120n,
      },
    ]);

    await expect(
      database.insert(mediaCacheCommands).values([
        {
          initiatorId: 'owner-user-id',
          objectId: object.id,
          operation: 'migrate',
          reason: 'Copy one object to durable storage',
          sourceBackendId: 'local',
          targetBackendId: 's3-default',
        },
        {
          initiatorId: 'owner-user-id',
          objectId: object.id,
          operation: 'restore',
          reason: 'Restore the local hot copy',
          targetBackendId: 'local',
        },
        {
          initiatorId: 'owner-user-id',
          operation: 'prune',
          reason: 'Apply the reviewed S3 budget',
          targetBackendId: 's3-default',
          targetBytes: 1_024n,
        },
      ]),
    ).resolves.toBeDefined();

    await expect(
      database.insert(mediaCacheCommands).values({
        initiatorId: 'owner-user-id',
        operation: 'migrate',
        reason: 'Invalid same-backend copy',
        sourceBackendId: 'local',
        targetBackendId: 'local',
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(mediaCacheCommands).values({
        initiatorId: 'owner-user-id',
        operation: 'prune',
        reason: 'Invalid negative budget',
        targetBackendId: 's3-default',
        targetBytes: -1n,
      }),
    ).rejects.toThrow();
  }, 30_000);

  it('upgrades a populated G2.3 database before adding the verified identity FK', async () => {
    if (!container) throw new Error('PostgreSQL test container did not start');
    const databaseName = 'koharu_g24_legacy';
    const adminClient = postgres(container.getConnectionUri(), { max: 1 });
    const legacyUrl = new URL(container.getConnectionUri());
    legacyUrl.pathname = `/${databaseName}`;
    const migrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
    const legacyMigrations = await mkdtemp(join(tmpdir(), 'koharu-g24-migrations-'));

    try {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.unsafe(`create database "${databaseName}"`);
      await mkdir(join(legacyMigrations, 'meta'));
      const journal = JSON.parse(
        await readFile(join(migrationRoot, 'meta/_journal.json'), 'utf8'),
      ) as {
        dialect: string;
        entries: Array<{ idx: number; tag: string }>;
        version: string;
      };
      const legacyEntries = journal.entries.filter((entry) => entry.idx <= 12);
      for (const entry of legacyEntries) {
        await cp(
          join(migrationRoot, `${entry.tag}.sql`),
          join(legacyMigrations, `${entry.tag}.sql`),
        );
      }
      await writeFile(
        join(legacyMigrations, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries: legacyEntries }),
      );

      await runMigrations(legacyUrl.toString(), { migrationsFolder: legacyMigrations });
      const legacyClient = postgres(legacyUrl.toString(), { max: 1 });
      try {
        await legacyClient`
          insert into media_cache_blobs (
            sha256,
            byte_length,
            detected_mime,
            relative_key,
            state
          ) values (
            ${SHA256},
            ${128},
            'image/jpeg',
            ${STORAGE_KEY},
            'ready'
          )
        `;
      } finally {
        await legacyClient.end();
      }

      await runMigrations(legacyUrl.toString());
      const upgradedClient = postgres(legacyUrl.toString(), { max: 1 });
      try {
        const [result] = await upgradedClient<
          Array<{
            blobCount: string;
            compositeForeignKey: string | null;
            evictedPolicyDefault: string | null;
            locationTable: string | null;
          }>
        >`
          select
            (select count(*)::text from media_cache_blobs) as "blobCount",
            to_regclass('public.media_blob_locations')::text as "locationTable",
            (
              select column_default
              from information_schema.columns
              where table_schema = 'public'
                and table_name = 'media_cache_objects'
                and column_name = 'evicted_policy'
            ) as "evictedPolicyDefault",
            (
              select conname
              from pg_constraint
              where conname = 'media_blob_locations_verified_identity_fk'
            ) as "compositeForeignKey"
        `;
        expect(result).toEqual({
          blobCount: '1',
          compositeForeignKey: 'media_blob_locations_verified_identity_fk',
          evictedPolicyDefault: "'recache_on_access'::character varying",
          locationTable: 'media_blob_locations',
        });
      } finally {
        await upgradedClient.end();
      }
    } finally {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end();
      await rm(legacyMigrations, { force: true, recursive: true });
    }
  }, 60_000);
});
