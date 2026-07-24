import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  mediaCacheObjectSources,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  messageMedia,
  messageRevisions,
  messageSourceMediaObservations,
  messageSourceObservations,
  messages,
  telegramChannelAllowlist,
  telegramChannels,
  telegramUpdates,
} from '../../src/db/schema.js';
import {
  MediaCacheDiscoveryScopeError,
  PostgresMediaCacheDiscoveryRepository,
} from '../../src/media-cache/discovery-repository.js';
import { PostgresMediaCacheLedgerRepository } from '../../src/media-cache/ledger-repository.js';
import { PostgresMediaCacheWorkerRepository } from '../../src/media-cache/worker-repository.js';
import { lockSourceEvidenceDiscovery } from '../../src/messages/source-evidence-coordination.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const MEBIBYTE = 1024n * 1024n;

type MediaKind = 'animation' | 'photo' | 'video';
type SourceKind = 'telegram_bot_update' | 'telegram_desktop_json';

interface RevisionFixture {
  channelId: string;
  media: Array<{ id: string; kind: MediaKind; position: number }>;
  messageId: string;
  revisionId: string;
  telegramChatId: bigint;
}

let fixtureSequence = 0;

async function createRevision(
  connection: DatabaseConnection,
  media: ReadonlyArray<{ bytes?: bigint | null; kind: MediaKind; position: number }>,
  options: { currentRevisionNumber?: number; revisionNumber?: number; tombstoned?: boolean } = {},
): Promise<RevisionFixture> {
  fixtureSequence += 1;
  const telegramChatId = -1_004_000_000_000n - BigInt(fixtureSequence);
  const [channel] = await connection.db
    .insert(telegramChannels)
    .values({
      telegramChatId,
      title: `Discovery ${fixtureSequence}`,
    })
    .returning({ id: telegramChannels.id });
  if (!channel) {
    throw new Error('Fixture channel was not created');
  }

  const revisionNumber = options.revisionNumber ?? 1;
  const [message] = await connection.db
    .insert(messages)
    .values({
      channelId: channel.id,
      currentRevisionNumber: options.currentRevisionNumber ?? revisionNumber,
      publishedAt: new Date('2026-07-24T00:00:00.000Z'),
      telegramMessageId: BigInt(fixtureSequence),
      tombstonedAt: options.tombstoned ? new Date('2026-07-24T01:00:00.000Z') : null,
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
      revisionNumber,
    })
    .returning({ id: messageRevisions.id });
  if (!revision) {
    throw new Error('Fixture revision was not created');
  }

  const canonicalMedia = await connection.db
    .insert(messageMedia)
    .values(
      media.map((item) => ({
        fileSize: item.bytes ?? null,
        kind: item.kind,
        position: item.position,
        revisionId: revision.id,
        sourceKind: 'telegram_bot_update' as const,
        telegramFileId: `canonical-file-${fixtureSequence}-${item.position}`,
        telegramFileUniqueId: `canonical-unique-${fixtureSequence}-${item.position}`,
      })),
    )
    .returning({
      id: messageMedia.id,
      kind: messageMedia.kind,
      position: messageMedia.position,
    });

  return {
    channelId: channel.id,
    media: canonicalMedia as RevisionFixture['media'],
    messageId: message.id,
    revisionId: revision.id,
    telegramChatId,
  };
}

async function configureChannels(
  connection: DatabaseConnection,
  fixtures: readonly RevisionFixture[],
): Promise<void> {
  await connection.db.insert(telegramChannelAllowlist).values(
    fixtures.map((fixture) => ({
      telegramChatId: fixture.telegramChatId,
      title: `Configured ${fixture.telegramChatId}`,
    })),
  );
}

