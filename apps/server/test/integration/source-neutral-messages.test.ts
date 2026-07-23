import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, count, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresAdminRepository } from '../../src/admin/repository.js';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  importRuns,
  messageMedia,
  messageRevisions,
  messageSourceObservations,
  messages,
  telegramChannelAllowlist,
  telegramChannels,
  telegramIngestTasks,
  telegramPollingState,
  telegramUpdates,
  workerRuntime,
} from '../../src/db/schema.js';
import { PostgresTelegramDesktopImportRepository } from '../../src/imports/import-repository.js';
import {
  type TelegramDesktopImportOptions,
  TelegramDesktopImportService,
} from '../../src/imports/telegram-desktop-service.js';
import { PostgresMessageRepository } from '../../src/messages/repository.js';
import type { NormalizedMessageSnapshot, SourceObservation } from '../../src/messages/types.js';
import { normalizeChannelPost } from '../../src/telegram/normalize.js';
import type { NormalizedChannelPost } from '../../src/telegram/types.js';
import { channelPostFixture } from '../fixtures/telegram.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const CHANNEL_ID = -1_001_234_567_890n;
const DRIZZLE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

async function executeMigrationFile(
  client: ReturnType<typeof postgres>,
  migrationName: string,
): Promise<void> {
  const migration = await readFile(resolve(DRIZZLE_DIRECTORY, migrationName), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) {
      await client.unsafe(statement);
    }
  }
}

function botPost(overrides: Parameters<typeof channelPostFixture>[0] = {}): NormalizedChannelPost {
  const post = normalizeChannelPost(channelPostFixture(overrides), CHANNEL_ID);
  if (!post) {
    throw new Error('Fixture did not normalize');
  }
  return post;
}

function desktopSnapshot(
  post: NormalizedChannelPost,
  overrides: Partial<NormalizedMessageSnapshot['message']> = {},
): NormalizedMessageSnapshot {
  return {
    channel: post.channel,
    media: post.media.map((media) => ({
      availabilityReason: null,
      duration: media.duration,
      fileName: media.fileName,
      fileSize: media.fileSize,
      height: media.height,
      kind: media.kind,
      mimeType: media.mimeType,
      sourceMediaType: media.kind,
      sourceMetadata: {},
      sourcePath: 'photos/photo_1.jpg',
      telegramFileId: null,
      telegramFileUniqueId: null,
      width: media.width,
    })),
    message: {
      ...post.message,
      ...overrides,
      mediaGroupId: null,
    },
  };
}

function desktopObservation(
  sourceKey: string,
  snapshot: NormalizedMessageSnapshot,
): SourceObservation {
  return {
    importRunId: null,
    kind: 'telegram_desktop_json',
    observedAt: snapshot.message.editedAt ?? snapshot.message.publishedAt,
    raw: {
      date_unixtime: String(Math.floor(snapshot.message.publishedAt.getTime() / 1_000)),
      id: snapshot.message.telegramMessageId.toString(),
      text: snapshot.message.text,
      type: 'message',
    },
    sourceChatId: 1_234_567_890n,
    sourceMetadata: {
      forwardedFrom: 'Archive source',
      replyToMessageId: '41',
    },
    sourceKey,
    sourceMessageId: snapshot.message.telegramMessageId,
  };
}

