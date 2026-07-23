import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, count, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  messageMedia,
  messageRevisions,
  messages,
  telegramChannelAllowlist,
  telegramChannels,
  telegramIngestTasks,
  telegramPollingState,
  telegramUpdates,
} from '../../src/db/schema.js';
import { PostgresMessageRepository } from '../../src/messages/repository.js';
import type { TelegramApi } from '../../src/telegram/api.js';
import { TelegramChannelService } from '../../src/telegram/channel-service.js';
import { TelegramInboxRepository } from '../../src/telegram/inbox-repository.js';
import { normalizeChannelPost, normalizeChannelUpdate } from '../../src/telegram/normalize.js';
import { TelegramWorkerPool } from '../../src/telegram/worker.js';
import { channelPostFixture, editedChannelPostFixture } from '../fixtures/telegram.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const ALLOWED_CHANNEL_ID = -1_001_234_567_890n;

describe('database migrations', () => {
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
  });

  beforeEach(async () => {
    if (!connection) {
      return;
    }
    await connection.db.execute(
      sql`truncate table ${telegramChannelAllowlist}, ${telegramChannels}, ${telegramPollingState} cascade`,
    );
  });

  it('applies the schema repeatedly without changing the result', async () => {
    if (!container) {
      throw new Error('PostgreSQL test container did not start');
    }

    const databaseUrl = container.getConnectionUri();

    await runMigrations(databaseUrl);

    const client = postgres(databaseUrl, { max: 1 });

    try {
      const [result] = await client<{ tableName: string | null }[]>`
        select to_regclass('public.message_revisions')::text as "tableName"
      `;

      expect(result?.tableName).toBe('message_revisions');
    } finally {
      await client.end();
    }
  }, 30_000);

  it('ingests replayed posts idempotently and serves only the public projection', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const firstPost = normalizeChannelPost(channelPostFixture(), ALLOWED_CHANNEL_ID);
    if (!firstPost) {
      throw new Error('Fixture did not normalize');
    }

    const database = connection.db;
    const repository = new PostgresMessageRepository(database);
    const concurrentResults = await Promise.all(
      Array.from({ length: 4 }, () => repository.ingest(firstPost)),
    );
    const firstMessageId = concurrentResults[0]?.messageId;
    const firstChannelId = concurrentResults[0]?.channelId;

    expect(firstMessageId).toBeDefined();
    expect(firstChannelId).toBeDefined();
    expect(new Set(concurrentResults.map((result) => result.messageId))).toEqual(
      new Set([firstMessageId]),
    );
    expect(concurrentResults.filter((result) => !result.replayed)).toHaveLength(1);

    const alternateUpdate = normalizeChannelPost(
      channelPostFixture({ updateId: 1_002 }),
      ALLOWED_CHANNEL_ID,
    );
    if (!alternateUpdate) {
      throw new Error('Alternate fixture did not normalize');
    }
    const replayedMessage = await repository.ingest(alternateUpdate);
    expect(replayedMessage).toMatchObject({
      messageId: firstMessageId,
      replayed: true,
    });

    const secondPost = normalizeChannelPost(
      channelPostFixture({
        date: 1_751_300_100,
        messageId: 43,
        text: 'Newer channel post',
        updateId: 1_003,
      }),
      ALLOWED_CHANNEL_ID,
    );
    if (!secondPost) {
      throw new Error('Second fixture did not normalize');
    }
    const secondMessage = await repository.ingest(secondPost);

    const tableCounts = await Promise.all(
      [telegramChannels, telegramUpdates, messages, messageRevisions, messageMedia].map(
        async (table) => {
          const [result] = await database.select({ value: count() }).from(table);
          return result?.value;
        },
      ),
    );
    expect(tableCounts).toEqual([1, 3, 2, 2, 2]);

    const app = createApp({ messages: repository });
    const channelsResponse = await app.request('/api/v1/channels');
    expect(channelsResponse.status).toBe(200);
    const channels = await channelsResponse.json();
    expect(channels).toEqual({
      items: [
        {
          id: firstChannelId,
          title: 'Koharu Test Channel',
          username: 'koharu_test',
        },
      ],
    });
    expect(JSON.stringify(channels)).not.toContain(ALLOWED_CHANNEL_ID.toString());

    const listResponse = await app.request(
      `/api/v1/messages?channel=${channels.items[0]?.id ?? ''}`,
    );
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json();
    expect(list).toMatchObject({
      items: [
        {
          id: secondMessage.messageId,
          content: { text: 'Newer channel post' },
        },
        {
          id: firstMessageId,
          content: { text: 'Koharu first channel post' },
        },
      ],
    });

    const detailResponse = await app.request(`/api/v1/messages/${firstMessageId}`);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(detail).toMatchObject({
      channel: {
        id: firstChannelId,
        username: 'koharu_test',
      },
      id: firstMessageId,
      media: [
        {
          fileSize: '4096',
          kind: 'photo',
        },
      ],
      revision: 1,
      sourceUrl: 'https://t.me/koharu_test/42',
    });

    const serializedDetail = JSON.stringify(detail);
    expect(serializedDetail).not.toContain('rawJson');
    expect(serializedDetail).not.toContain('telegramUpdateId');
    expect(serializedDetail).not.toContain('telegramMessageId');
    expect(serializedDetail).not.toContain('telegramFileId');
  }, 30_000);

  it('checkpoints allowed channel updates atomically and binds exactly one Bot', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    await connection.db.insert(telegramChannelAllowlist).values([
      {
        telegramChatId: ALLOWED_CHANNEL_ID,
        title: 'Koharu Test Channel',
        username: 'koharu_test',
      },
      {
        telegramChatId: -1_001_234_567_891n,
        title: 'Fixture Channel Two',
        username: 'koharu_fixture_two',
      },
    ]);
    const inbox = new TelegramInboxRepository(connection.db);

    await expect(inbox.bindBot(123_456n)).resolves.toBeNull();
    await expect(
      inbox.checkpointBatch(123_456n, [
        channelPostFixture({ updateId: 2_001 }),
        channelPostFixture({ channelId: -1_001_234_567_899, updateId: 2_002 }),
        channelPostFixture({ channelId: -1_001_234_567_891, updateId: 2_003 }),
      ]),
    ).resolves.toBe(2_004n);
    await inbox.checkpointBatch(123_456n, [
      channelPostFixture({ updateId: 2_001 }),
      channelPostFixture({ channelId: -1_001_234_567_891, updateId: 2_003 }),
    ]);

    const tasks = await connection.db
      .select({
        telegramChatId: telegramIngestTasks.telegramChatId,
        telegramUpdateId: telegramIngestTasks.telegramUpdateId,
      })
      .from(telegramIngestTasks)
      .orderBy(asc(telegramIngestTasks.telegramUpdateId));
    expect(tasks).toEqual([
      { telegramChatId: ALLOWED_CHANNEL_ID, telegramUpdateId: 2_001n },
      { telegramChatId: -1_001_234_567_891n, telegramUpdateId: 2_003n },
    ]);

    const [state] = await connection.db.select().from(telegramPollingState);
    expect(state).toMatchObject({ botId: 123_456n, nextUpdateId: 2_004n });
    await expect(inbox.bindBot(654_321n)).rejects.toThrow('different Telegram Bot');
    const [unchanged] = await connection.db.select().from(telegramPollingState);
    expect(unchanged).toMatchObject({ botId: 123_456n, nextUpdateId: 2_004n });
  });

  it('keeps immutable revisions for every edit and supports first-known edits', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const repository = new PostgresMessageRepository(connection.db);
    const updates = [
      channelPostFixture({ text: 'Original', updateId: 3_001 }),
      editedChannelPostFixture({ text: 'Edited', updateId: 3_002 }),
      editedChannelPostFixture({ text: 'Edited', updateId: 3_003 }),
    ];
    for (const update of updates) {
      const post = normalizeChannelUpdate(update, ALLOWED_CHANNEL_ID);
      if (!post) {
        throw new Error('Fixture did not normalize');
      }
      await repository.ingest(post);
    }

    const [message] = await connection.db.select().from(messages);
    expect(message?.currentRevisionNumber).toBe(3);
    const revisions = await connection.db
      .select({
        editedAt: messageRevisions.editedAt,
        revisionNumber: messageRevisions.revisionNumber,
        text: messageRevisions.text,
      })
      .from(messageRevisions)
      .orderBy(asc(messageRevisions.revisionNumber));
    expect(revisions.map((revision) => [revision.revisionNumber, revision.text])).toEqual([
      [1, 'Original'],
      [2, 'Edited'],
      [3, 'Edited'],
    ]);
    expect(revisions[0]?.editedAt).toBeNull();
    expect(revisions[1]?.editedAt).toEqual(new Date(1_751_300_200_000));

    const replay = normalizeChannelUpdate(updates[2] ?? channelPostFixture(), ALLOWED_CHANNEL_ID);
    if (!replay) {
      throw new Error('Replay fixture did not normalize');
    }
    await expect(repository.ingest(replay)).resolves.toMatchObject({ replayed: true });
    const [revisionCount] = await connection.db.select({ value: count() }).from(messageRevisions);
    expect(revisionCount?.value).toBe(3);

    const firstKnown = normalizeChannelUpdate(
      editedChannelPostFixture({ messageId: 44, text: 'First known edit', updateId: 3_004 }),
      ALLOWED_CHANNEL_ID,
    );
    if (!firstKnown) {
      throw new Error('First-known edit fixture did not normalize');
    }
    await repository.ingest(firstKnown);
    const [unknownEdit] = await connection.db
      .select({ currentRevisionNumber: messages.currentRevisionNumber })
      .from(messages)
      .where(eq(messages.telegramMessageId, 44n));
    expect(unknownEdit?.currentRevisionNumber).toBe(1);
  });

  it('isolates a poison channel head while another channel continues', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const secondChannelId = -1_001_234_567_891n;
    await connection.db.insert(telegramChannelAllowlist).values([
      {
        telegramChatId: ALLOWED_CHANNEL_ID,
        title: 'Koharu Test Channel',
        username: 'koharu_test',
      },
      {
        telegramChatId: secondChannelId,
        title: 'Fixture Channel Two',
        username: 'koharu_fixture_two',
      },
    ]);
    const inbox = new TelegramInboxRepository(connection.db);
    await inbox.bindBot(123_456n);
    await inbox.checkpointBatch(123_456n, [
      channelPostFixture({ updateId: 4_001 }),
      channelPostFixture({ messageId: 43, updateId: 4_002 }),
      channelPostFixture({ channelId: Number(secondChannelId), updateId: 4_003 }),
    ]);

    const writer: Pick<PostgresMessageRepository, 'ingestInTransaction'> = {
      async ingestInTransaction(transaction, post) {
        if (post.channel.telegramChatId === ALLOWED_CHANNEL_ID) {
          await transaction.insert(telegramChannels).values({
            telegramChatId: ALLOWED_CHANNEL_ID,
            title: 'Must roll back',
            username: 'rollback',
          });
          throw new Error('fixture poison failure');
        }
        return {
          channelId: 'fixture-channel',
          messageId: 'fixture-message',
          replayed: false,
        };
      },
    };
    const workers = new TelegramWorkerPool(connection.db, writer, 2);
    await expect(workers.processOne()).resolves.toBe(true);
    await expect(workers.processOne()).resolves.toBe(true);

    const tasks = await connection.db
      .select({
        attemptCount: telegramIngestTasks.attemptCount,
        processedAt: telegramIngestTasks.processedAt,
        telegramUpdateId: telegramIngestTasks.telegramUpdateId,
      })
      .from(telegramIngestTasks)
      .orderBy(asc(telegramIngestTasks.telegramUpdateId));
    expect(tasks[0]).toMatchObject({ attemptCount: 1, processedAt: null });
    expect(tasks[1]).toMatchObject({ attemptCount: 0, processedAt: null });
    expect(tasks[2]?.processedAt).toBeInstanceOf(Date);
    const [rolledBack] = await connection.db
      .select({ id: telegramChannels.id })
      .from(telegramChannels)
      .where(eq(telegramChannels.username, 'rollback'));
    expect(rolledBack).toBeUndefined();

    for (let attempt = 2; attempt <= 10; attempt += 1) {
      await connection.db
        .update(telegramIngestTasks)
        .set({ availableAt: new Date(0) })
        .where(eq(telegramIngestTasks.telegramUpdateId, 4_001n));
      await expect(workers.processOne()).resolves.toBe(true);
    }
    const [blocked] = await connection.db
      .select({
        attemptCount: telegramIngestTasks.attemptCount,
        blockedAt: telegramIngestTasks.blockedAt,
      })
      .from(telegramIngestTasks)
      .where(eq(telegramIngestTasks.telegramUpdateId, 4_001n));
    expect(blocked?.attemptCount).toBe(10);
    expect(blocked?.blockedAt).toBeInstanceOf(Date);
    const [stillBehind] = await connection.db
      .select({ processedAt: telegramIngestTasks.processedAt })
      .from(telegramIngestTasks)
      .where(eq(telegramIngestTasks.telegramUpdateId, 4_002n));
    expect(stillBehind?.processedAt).toBeNull();
  });

  it('claims two channels concurrently without overtaking within one channel', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const secondChannelId = -1_001_234_567_891n;
    await connection.db.insert(telegramChannelAllowlist).values([
      {
        telegramChatId: ALLOWED_CHANNEL_ID,
        title: 'Koharu Test Channel',
        username: 'koharu_test',
      },
      {
        telegramChatId: secondChannelId,
        title: 'Fixture Channel Two',
        username: 'koharu_fixture_two',
      },
    ]);
    const inbox = new TelegramInboxRepository(connection.db);
    await inbox.bindBot(123_456n);
    await inbox.checkpointBatch(123_456n, [
      channelPostFixture({ updateId: 5_001 }),
      channelPostFixture({ messageId: 43, updateId: 5_002 }),
      channelPostFixture({ channelId: Number(secondChannelId), updateId: 5_003 }),
    ]);

    let active = 0;
    let maxActive = 0;
    let release: (() => void) | undefined;
    let bothEntered: (() => void) | undefined;
    const releaseWrites = new Promise<void>((resolve) => {
      release = resolve;
    });
    const twoWritesStarted = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    const seenChannels: bigint[] = [];
    const writer: Pick<PostgresMessageRepository, 'ingestInTransaction'> = {
      async ingestInTransaction(_transaction, post) {
        seenChannels.push(post.channel.telegramChatId);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === 2) {
          bothEntered?.();
        }
        await releaseWrites;
        active -= 1;
        return {
          channelId: 'fixture-channel',
          messageId: 'fixture-message',
          replayed: false,
        };
      },
    };
    const workers = new TelegramWorkerPool(connection.db, writer, 2);
    const first = workers.processOne();
    const second = workers.processOne();
    await twoWritesStarted;
    release?.();
    await Promise.all([first, second]);

    expect(maxActive).toBe(2);
    expect(new Set(seenChannels)).toEqual(new Set([ALLOWED_CHANNEL_ID, secondChannelId]));
    const [laterSameChannel] = await connection.db
      .select({ processedAt: telegramIngestTasks.processedAt })
      .from(telegramIngestTasks)
      .where(eq(telegramIngestTasks.telegramUpdateId, 5_002n));
    expect(laterSameChannel?.processedAt).toBeNull();
  });

  it('validates a public administrator channel before adding it to the allowlist', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const api: TelegramApi = {
      getChat: async () =>
        ({
          id: Number(ALLOWED_CHANNEL_ID),
          title: 'Verified Public Channel',
          type: 'channel',
          username: 'verified_public',
        }) as Awaited<ReturnType<TelegramApi['getChat']>>,
      getChatMember: async () =>
        ({
          status: 'administrator',
          user: {
            first_name: 'Kodama',
            id: 123_456,
            is_bot: true,
          },
        }) as Awaited<ReturnType<TelegramApi['getChatMember']>>,
      getMe: async () =>
        ({
          allows_users_to_create_topics: false,
          can_connect_to_business: false,
          can_join_groups: true,
          can_manage_bots: false,
          can_read_all_group_messages: false,
          first_name: 'Kodama',
          has_main_web_app: false,
          has_topics_enabled: false,
          id: 123_456,
          is_bot: true,
          supports_inline_queries: false,
          supports_join_request_queries: false,
          username: 'kodama_test_bot',
        }) as Awaited<ReturnType<TelegramApi['getMe']>>,
      getUpdates: async () => [],
    };
    const service = new TelegramChannelService(connection.db, api);

    await expect(service.bootstrapLegacy(ALLOWED_CHANNEL_ID)).resolves.toMatchObject({
      telegramChatId: ALLOWED_CHANNEL_ID,
      title: 'Verified Public Channel',
      username: 'verified_public',
    });
    await expect(service.bootstrapLegacy(-1_001_234_567_899n)).resolves.toBeNull();
    await expect(service.list()).resolves.toEqual([
      {
        telegramChatId: ALLOWED_CHANNEL_ID,
        title: 'Verified Public Channel',
        username: 'verified_public',
      },
    ]);
  });

  it('enforces a singleton poller advisory lock per database', async () => {
    if (!container) {
      throw new Error('PostgreSQL test container did not start');
    }

    const firstConnection = createDatabaseConnection(container.getConnectionUri(), { max: 1 });
    const secondConnection = createDatabaseConnection(container.getConnectionUri(), { max: 1 });
    let firstClosed = false;
    try {
      const first = new TelegramInboxRepository(firstConnection.db);
      const second = new TelegramInboxRepository(secondConnection.db);
      await expect(first.acquirePollerLock()).resolves.toBeUndefined();
      await expect(second.acquirePollerLock()).rejects.toThrow('already owns this database');
      await firstConnection.close();
      firstClosed = true;
      await expect(second.acquirePollerLock()).resolves.toBeUndefined();
    } finally {
      if (!firstClosed) {
        await firstConnection.close();
      }
      await secondConnection.close();
    }
  });

  it('backfills existing G1.2 channels when upgrading to the G1.4 migration', async () => {
    if (!container) {
      throw new Error('PostgreSQL test container did not start');
    }

    const databaseName = 'koharu_g14_legacy';
    const adminClient = postgres(container.getConnectionUri(), { max: 1 });
    const legacyUrl = new URL(container.getConnectionUri());
    legacyUrl.pathname = `/${databaseName}`;
    const migrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
    const legacyMigrations = await mkdtemp(join(tmpdir(), 'koharu-g14-migrations-'));

    try {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.unsafe(`create database "${databaseName}"`);
      await mkdir(join(legacyMigrations, 'meta'));
      for (const file of [
        '0000_green_sleepwalker.sql',
        '0001_fancy_carmella_unuscione.sql',
        '0002_majestic_tinkerer.sql',
      ]) {
        await cp(join(migrationRoot, file), join(legacyMigrations, file));
      }
      const journal = JSON.parse(
        await readFile(join(migrationRoot, 'meta/_journal.json'), 'utf8'),
      ) as { entries: Array<{ idx: number }>; version: string; dialect: string };
      await writeFile(
        join(legacyMigrations, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 2) }),
      );

      await runMigrations(legacyUrl.toString(), { migrationsFolder: legacyMigrations });
      const legacyConnection = createDatabaseConnection(legacyUrl.toString());
      try {
        await legacyConnection.db.insert(telegramChannels).values({
          telegramChatId: ALLOWED_CHANNEL_ID,
          title: 'Legacy G1.2 Channel',
          username: 'legacy_g12',
        });
      } finally {
        await legacyConnection.close();
      }

      await runMigrations(legacyUrl.toString());
      const upgradedConnection = createDatabaseConnection(legacyUrl.toString());
      try {
        const [backfilled] = await upgradedConnection.db.select().from(telegramChannelAllowlist);
        expect(backfilled).toMatchObject({
          telegramChatId: ALLOWED_CHANNEL_ID,
          title: 'Legacy G1.2 Channel',
          username: 'legacy_g12',
        });
      } finally {
        await upgradedConnection.close();
      }
    } finally {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end();
      await rm(legacyMigrations, { force: true, recursive: true });
    }
  }, 30_000);
});