async function addEvidence(
  connection: DatabaseConnection,
  fixture: RevisionFixture,
  input: {
    availability?: 'available' | 'exceeds_maximum_size' | 'not_included' | 'unavailable';
    beforeCommit?: () => Promise<void>;
    createdAt: Date;
    id?: string;
    kind: MediaKind;
    position: number;
    resolution?: 'conflict' | 'created' | 'matched' | 'stale';
    revisionId?: string | null;
    sourceKind: SourceKind;
  },
): Promise<string> {
  fixtureSequence += 1;
  const telegramUpdateId =
    input.sourceKind === 'telegram_bot_update' ? BigInt(10_000 + fixtureSequence) : null;
  return connection.db.transaction(async (transaction) => {
    await lockSourceEvidenceDiscovery(transaction);
    if (telegramUpdateId !== null) {
      await transaction.insert(telegramUpdates).values({
        channelId: fixture.channelId,
        rawJson: { update_id: Number(telegramUpdateId) },
        telegramUpdateId,
        updateType: 'channel_post',
      });
    }

    const [observation] = await transaction
      .insert(messageSourceObservations)
      .values({
        channelId: fixture.channelId,
        contentFingerprint: `fingerprint-${fixtureSequence}`,
        contentFingerprintVersion: 1,
        messageId: fixture.messageId,
        rawJson: {},
        resolution: input.resolution ?? 'matched',
        revisionId: input.revisionId === undefined ? fixture.revisionId : input.revisionId,
        sourceKey: `${input.sourceKind}:${fixtureSequence}`,
        sourceKind: input.sourceKind,
        telegramMessageId: BigInt(fixtureSequence),
        telegramUpdateId,
      })
      .returning({ id: messageSourceObservations.id });
    if (!observation) {
      throw new Error('Fixture observation was not created');
    }

    const availability = input.availability ?? 'available';
    const [sourceMedia] = await transaction
      .insert(messageSourceMediaObservations)
      .values({
        availability,
        createdAt: input.createdAt,
        desktopSourcePath:
          input.sourceKind === 'telegram_desktop_json' && availability === 'available'
            ? `photos/${fixtureSequence}.jpg`
            : null,
        mediaKind: input.kind,
        id: input.id,
        observationId: observation.id,
        position: input.position,
        sourceKind: input.sourceKind,
        telegramFileId:
          input.sourceKind === 'telegram_bot_update' ? `file-${fixtureSequence}` : null,
        telegramFileUniqueId:
          input.sourceKind === 'telegram_bot_update' ? `unique-${fixtureSequence}` : null,
      })
      .returning({ id: messageSourceMediaObservations.id });
    if (!sourceMedia) {
      throw new Error('Fixture source media was not created');
    }
    await input.beforeCommit?.();
    return sourceMedia.id;
  });
}

