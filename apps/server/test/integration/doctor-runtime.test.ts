import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  mediaCacheBlobs,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  messageMedia,
  messageRevisions,
  messages,
  telegramChannels,
} from '../../src/db/schema.js';
import { EXPECTED_DATABASE_OBJECTS } from '../../src/ops/doctor.js';
import { PostgresDoctorDiagnostics } from '../../src/ops/doctor-runtime.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';

describe('PostgreSQL doctor diagnostics', () => {
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

  it('recognizes PostgreSQL 18 and every expected migrated schema object', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const diagnostics = new PostgresDoctorDiagnostics(connection.db);

    await expect(diagnostics.getPostgresMajorVersion()).resolves.toBe(18);
    await expect(diagnostics.listMissingSchemaObjects(EXPECTED_DATABASE_OBJECTS)).resolves.toEqual(
      [],
    );
    await expect(diagnostics.getBoundTelegramBotId()).resolves.toBeNull();
    await expect(diagnostics.listOwners()).resolves.toEqual([]);
    await expect(diagnostics.listEnabledChannels()).resolves.toEqual([]);
    await expect(diagnostics.getMediaCacheLedgerSnapshot()).resolves.toEqual({
      activeThumbnailReservationCount: 0n,
      activeThumbnailReservedBytes: 0n,
      cacheRowCount: 0n,
      originalReservationCount: 0n,
      originalReservedBytes: 0n,
      physicalBlobBytes: 0n,
      physicalBlobCount: 0n,
      runtimeMaxBytes: null,
      runtimeReadyBytes: null,
      runtimeReservedBytes: null,
      runtimeRowCount: 0n,
    });
  });

  it('recomputes physical and reservation counters without repairing drift', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const [channel] = await connection.db
      .insert(telegramChannels)
      .values({ telegramChatId: -1_002_234_260_754n, title: 'Doctor ledger fixture' })
      .returning({ id: telegramChannels.id });
    if (!channel) {
      throw new Error('Fixture channel was not created');
    }
    const [message] = await connection.db
      .insert(messages)
      .values({
        channelId: channel.id,
        publishedAt: new Date('2026-07-24T00:00:00.000Z'),
        telegramMessageId: 1n,
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
        telegramFileId: 'doctor-file',
        telegramFileUniqueId: 'doctor-unique',
      })
      .returning({ id: messageMedia.id });
    if (!media) {
      throw new Error('Fixture media was not created');
    }

    const leaseToken = 'c9f35d58-8a0c-4fd3-abef-cd4d27f38aa8';
    const leaseExpiresAt = new Date('2026-07-25T00:00:00.000Z');
    const [plan] = await connection.db
      .insert(mediaCachePostPlans)
      .values({
        leaseExpiresAt,
        leaseOwner: 'doctor-fixture',
        leaseToken,
        messageId: message.id,
        reservedOriginalBytes: 10n,
        revisionId: revision.id,
        state: 'staging',
      })
      .returning({ id: mediaCachePostPlans.id });
    if (!plan) {
      throw new Error('Fixture plan was not created');
    }
    await connection.db.insert(mediaCacheObjects).values([
      {
        canonicalMediaId: media.id,
        leaseExpiresAt,
        leaseOwner: 'doctor-fixture',
        leaseToken,
        postPlanId: plan.id,
        recipeVersion: 1,
        reservedBytes: 10n,
        revisionId: revision.id,
        state: 'downloading',
        variant: 'original',
      },
      {
        canonicalMediaId: media.id,
        leaseExpiresAt,
        leaseOwner: 'doctor-fixture',
        leaseToken,
        postPlanId: plan.id,
        recipeVersion: 1,
        reservedBytes: 1n,
        revisionId: revision.id,
        state: 'downloading',
        variant: 'thumbnail',
      },
    ]);
    await connection.db.insert(mediaCacheBlobs).values([
      {
        byteLength: 10n,
        detectedMime: 'image/jpeg',
        relativeKey: `blobs/aa/aa/${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        state: 'ready',
      },
      {
        byteLength: 20n,
        detectedMime: 'image/jpeg',
        evictionExpiresAt: new Date('2026-07-25T00:00:00.000Z'),
        evictionOwner: 'doctor-fixture',
        evictionToken: '70df9914-28bc-4538-bb91-135673abf63c',
        relativeKey: `blobs/bb/bb/${'b'.repeat(64)}`,
        sha256: 'b'.repeat(64),
        state: 'deleting',
      },
      {
        byteLength: 40n,
        detectedMime: 'image/jpeg',
        relativeKey: `blobs/cc/cc/${'c'.repeat(64)}`,
        sha256: 'c'.repeat(64),
        state: 'evicted',
      },
    ]);
    await connection.db.insert(mediaCacheRuntime).values({
      readyBytes: 30n,
      reservedBytes: 11n,
    });

    const diagnostics = new PostgresDoctorDiagnostics(connection.db);
    await expect(diagnostics.getMediaCacheLedgerSnapshot()).resolves.toMatchObject({
      activeThumbnailReservationCount: 1n,
      activeThumbnailReservedBytes: 1n,
      cacheRowCount: 7n,
      originalReservationCount: 1n,
      originalReservedBytes: 10n,
      physicalBlobBytes: 30n,
      physicalBlobCount: 2n,
      runtimeReadyBytes: 30n,
      runtimeReservedBytes: 11n,
      runtimeRowCount: 1n,
    });

    await connection.db
      .update(mediaCacheRuntime)
      .set({ readyBytes: 29n })
      .where(eq(mediaCacheRuntime.singletonKey, 'local'));
    await expect(diagnostics.getMediaCacheLedgerSnapshot()).resolves.toMatchObject({
      physicalBlobBytes: 30n,
      runtimeReadyBytes: 29n,
    });
    const [runtime] = await connection.db
      .select({ readyBytes: mediaCacheRuntime.readyBytes })
      .from(mediaCacheRuntime);
    expect(runtime?.readyBytes).toBe(29n);
  });
});