describe('source-neutral message writer', () => {
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
    await connection?.db.execute(
      sql`truncate table ${telegramChannels}, ${telegramChannelAllowlist}, ${importRuns} cascade`,
    );
  });

  it('upgrades legacy Bot rows and backfills truthful source observations', async () => {
    if (!container) {
      throw new Error('PostgreSQL test container did not start');
    }
    const admin = postgres(container.getConnectionUri(), { max: 1 });
    const databaseName = `legacy_${Date.now()}`;
    await admin.unsafe(`create database "${databaseName}"`);
    const legacyUrl = new URL(container.getConnectionUri());
    legacyUrl.pathname = `/${databaseName}`;
    const legacy = postgres(legacyUrl.toString(), { max: 1 });

    try {
      for (const migrationName of [
        '0000_green_sleepwalker.sql',
        '0001_fancy_carmella_unuscione.sql',
        '0002_majestic_tinkerer.sql',
        '0003_public_slipstream.sql',
        '0004_sleepy_carlie_cooper.sql',
        '0005_silent_pixie.sql',
      ]) {
        await executeMigrationFile(legacy, migrationName);
      }
      await legacy`
        insert into telegram_channels (id, telegram_chat_id, title)
        values (
          '10000000-0000-4000-8000-000000000001',
          -1001234567890,
          'Legacy channel'
        )
      `;
      await legacy`
        insert into telegram_updates (
          telegram_update_id,
          channel_id,
          update_type,
          raw_json
        )
        values (
          1001,
          '10000000-0000-4000-8000-000000000001',
          'channel_post',
          '{"update_id":1001}'::jsonb
        )
      `;
      await legacy`
        insert into messages (
          id,
          channel_id,
          telegram_message_id,
          published_at
        )
        values (
          '20000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000001',
          42,
          '2026-01-01T00:00:00Z'
        )
      `;
      await legacy`
        insert into message_revisions (
          id,
          message_id,
          telegram_update_id,
          revision_number,
          content_kind,
          text,
          entities
        )
        values (
          '30000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          1001,
          1,
          'text',
          'legacy',
          '[]'::jsonb
        )
      `;
      await legacy`
        insert into message_media (
          revision_id,
          position,
          kind,
          telegram_file_id,
          telegram_file_unique_id
        )
        values (
          '30000000-0000-4000-8000-000000000001',
          0,
          'photo',
          'real-file-id',
          'real-unique-id'
        )
      `;

      await executeMigrationFile(legacy, '0006_unusual_wolfsbane.sql');

      const [revision] = await legacy<
        {
          telegramUpdateId: string | null;
        }[]
      >`
        select telegram_update_id as "telegramUpdateId"
        from message_revisions
      `;
      const [media] = await legacy<
        {
          sourceKind: string;
          sourceMediaType: string | null;
        }[]
      >`
        select
          source_kind as "sourceKind",
          source_media_type as "sourceMediaType"
        from message_media
      `;
      const [observation] = await legacy<
        {
          fingerprint: string;
          fingerprintVersion: number;
          rawJson: unknown;
          sourceKey: string;
          sourceKind: string;
        }[]
      >`
        select
          content_fingerprint as "fingerprint",
          content_fingerprint_version as "fingerprintVersion",
          raw_json as "rawJson",
          source_key as "sourceKey",
          source_kind as "sourceKind"
        from message_source_observations
      `;

      expect(revision?.telegramUpdateId).toBe('1001');
      expect(media).toEqual({
        sourceKind: 'telegram_bot_update',
        sourceMediaType: 'photo',
      });
      expect(observation).toMatchObject({
        rawJson: { update_id: 1001 },
        fingerprintVersion: 0,
        sourceKey: '1001',
        sourceKind: 'telegram_bot_update',
      });
      expect(observation?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await legacy.end();
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end();
    }
  }, 30_000);

  it('keeps old Bot writers compatible and repairs their missing observations', async () => {
    if (!container) {
      throw new Error('PostgreSQL test container did not start');
    }
    const legacyWriter = postgres(container.getConnectionUri(), { max: 1 });
    try {
      await legacyWriter`
        insert into telegram_channels (id, telegram_chat_id, title)
        values (
          '10000000-0000-4000-8000-000000000002',
          -1001234567891,
          'Rollback channel'
        )
      `;
      await legacyWriter`
        insert into telegram_updates (
          telegram_update_id,
          channel_id,
          update_type,
          raw_json
        )
        values (
          1002,
          '10000000-0000-4000-8000-000000000002',
          'channel_post',
          '{"update_id":1002}'::jsonb
        )
      `;
      await legacyWriter`
        insert into messages (
          id,
          channel_id,
          telegram_message_id,
          published_at
        )
        values (
          '20000000-0000-4000-8000-000000000002',
          '10000000-0000-4000-8000-000000000002',
          43,
          '2026-01-02T00:00:00Z'
        )
      `;
      await legacyWriter`
        insert into message_revisions (
          id,
          message_id,
          telegram_update_id,
          revision_number,
          content_kind,
          text,
          entities
        )
        values (
          '30000000-0000-4000-8000-000000000002',
          '20000000-0000-4000-8000-000000000002',
          1002,
          1,
          'text',
          'written by rollback binary',
          '[]'::jsonb
        )
      `;
      await legacyWriter`
        insert into message_media (
          revision_id,
          position,
          kind,
          telegram_file_id,
          telegram_file_unique_id
        )
        values (
          '30000000-0000-4000-8000-000000000002',
          0,
          'photo',
          'rollback-file-id',
          'rollback-unique-id'
        )
      `;

      const [mediaBeforeRepair] = await legacyWriter<
        {
          sourceKind: string;
        }[]
      >`
        select source_kind as "sourceKind"
        from message_media
        where revision_id = '30000000-0000-4000-8000-000000000002'
      `;
      expect(mediaBeforeRepair?.sourceKind).toBe('telegram_bot_update');

      await runMigrations(container.getConnectionUri());

      const [observation] = await legacyWriter<
        {
          fingerprintVersion: number;
          rawJson: unknown;
          revisionId: string | null;
          sourceKey: string;
          sourceMetadata: Record<string, unknown>;
        }[]
      >`
        select
          content_fingerprint_version as "fingerprintVersion",
          raw_json as "rawJson",
          revision_id as "revisionId",
          source_key as "sourceKey",
          source_metadata as "sourceMetadata"
        from message_source_observations
        where telegram_update_id = 1002
      `;
      expect(observation).toEqual({
        fingerprintVersion: 0,
        rawJson: { update_id: 1002 },
        revisionId: '30000000-0000-4000-8000-000000000002',
        sourceKey: '1002',
        sourceMetadata: {},
      });

      await runMigrations(container.getConnectionUri());
      const [observationCount] = await legacyWriter<{ value: number }[]>`
        select count(*)::integer as value
        from message_source_observations
        where telegram_update_id = 1002
      `;
      expect(observationCount?.value).toBe(1);
    } finally {
      await legacyWriter.end();
    }
  }, 30_000);

  it('matches, rejects stale or ambiguous Desktop snapshots, and advances only a newer edit', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const repository = new PostgresMessageRepository(connection.db);
    const original = botPost();
    const botResult = await repository.ingest(original);
    const matching = desktopSnapshot(original);

    await expect(
      repository.previewSnapshot(matching, desktopObservation('desktop:match', matching)),
    ).resolves.toEqual({
      createdMessage: false,
      createdRevision: false,
      replayed: false,
      resolution: 'matched',
    });
    await expect(
      repository.ingestSnapshot(matching, desktopObservation('desktop:match', matching)),
    ).resolves.toMatchObject({
      createdMessage: false,
      createdRevision: false,
      messageId: botResult.messageId,
      replayed: false,
      resolution: 'matched',
    });

    const stale = desktopSnapshot(original, {
      editedAt: new Date(original.message.publishedAt.getTime() - 1_000),
      text: 'older export content',
    });
    await expect(
      repository.ingestSnapshot(stale, desktopObservation('desktop:stale', stale)),
    ).resolves.toMatchObject({
      createdRevision: false,
      resolution: 'stale',
      revisionId: null,
    });

    const ambiguous = desktopSnapshot(original, {
      editedAt: null,
      text: 'ambiguous export content',
    });
    await expect(
      repository.ingestSnapshot(ambiguous, desktopObservation('desktop:ambiguous', ambiguous)),
    ).resolves.toMatchObject({
      createdRevision: false,
      resolution: 'conflict',
      revisionId: null,
    });

    const newer = desktopSnapshot(original, {
      editedAt: new Date(original.message.publishedAt.getTime() + 60_000),
      text: 'newer Desktop edit',
    });
    const newerObservation = desktopObservation('desktop:newer', newer);
    const updated = await repository.ingestSnapshot(newer, newerObservation);
    expect(updated).toMatchObject({
      createdMessage: false,
      createdRevision: true,
      resolution: 'created',
    });
    await expect(repository.ingestSnapshot(newer, newerObservation)).resolves.toMatchObject({
      createdRevision: false,
      replayed: true,
      resolution: 'created',
    });

    await expect(repository.getMessage(botResult.messageId)).resolves.toMatchObject({
      content: { text: 'newer Desktop edit' },
      id: botResult.messageId,
      revision: 2,
    });
    await expect(
      new PostgresAdminRepository(connection.db).getRawUpdate(botResult.messageId),
    ).resolves.toEqual(newerObservation.raw);

    const revisions = await connection.db
      .select({
        revisionNumber: messageRevisions.revisionNumber,
        telegramUpdateId: messageRevisions.telegramUpdateId,
      })
      .from(messageRevisions)
      .orderBy(asc(messageRevisions.revisionNumber));
    expect(revisions).toEqual([
      { revisionNumber: 1, telegramUpdateId: original.telegramUpdateId },
      { revisionNumber: 2, telegramUpdateId: null },
    ]);

    const observations = await connection.db
      .select({
        resolution: messageSourceObservations.resolution,
        revisionId: messageSourceObservations.revisionId,
        sourceKind: messageSourceObservations.sourceKind,
        sourceMetadata: messageSourceObservations.sourceMetadata,
      })
      .from(messageSourceObservations)
      .orderBy(asc(messageSourceObservations.createdAt), asc(messageSourceObservations.sourceKey));
    expect(observations).toHaveLength(5);
    expect(
      new Set(observations.filter((row) => row.revisionId === null).map((row) => row.resolution)),
    ).toEqual(new Set(['conflict', 'stale']));
    expect(observations[0]?.sourceKind).toBe('telegram_bot_update');
    expect(
      observations.find((observation) => observation.sourceKind === 'telegram_desktop_json')
        ?.sourceMetadata,
    ).toEqual({
      forwardedFrom: 'Archive source',
      replyToMessageId: '41',
    });
  }, 30_000);

  it('serializes concurrent Bot and Desktop first writes without fabricated source IDs', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const repository = new PostgresMessageRepository(connection.db);
    const post = botPost({ messageId: 88, updateId: 8_088 });
    const snapshot = desktopSnapshot(post);
    const observation = desktopObservation('desktop:concurrent:88', snapshot);

    const [bot, desktop] = await Promise.all([
      repository.ingest(post),
      repository.ingestSnapshot(snapshot, observation),
    ]);
    expect(bot.messageId).toBe(desktop.messageId);

    const database = connection.db;
    const [messageCount, revisionCount, observationCount, updateCount] = await Promise.all(
      [messages, messageRevisions, messageSourceObservations, telegramUpdates].map(
        async (table) => {
          const [row] = await database.select({ value: count() }).from(table);
          return row?.value;
        },
      ),
    );
    expect([messageCount, revisionCount, observationCount, updateCount]).toEqual([1, 1, 2, 1]);

    const [media] = await connection.db
      .select()
      .from(messageMedia)
      .where(
        eq(messageMedia.revisionId, desktop.revisionId ?? '00000000-0000-0000-0000-000000000000'),
      );
    if (media?.sourceKind === 'telegram_desktop_json') {
      expect(media.telegramFileId).toBeNull();
      expect(media.telegramFileUniqueId).toBeNull();
      expect(media.sourcePath).toBe('photos/photo_1.jpg');
    } else {
      expect(media?.sourceKind).toBe('telegram_bot_update');
      expect(media?.telegramFileId).toBeTruthy();
      expect(media?.sourcePath).toBeNull();
    }
  }, 30_000);

  it('records differing Bot channel posts as conflicts without overwriting Desktop current', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const repository = new PostgresMessageRepository(connection.db);
    const post = botPost({
      messageId: 90,
      text: 'Bot content',
      updateId: 8_090,
    });
    const desktop = desktopSnapshot(post, { text: 'Desktop content' });
    const desktopResult = await repository.ingestSnapshot(
      desktop,
      desktopObservation('desktop:first:90', desktop),
    );

    await expect(repository.ingest(post)).resolves.toMatchObject({
      messageId: desktopResult.messageId,
      replayed: true,
    });
    await expect(repository.getMessage(desktopResult.messageId)).resolves.toMatchObject({
      content: { text: 'Desktop content' },
      revision: 1,
    });

    const botObservations = await connection.db
      .select({
        fingerprintVersion: messageSourceObservations.contentFingerprintVersion,
        resolution: messageSourceObservations.resolution,
        revisionId: messageSourceObservations.revisionId,
      })
      .from(messageSourceObservations)
      .where(eq(messageSourceObservations.sourceKind, 'telegram_bot_update'));
    expect(botObservations).toEqual([
      {
        fingerprintVersion: 1,
        resolution: 'conflict',
        revisionId: null,
      },
    ]);
  }, 30_000);

  it('preserves Bot current when a differing Desktop snapshot arrives later', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const repository = new PostgresMessageRepository(connection.db);
    const post = botPost({
      messageId: 91,
      text: 'Bot first',
      updateId: 8_091,
    });
    const botResult = await repository.ingest(post);
    const desktop = desktopSnapshot(post, { text: 'Desktop later' });

    await expect(
      repository.ingestSnapshot(desktop, desktopObservation('desktop:later:91', desktop)),
    ).resolves.toMatchObject({
      createdRevision: false,
      resolution: 'conflict',
      revisionId: null,
    });
    await expect(repository.getMessage(botResult.messageId)).resolves.toMatchObject({
      content: { text: 'Bot first' },
      revision: 1,
    });
  }, 30_000);

  it('serializes concurrent differing first writes as one revision plus conflict evidence', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const repository = new PostgresMessageRepository(connection.db);
    const post = botPost({
      messageId: 92,
      text: 'Concurrent Bot',
      updateId: 8_092,
    });
    const desktop = desktopSnapshot(post, { text: 'Concurrent Desktop' });

    const [botResult, desktopResult] = await Promise.all([
      repository.ingest(post),
      repository.ingestSnapshot(desktop, desktopObservation('desktop:concurrent:92', desktop)),
    ]);
    expect(botResult.messageId).toBe(desktopResult.messageId);

    const [revisionRows, observationRows] = await Promise.all([
      connection.db
        .select({ value: count() })
        .from(messageRevisions)
        .where(eq(messageRevisions.messageId, botResult.messageId)),
      connection.db
        .select({
          fingerprintVersion: messageSourceObservations.contentFingerprintVersion,
          resolution: messageSourceObservations.resolution,
          revisionId: messageSourceObservations.revisionId,
        })
        .from(messageSourceObservations)
        .where(eq(messageSourceObservations.messageId, botResult.messageId)),
    ]);
    expect(revisionRows[0]?.value).toBe(1);
    expect(observationRows).toHaveLength(2);
    expect(observationRows.every((row) => row.fingerprintVersion === 1)).toBe(true);
    expect(observationRows.filter((row) => row.resolution === 'created')).toHaveLength(1);
    expect(
      observationRows.filter((row) => row.resolution === 'conflict' && row.revisionId === null),
    ).toHaveLength(1);
  }, 30_000);

  it('persists dry-run, apply, replay, and partial Desktop imports without leaking input details', async () => {
    if (!connection || !container) {
      throw new Error('PostgreSQL test container did not start');
    }
    const database = connection.db;
    const databaseUrl = container.getConnectionUri();

    const directory = await mkdtemp(join(tmpdir(), 'koharu-pg-import-'));
    const cleanInput = join(directory, 'private-export.json');
    const conflictInput = join(directory, 'private-conflict-export.json');
    const originalBody = 'owner-only integration body 4df4bfb9';
    const conflictBody = 'owner-only conflicting body 5737727e';
    const canonicalChannelId = -1_001_234_567_890n;
    const baseExport = {
      id: 1_234_567_890,
      messages: [
        {
          date_unixtime: '1735787045',
          id: 1,
          text: originalBody,
          type: 'message',
        },
        {
          date_unixtime: '1735787105',
          id: 2,
          text: '',
          type: 'service',
        },
      ],
      name: 'Configured integration channel',
      type: 'public_channel',
    };
    const conflictingExport = {
      ...baseExport,
      messages: [
        {
          date_unixtime: '1735787045',
          id: 1,
          text: conflictBody,
          type: 'message',
        },
        null,
      ],
    };
    await Promise.all([
      writeFile(cleanInput, JSON.stringify(baseExport)),
      writeFile(conflictInput, JSON.stringify(conflictingExport)),
    ]);
    await database.insert(telegramChannelAllowlist).values({
      telegramChatId: canonicalChannelId,
      title: 'Configured integration channel',
      username: 'configured_integration',
    });
    const controlPlaneSnapshot = async () => {
      const [allowlist, polling, tasks, workers] = await Promise.all([
        database
          .select()
          .from(telegramChannelAllowlist)
          .where(eq(telegramChannelAllowlist.telegramChatId, canonicalChannelId)),
        database.select().from(telegramPollingState),
        database.select().from(telegramIngestTasks),
        database.select().from(workerRuntime),
      ]);
      return { allowlist, polling, tasks, workers };
    };
    const controlPlaneBefore = await controlPlaneSnapshot();

    const runImport = async (
      options: Pick<TelegramDesktopImportOptions, 'apply' | 'inputPath'>,
    ) => {
      const importRepository = new PostgresTelegramDesktopImportRepository(databaseUrl, database);
      try {
        return await new TelegramDesktopImportService(
          importRepository,
          new PostgresMessageRepository(database),
        ).run({
          ...options,
          channelIds: [canonicalChannelId],
        });
      } finally {
        await importRepository.close();
      }
    };
    const rowCounts = async () => {
      const [runCount, channelCount, messageCount, revisionCount, observationCount] =
        await Promise.all(
          [importRuns, telegramChannels, messages, messageRevisions, messageSourceObservations].map(
            async (table) => {
              const [row] = await database.select({ value: count() }).from(table);
              return row?.value ?? 0;
            },
          ),
        );
      return { channelCount, messageCount, observationCount, revisionCount, runCount };
    };
    const expectSanitized = (value: unknown, inputPath: string) => {
      const serialized = JSON.stringify(value);
      expect(serialized).not.toContain(inputPath);
      expect(serialized).not.toContain(directory);
      expect(serialized).not.toContain(originalBody);
      expect(serialized).not.toContain(conflictBody);
    };

    try {
      const preview = await runImport({ apply: false, inputPath: cleanInput });
      expect(preview).toMatchObject({
        counts: {
          createdMessages: 1,
          createdRevisions: 1,
          eligible: 1,
          scanned: 2,
          skippedService: 1,
        },
        mode: 'dry-run',
        status: 'clean',
      });
      expect(preview.runId).toBeUndefined();
      expect(await rowCounts()).toEqual({
        channelCount: 0,
        messageCount: 0,
        observationCount: 0,
        revisionCount: 0,
        runCount: 0,
      });
      expectSanitized(preview, cleanInput);

      const applied = await runImport({ apply: true, inputPath: cleanInput });
      expect(applied).toMatchObject({
        counts: {
          createdMessages: 1,
          createdRevisions: 1,
          eligible: 1,
          matchedExisting: 0,
          scanned: 2,
          skippedService: 1,
        },
        mode: 'apply',
        status: 'clean',
      });
      expect(applied.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(await rowCounts()).toEqual({
        channelCount: 1,
        messageCount: 1,
        observationCount: 1,
        revisionCount: 1,
        runCount: 1,
      });

      const [appliedRun] = await database
        .select()
        .from(importRuns)
        .where(eq(importRuns.id, applied.runId as string));
      const [appliedObservation] = await database.select().from(messageSourceObservations);
      expect(appliedRun).toMatchObject({
        completedAt: expect.any(Date),
        id: applied.runId,
        status: 'completed',
      });
      expect(appliedObservation).toMatchObject({
        importRunId: applied.runId,
        rawJson: { text: originalBody },
        resolution: 'created',
        sourceKind: 'telegram_desktop_json',
      });
      expectSanitized({ report: applied, storedReport: appliedRun?.report }, cleanInput);

      const replay = await runImport({ apply: true, inputPath: cleanInput });
      expect(replay).toMatchObject({
        counts: {
          createdMessages: 0,
          createdRevisions: 0,
          eligible: 1,
          matchedExisting: 1,
        },
        mode: 'apply',
        status: 'clean',
      });
      expect(replay.runId).not.toBe(applied.runId);
      expect(await rowCounts()).toEqual({
        channelCount: 1,
        messageCount: 1,
        observationCount: 1,
        revisionCount: 1,
        runCount: 2,
      });
      const [replayRun] = await database
        .select()
        .from(importRuns)
        .where(eq(importRuns.id, replay.runId as string));
      expect(replayRun).toMatchObject({
        completedAt: expect.any(Date),
        status: 'completed',
      });
      expectSanitized({ report: replay, storedReport: replayRun?.report }, cleanInput);

      const partial = await runImport({ apply: true, inputPath: conflictInput });
      expect(partial).toMatchObject({
        counts: {
          conflicts: 1,
          createdMessages: 0,
          createdRevisions: 0,
          eligible: 1,
          itemErrors: 1,
          scanned: 2,
        },
        mode: 'apply',
        status: 'partial',
      });
      expect(partial.issues.map((issue) => issue.code)).toEqual([
        'invalid_message_record',
        'snapshot_conflict',
      ]);
      expect(await rowCounts()).toEqual({
        channelCount: 1,
        messageCount: 1,
        observationCount: 2,
        revisionCount: 1,
        runCount: 3,
      });
      const [partialRun] = await database
        .select()
        .from(importRuns)
        .where(eq(importRuns.id, partial.runId as string));
      const [conflictObservation] = await database
        .select()
        .from(messageSourceObservations)
        .where(eq(messageSourceObservations.resolution, 'conflict'));
      expect(partialRun).toMatchObject({
        completedAt: expect.any(Date),
        status: 'partial',
      });
      expect(conflictObservation).toMatchObject({
        importRunId: partial.runId,
        rawJson: { text: conflictBody },
        revisionId: null,
      });
      expectSanitized({ report: partial, storedReport: partialRun?.report }, conflictInput);
      expect(await controlPlaneSnapshot()).toEqual(controlPlaneBefore);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it('holds the Desktop apply advisory lock for the pinned PostgreSQL session', async () => {
    if (!connection || !container) {
      throw new Error('PostgreSQL test container did not start');
    }

    const first = new PostgresTelegramDesktopImportRepository(
      container.getConnectionUri(),
      connection.db,
    );
    const second = new PostgresTelegramDesktopImportRepository(
      container.getConnectionUri(),
      connection.db,
    );
    let firstClosed = false;
    try {
      await first.acquireApplyLock();
      await first.assertApplyLock();
      await expect(second.acquireApplyLock()).rejects.toThrow(
        'Another Telegram Desktop import is already running',
      );

      await first.close();
      firstClosed = true;
      await second.acquireApplyLock();
      await expect(second.assertApplyLock()).resolves.toBeUndefined();
    } finally {
      if (!firstClosed) {
        await first.close();
      }
      await second.close();
    }
  }, 30_000);
});