describe('media cache discovery repository', () => {
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
      truncate table ${mediaCacheRuntime}, ${telegramChannels} cascade
    `);
  });

  it('advances a bounded durable cursor across poison evidence and remains idempotent after restart', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createRevision(connection, [
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 },
    ]);
    const poisonId = await addEvidence(connection, fixture, {
      availability: 'unavailable',
      createdAt: new Date('2026-07-24T00:00:01.000Z'),
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_desktop_json',
    });
    const validId = await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:00:01.000Z'),
      id: '00000000-0000-4000-8000-000000000002',
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });

    const firstProcess = new PostgresMediaCacheDiscoveryRepository(connection.db, {
      batchSize: 1,
    });
    await expect(firstProcess.discoverBatch()).resolves.toMatchObject({
      cursor: { id: poisonId },
      objectsCreated: 0,
      plansCreated: 0,
      scanned: 1,
    });
    await expect(firstProcess.discoverBatch()).resolves.toMatchObject({
      cursor: { id: validId },
      objectsCreated: 1,
      plansCreated: 1,
      scanned: 1,
      sourcesCreated: 1,
    });

    const restarted = new PostgresMediaCacheDiscoveryRepository(connection.db, { batchSize: 1 });
    await expect(restarted.discoverBatch()).resolves.toMatchObject({
      objectsCreated: 0,
      plansCreated: 0,
      scanned: 0,
      sourcesCreated: 0,
    });
    expect(await connection.db.select().from(mediaCachePostPlans)).toHaveLength(1);
    expect(await connection.db.select().from(mediaCacheObjects)).toHaveLength(1);
    expect(await connection.db.select().from(mediaCacheObjectSources)).toHaveLength(1);

    const [runtime] = await connection.db
      .select()
      .from(mediaCacheRuntime)
      .where(eq(mediaCacheRuntime.singletonKey, 'local'))
      .limit(1);
    expect(runtime).toMatchObject({
      discoveryCursorCreatedAt: new Date('2026-07-24T00:00:01.000Z'),
      discoveryCursorId: validId,
    });
  });

  it('scans only configured selected channels without consuming the global cursor', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const selected = await createRevision(connection, [
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 },
    ]);
    const excluded = await createRevision(connection, [
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 },
    ]);
    await configureChannels(connection, [selected, excluded]);
    const selectedEvidenceId = await addEvidence(connection, selected, {
      createdAt: new Date('2026-07-24T00:00:02.000Z'),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    await addEvidence(connection, excluded, {
      createdAt: new Date('2026-07-24T00:00:03.000Z'),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });

    const repository = new PostgresMediaCacheDiscoveryRepository(connection.db);
    await expect(repository.discoverScopedBatch([selected.telegramChatId])).resolves.toMatchObject({
      cursor: { id: selectedEvidenceId },
      hasMore: false,
      objectsCreated: 1,
      plansCreated: 1,
      scanned: 1,
      sourcesCreated: 1,
    });
    expect(await connection.db.select().from(mediaCacheRuntime)).toEqual([]);
    expect(
      await connection.db
        .select({ revisionId: mediaCachePostPlans.revisionId })
        .from(mediaCachePostPlans),
    ).toEqual([{ revisionId: selected.revisionId }]);

    await expect(repository.discoverBatch()).resolves.toMatchObject({
      objectsCreated: 1,
      plansCreated: 1,
      scanned: 2,
      sourcesCreated: 1,
    });
    const plans = await connection.db
      .select({ revisionId: mediaCachePostPlans.revisionId })
      .from(mediaCachePostPlans);
    expect(plans).toEqual(
      expect.arrayContaining([
        { revisionId: selected.revisionId },
        { revisionId: excluded.revisionId },
      ]),
    );
    expect(plans).toHaveLength(2);
  });

  it('rejects empty, non-canonical, or unconfigured scoped channel IDs', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const repository = new PostgresMediaCacheDiscoveryRepository(connection.db);
    await expect(repository.discoverScopedBatch([])).rejects.toThrow(MediaCacheDiscoveryScopeError);
    await expect(repository.discoverScopedBatch([1n])).rejects.toThrow(
      'canonical negative Telegram channel ID',
    );
    await expect(repository.discoverScopedBatch([-1_002_234_260_754n])).rejects.toThrow(
      'must exist in the Telegram allowlist',
    );
  });

  it('keeps scoped microsecond timestamps and UUID keysets lossless across pages', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createRevision(connection, [
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 },
    ]);
    await configureChannels(connection, [fixture]);
    const firstId = await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:00:04.123Z'),
      id: '00000000-0000-4000-8000-000000000021',
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    const secondId = await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:00:04.123Z'),
      id: '00000000-0000-4000-8000-000000000022',
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    await connection.db.execute(sql`
      update ${messageSourceMediaObservations}
      set created_at = timestamp with time zone '2026-07-24 00:00:04.123456+00'
      where ${messageSourceMediaObservations.id} in (${firstId}, ${secondId})
    `);

    const repository = new PostgresMediaCacheDiscoveryRepository(connection.db, { batchSize: 1 });
    const first = await repository.discoverScopedBatch([fixture.telegramChatId]);
    expect(first).toMatchObject({
      cursor: { id: firstId },
      hasMore: true,
      scanned: 1,
    });
    if (!first.cursor) {
      throw new Error('First scoped cursor was not returned');
    }
    expect(first.cursor.createdAt.toISOString()).toBe('2026-07-24T00:00:04.123Z');

    const second = await repository.discoverScopedBatch([fixture.telegramChatId], first.cursor);
    expect(second).toMatchObject({
      cursor: { id: secondId },
      hasMore: false,
      objectsCreated: 0,
      plansCreated: 0,
      scanned: 1,
      sourcesCreated: 0,
    });
    if (!second.cursor) {
      throw new Error('Second scoped cursor was not returned');
    }
    await expect(
      repository.discoverScopedBatch([fixture.telegramChatId], second.cursor),
    ).resolves.toMatchObject({
      cursor: { id: secondId },
      hasMore: false,
      scanned: 0,
    });
  });

  it('waits for an in-flight older evidence row before advancing the discovery cursor', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const database = connection.db;
    const fixture = await createRevision(connection, [
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 },
    ]);
    const newerId = await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:00:12.000Z'),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });

    let announceWriter: (() => void) | undefined;
    let releaseWriter: (() => void) | undefined;
    const writerReady = new Promise<void>((resolve) => {
      announceWriter = resolve;
    });
    const holdWriter = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const olderWrite = addEvidence(connection, fixture, {
      beforeCommit: async () => {
        announceWriter?.();
        await holdWriter;
      },
      createdAt: new Date('2026-07-24T00:00:11.000Z'),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_desktop_json',
    });
    await writerReady;

    const repository = new PostgresMediaCacheDiscoveryRepository(database);
    const discovery = repository.discoverBatch();
    await vi.waitFor(
      async () => {
        const [lockState] = await database.execute<{ waiting: boolean }>(sql`
          select exists (
            select 1
            from pg_locks
            where locktype = 'advisory'
              and not granted
          ) as waiting
        `);
        expect(lockState?.waiting).toBe(true);
      },
      { timeout: 5_000 },
    );

    releaseWriter?.();
    const [olderId, result] = await Promise.all([olderWrite, discovery]);
    expect(result).toMatchObject({
      cursor: { id: newerId },
      objectsCreated: 1,
      plansCreated: 1,
      scanned: 2,
      sourcesCreated: 2,
    });
    const sourceIds = await database
      .select({ id: mediaCacheObjectSources.sourceMediaObservationId })
      .from(mediaCacheObjectSources);
    expect(sourceIds).toEqual(expect.arrayContaining([{ id: olderId }, { id: newerId }]));
  });

  it('timestamps evidence after acquiring the coordination lock, not when its transaction began', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createRevision(connection, [
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 },
    ]);
    let announceOldTransaction: (() => void) | undefined;
    let releaseOldTransaction: (() => void) | undefined;
    const oldTransactionStarted = new Promise<void>((resolve) => {
      announceOldTransaction = resolve;
    });
    const holdOldTransaction = new Promise<void>((resolve) => {
      releaseOldTransaction = resolve;
    });
    const oldWrite = connection.db.transaction(async (transaction) => {
      await transaction.execute(sql`select now()`);
      announceOldTransaction?.();
      await holdOldTransaction;
      await lockSourceEvidenceDiscovery(transaction);
      const [observation] = await transaction
        .insert(messageSourceObservations)
        .values({
          channelId: fixture.channelId,
          contentFingerprint: `delayed-${fixtureSequence}`,
          contentFingerprintVersion: 1,
          messageId: fixture.messageId,
          rawJson: {},
          resolution: 'matched',
          revisionId: fixture.revisionId,
          sourceKey: `delayed:${fixtureSequence}`,
          sourceKind: 'telegram_desktop_json',
          telegramMessageId: 99_999n,
        })
        .returning({ id: messageSourceObservations.id });
      if (!observation) {
        throw new Error('Delayed observation was not created');
      }
      const [sourceMedia] = await transaction
        .insert(messageSourceMediaObservations)
        .values({
          availability: 'available',
          createdAt: sql`clock_timestamp()`,
          desktopSourcePath: 'photos/delayed.jpg',
          mediaKind: 'photo',
          observationId: observation.id,
          position: 0,
          sourceKind: 'telegram_desktop_json',
        })
        .returning({
          createdAt: messageSourceMediaObservations.createdAt,
          id: messageSourceMediaObservations.id,
        });
      if (!sourceMedia) {
        throw new Error('Delayed source media was not created');
      }
      return sourceMedia;
    });
    await oldTransactionStarted;

    const [databaseClock] = await connection.db.execute<{ now: Date | string }>(
      sql`select clock_timestamp() as now`,
    );
    if (!databaseClock) {
      throw new Error('PostgreSQL clock was not available');
    }
    const newerId = await addEvidence(connection, fixture, {
      createdAt: new Date(databaseClock.now),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    const repository = new PostgresMediaCacheDiscoveryRepository(connection.db);
    await expect(repository.discoverBatch()).resolves.toMatchObject({
      cursor: { id: newerId },
      scanned: 1,
      sourcesCreated: 1,
    });

    releaseOldTransaction?.();
    const delayed = await oldWrite;
    expect(delayed.createdAt.getTime()).toBeGreaterThan(new Date(databaseClock.now).getTime());
    await expect(repository.discoverBatch()).resolves.toMatchObject({
      cursor: { id: delayed.id },
      scanned: 1,
      sourcesCreated: 1,
    });
  });

  it('discovers only current non-tombstoned revisions from created or matched evidence', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const current = await createRevision(connection, [
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 },
    ]);
    const oldRevision = await createRevision(
      connection,
      [{ bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 }],
      { currentRevisionNumber: 2, revisionNumber: 1 },
    );
    const tombstoned = await createRevision(
      connection,
      [{ bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 }],
      { tombstoned: true },
    );
    const stale = await createRevision(connection, [
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 },
    ]);
    const mismatchedMedia = await createRevision(connection, [
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 },
    ]);
    const missingRevision = await createRevision(connection, [
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 },
    ]);
    await addEvidence(connection, current, {
      createdAt: new Date('2026-07-24T00:01:01.000Z'),
      kind: 'photo',
      position: 0,
      resolution: 'created',
      sourceKind: 'telegram_bot_update',
    });
    await addEvidence(connection, oldRevision, {
      createdAt: new Date('2026-07-24T00:01:02.000Z'),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    await addEvidence(connection, tombstoned, {
      createdAt: new Date('2026-07-24T00:01:03.000Z'),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    await addEvidence(connection, stale, {
      createdAt: new Date('2026-07-24T00:01:04.000Z'),
      kind: 'photo',
      position: 0,
      resolution: 'stale',
      sourceKind: 'telegram_bot_update',
    });
    await addEvidence(connection, mismatchedMedia, {
      createdAt: new Date('2026-07-24T00:01:05.000Z'),
      kind: 'video',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    await addEvidence(connection, missingRevision, {
      createdAt: new Date('2026-07-24T00:01:06.000Z'),
      kind: 'photo',
      position: 0,
      revisionId: null,
      sourceKind: 'telegram_bot_update',
    });

    const repository = new PostgresMediaCacheDiscoveryRepository(connection.db);
    await expect(repository.discoverBatch()).resolves.toMatchObject({
      objectsCreated: 1,
      plansCreated: 1,
      scanned: 6,
      sourcesCreated: 1,
    });
    const plans = await connection.db
      .select({ revisionId: mediaCachePostPlans.revisionId })
      .from(mediaCachePostPlans);
    expect(plans).toEqual([{ revisionId: current.revisionId }]);
  });

  it('freezes one object per canonical media and orders Bot evidence before Desktop fallbacks', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createRevision(connection, [
      { bytes: 2n * MEBIBYTE, kind: 'photo', position: 0 },
      { bytes: null, kind: 'animation', position: 1 },
    ]);
    const [photoMedia, animationMedia] = fixture.media;
    if (!photoMedia || !animationMedia) {
      throw new Error('Fixture canonical media was not created');
    }
    const desktopPhoto = await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:02:01.000Z'),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_desktop_json',
    });
    const botPhoto = await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:02:02.000Z'),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    const duplicateBotPhoto = await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:02:03.000Z'),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    const desktopAnimation = await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:02:04.000Z'),
      kind: 'animation',
      position: 1,
      sourceKind: 'telegram_desktop_json',
    });

    const repository = new PostgresMediaCacheDiscoveryRepository(connection.db);
    await expect(repository.discoverBatch()).resolves.toMatchObject({
      objectsCreated: 2,
      plansCreated: 1,
      scanned: 4,
      sourcesCreated: 4,
    });

    const [plan] = await connection.db
      .select({ state: mediaCachePostPlans.state })
      .from(mediaCachePostPlans);
    expect(plan).toEqual({ state: 'awaiting_local_source' });
    const objects = await connection.db
      .select({
        canonicalMediaId: mediaCacheObjects.canonicalMediaId,
        id: mediaCacheObjects.id,
        state: mediaCacheObjects.state,
      })
      .from(mediaCacheObjects)
      .orderBy(asc(mediaCacheObjects.canonicalMediaId));
    expect(objects).toHaveLength(2);
    expect(
      Object.fromEntries(objects.map((object) => [object.canonicalMediaId, object.state])),
    ).toEqual({
      [photoMedia.id]: 'discovered',
      [animationMedia.id]: 'awaiting_local_source',
    });

    const sources = await connection.db
      .select({
        objectId: mediaCacheObjectSources.objectId,
        priority: mediaCacheObjectSources.sourcePriority,
        sourceId: mediaCacheObjectSources.sourceMediaObservationId,
      })
      .from(mediaCacheObjectSources)
      .orderBy(
        asc(mediaCacheObjectSources.objectId),
        asc(mediaCacheObjectSources.sourcePriority),
        asc(mediaCacheObjectSources.sourceMediaObservationId),
      );
    const photoObject = objects.find((object) => object.canonicalMediaId === photoMedia.id);
    const animationObject = objects.find((object) => object.canonicalMediaId === animationMedia.id);
    expect(sources.filter((source) => source.objectId === photoObject?.id)).toEqual(
      expect.arrayContaining([
        { objectId: photoObject?.id, priority: 0, sourceId: botPhoto },
        { objectId: photoObject?.id, priority: 0, sourceId: duplicateBotPhoto },
        { objectId: photoObject?.id, priority: 1, sourceId: desktopPhoto },
      ]),
    );
    expect(sources.filter((source) => source.objectId === animationObject?.id)).toEqual([
      { objectId: animationObject?.id, priority: 1, sourceId: desktopAnimation },
    ]);

    await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:02:05.000Z'),
      kind: 'animation',
      position: 1,
      sourceKind: 'telegram_bot_update',
    });
    await expect(repository.discoverBatch()).resolves.toMatchObject({
      objectsCreated: 0,
      plansCreated: 0,
      scanned: 1,
      sourcesCreated: 1,
    });
    const [promotedPlan] = await connection.db
      .select({ state: mediaCachePostPlans.state })
      .from(mediaCachePostPlans);
    expect(promotedPlan).toEqual({ state: 'discovered' });
    const promotedObjects = await connection.db
      .select({ state: mediaCacheObjects.state })
      .from(mediaCacheObjects);
    expect(promotedObjects).toEqual([{ state: 'discovered' }, { state: 'discovered' }]);
  });

  it('keeps a Desktop-only plan and its object awaiting an explicit local source', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createRevision(connection, [
      { bytes: 3n * MEBIBYTE, kind: 'photo', position: 0 },
    ]);
    await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:03:01.000Z'),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_desktop_json',
    });

    const repository = new PostgresMediaCacheDiscoveryRepository(connection.db);
    await expect(repository.discoverBatch()).resolves.toMatchObject({
      objectsCreated: 1,
      plansCreated: 1,
      sourcesCreated: 1,
    });
    const [plan] = await connection.db
      .select({ state: mediaCachePostPlans.state })
      .from(mediaCachePostPlans);
    const [object] = await connection.db
      .select({ state: mediaCacheObjects.state })
      .from(mediaCacheObjects);
    expect(plan).toEqual({ state: 'awaiting_local_source' });
    expect(object).toEqual({ state: 'awaiting_local_source' });

    await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:03:02.000Z'),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    await expect(repository.discoverBatch()).resolves.toMatchObject({
      objectsCreated: 0,
      plansCreated: 0,
      scanned: 1,
      sourcesCreated: 1,
    });
    const [promotedPlan] = await connection.db
      .select({ state: mediaCachePostPlans.state })
      .from(mediaCachePostPlans);
    const [promotedObject] = await connection.db
      .select({ state: mediaCacheObjects.state })
      .from(mediaCacheObjects);
    expect(promotedPlan).toEqual({ state: 'discovered' });
    expect(promotedObject).toEqual({ state: 'discovered' });
  });

  it('advances past later evidence without mutating a plan after its object set is claimed', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createRevision(connection, [
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 },
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 1 },
    ]);
    await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:03:11.000Z'),
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    const repository = new PostgresMediaCacheDiscoveryRepository(connection.db);
    await expect(repository.discoverBatch()).resolves.toMatchObject({
      objectsCreated: 2,
      plansCreated: 1,
      sourcesCreated: 1,
    });
    const leaseToken = randomUUID();
    await connection.db
      .update(mediaCachePostPlans)
      .set({
        leaseExpiresAt: new Date('2026-07-24T00:10:00.000Z'),
        leaseOwner: 'worker-freeze-test',
        leaseToken,
        state: 'reserved',
      })
      .where(eq(mediaCachePostPlans.revisionId, fixture.revisionId));

    const lateEvidenceId = await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:03:12.000Z'),
      kind: 'photo',
      position: 1,
      sourceKind: 'telegram_bot_update',
    });
    await expect(repository.discoverBatch()).resolves.toMatchObject({
      cursor: { id: lateEvidenceId },
      objectsCreated: 0,
      plansCreated: 0,
      scanned: 1,
      sourcesCreated: 0,
    });
    expect(await connection.db.select().from(mediaCacheObjects)).toHaveLength(2);
    expect(await connection.db.select().from(mediaCacheObjectSources)).toHaveLength(1);
    const [claimedPlan] = await connection.db
      .select({
        leaseToken: mediaCachePostPlans.leaseToken,
        state: mediaCachePostPlans.state,
      })
      .from(mediaCachePostPlans);
    expect(claimedPlan).toEqual({ leaseToken, state: 'reserved' });
  });

  it('preserves individual kind-limit fallback and skips only a known over-budget post as a unit', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const individualOversize = await createRevision(connection, [
      { bytes: 11n * MEBIBYTE, kind: 'photo', position: 0 },
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 1 },
    ]);
    const [oversizePhoto, eligiblePhoto] = individualOversize.media;
    if (!oversizePhoto || !eligiblePhoto) {
      throw new Error('Fixture canonical media was not created');
    }
    for (const media of individualOversize.media) {
      await addEvidence(connection, individualOversize, {
        createdAt: new Date(`2026-07-24T00:04:0${media.position + 1}.000Z`),
        kind: media.kind,
        position: media.position,
        sourceKind: 'telegram_bot_update',
      });
    }

    const postOversize = await createRevision(connection, [
      { bytes: 18n * MEBIBYTE, kind: 'video', position: 0 },
      { bytes: 18n * MEBIBYTE, kind: 'video', position: 1 },
      { bytes: 18n * MEBIBYTE, kind: 'video', position: 2 },
    ]);
    for (const media of postOversize.media) {
      await addEvidence(connection, postOversize, {
        createdAt: new Date(`2026-07-24T00:05:0${media.position + 1}.000Z`),
        kind: media.kind,
        position: media.position,
        sourceKind: 'telegram_bot_update',
      });
    }

    const repository = new PostgresMediaCacheDiscoveryRepository(connection.db);
    await expect(repository.discoverBatch()).resolves.toMatchObject({
      objectsCreated: 5,
      plansCreated: 2,
      scanned: 5,
      sourcesCreated: 5,
    });
    const plans = await connection.db
      .select({
        reasonCode: mediaCachePostPlans.reasonCode,
        revisionId: mediaCachePostPlans.revisionId,
        state: mediaCachePostPlans.state,
      })
      .from(mediaCachePostPlans);
    expect(
      Object.fromEntries(plans.map((plan) => [plan.revisionId, [plan.state, plan.reasonCode]])),
    ).toEqual({
      [individualOversize.revisionId]: ['discovered', null],
      [postOversize.revisionId]: ['skipped', 'skipped_post_limit'],
    });

    const objects = await connection.db
      .select({
        canonicalMediaId: mediaCacheObjects.canonicalMediaId,
        reasonCode: mediaCacheObjects.reasonCode,
        state: mediaCacheObjects.state,
      })
      .from(mediaCacheObjects);
    const objectByMedia = Object.fromEntries(
      objects.map((object) => [
        object.canonicalMediaId,
        { reasonCode: object.reasonCode, state: object.state },
      ]),
    );
    expect(objectByMedia[oversizePhoto.id]).toEqual({
      reasonCode: 'skipped_kind_limit',
      state: 'skipped',
    });
    expect(objectByMedia[eligiblePhoto.id]).toEqual({
      reasonCode: null,
      state: 'discovered',
    });
    for (const media of postOversize.media) {
      expect(objectByMedia[media.id]).toEqual({
        reasonCode: 'skipped_post_limit',
        state: 'skipped',
      });
    }
  });

  it('resolves a claimed plan only from current non-tombstoned Bot evidence in stable priority order', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await createRevision(connection, [
      { bytes: 1n * MEBIBYTE, kind: 'photo', position: 0 },
    ]);
    const firstSourceId = await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:06:01.000Z'),
      id: '00000000-0000-4000-8000-000000000011',
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    const secondSourceId = await addEvidence(connection, fixture, {
      createdAt: new Date('2026-07-24T00:06:02.000Z'),
      id: '00000000-0000-4000-8000-000000000012',
      kind: 'photo',
      position: 0,
      sourceKind: 'telegram_bot_update',
    });
    await new PostgresMediaCacheDiscoveryRepository(connection.db).discoverBatch();
    const [plan] = await connection.db
      .select({ id: mediaCachePostPlans.id })
      .from(mediaCachePostPlans);
    if (!plan) {
      throw new Error('Discovered plan was not created');
    }
    const work = new PostgresMediaCacheWorkerRepository(connection.db);
    await expect(work.listRunnablePostPlanIds(2)).resolves.toEqual([plan.id]);
    const leaseToken = randomUUID();
    const claim = await new PostgresMediaCacheLedgerRepository(connection.db).claimPostPlan({
      leaseExpiresAt: new Date(Date.now() + 30_000),
      leaseOwner: 'worker-source-test',
      leaseToken,
      planId: plan.id,
    });
    const sourceRows = await connection.db
      .select({
        fileId: messageSourceMediaObservations.telegramFileId,
        id: messageSourceMediaObservations.id,
      })
      .from(messageSourceMediaObservations)
      .orderBy(asc(messageSourceMediaObservations.createdAt));
    const expectedSources = sourceRows
      .filter(({ id }) => id === firstSourceId || id === secondSourceId)
      .map(({ fileId }) => ({ fileId }));

    await expect(work.loadClaimedOriginals(plan.id, leaseToken)).resolves.toEqual([
      {
        kind: 'photo',
        objectId: claim?.objectIds[0],
        position: 0,
        sources: expectedSources,
      },
    ]);

    await connection.db
      .update(messages)
      .set({ tombstonedAt: new Date() })
      .where(eq(messages.id, fixture.messageId));
    await expect(work.loadClaimedOriginals(plan.id, leaseToken)).resolves.toEqual([
      {
        kind: 'photo',
        objectId: claim?.objectIds[0],
        position: 0,
        sources: [],
      },
    ]);
  });
});
