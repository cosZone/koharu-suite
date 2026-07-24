import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, count, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  telegramChannelAllowlist,
  telegramIngestTasks,
  telegramPollingState,
  telegramPollReceipts,
} from '../../src/db/schema.js';
import { TelegramInboxRepository } from '../../src/telegram/inbox-repository.js';
import { channelPostFixture } from '../fixtures/telegram.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const BOT_ID = 123_456n;
const FIRST_CHANNEL_ID = -1_001_234_567_890n;
const SECOND_CHANNEL_ID = -1_001_234_567_891n;

describe('Telegram poll receipts', () => {
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
      sql`truncate table ${telegramChannelAllowlist}, ${telegramPollingState} cascade`,
    );
  });

  it('checkpoints privacy-safe non-empty receipts with tasks and the cursor', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    await connection.db.insert(telegramChannelAllowlist).values([
      {
        telegramChatId: FIRST_CHANNEL_ID,
        title: 'First allowed channel',
      },
      {
        telegramChatId: SECOND_CHANNEL_ID,
        title: 'Second allowed channel',
      },
    ]);
    const inbox = new TelegramInboxRepository(connection.db);
    await inbox.bindBot(BOT_ID);

    await expect(
      inbox.checkpointBatch(BOT_ID, null, [
        channelPostFixture({ channelId: Number(FIRST_CHANNEL_ID), updateId: 2_001 }),
        channelPostFixture({ channelId: -1_001_234_567_899, updateId: 2_002 }),
        channelPostFixture({ channelId: Number(SECOND_CHANNEL_ID), updateId: 2_003 }),
      ]),
    ).resolves.toBe(2_004n);

    const [receipt] = await connection.db.select().from(telegramPollReceipts);
    expect(receipt).toMatchObject({
      acceptedCount: 2,
      botId: BOT_ID,
      checkpointOffset: 2_004n,
      ignoredCount: 1,
      requestedOffset: null,
      returnedCount: 3,
      returnedFirstUpdateId: 2_001n,
      returnedLastUpdateId: 2_003n,
    });
    expect(receipt?.completedAt).toBeInstanceOf(Date);
    expect(Object.keys(receipt ?? {})).not.toContain('rawJson');

    const tasks = await connection.db
      .select({ telegramUpdateId: telegramIngestTasks.telegramUpdateId })
      .from(telegramIngestTasks)
      .orderBy(asc(telegramIngestTasks.telegramUpdateId));
    expect(tasks).toEqual([{ telegramUpdateId: 2_001n }, { telegramUpdateId: 2_003n }]);
    const [state] = await connection.db.select().from(telegramPollingState);
    expect(state?.nextUpdateId).toBe(2_004n);
  });

  it('writes no empty receipt and rejects offset mismatch or stale replay atomically', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    await connection.db.insert(telegramChannelAllowlist).values({
      telegramChatId: FIRST_CHANNEL_ID,
      title: 'Allowed channel',
    });
    const inbox = new TelegramInboxRepository(connection.db);
    await inbox.bindBot(BOT_ID);
    const initialBatch = [
      channelPostFixture({ channelId: Number(FIRST_CHANNEL_ID), updateId: 2_001 }),
      channelPostFixture({ channelId: Number(FIRST_CHANNEL_ID), updateId: 2_003 }),
    ];

    await inbox.checkpointBatch(BOT_ID, null, initialBatch);
    await expect(inbox.checkpointBatch(BOT_ID, 2_004n, [])).resolves.toBe(2_004n);
    await expect(
      inbox.checkpointBatch(BOT_ID, 1_999n, [
        channelPostFixture({ channelId: Number(FIRST_CHANNEL_ID), updateId: 2_004 }),
      ]),
    ).rejects.toThrow('request offset does not match');
    await expect(inbox.checkpointBatch(BOT_ID, 2_004n, initialBatch)).rejects.toThrow(
      'older than the requested offset',
    );

    const receipts = await connection.db
      .select({
        checkpointOffset: telegramPollReceipts.checkpointOffset,
        requestedOffset: telegramPollReceipts.requestedOffset,
      })
      .from(telegramPollReceipts)
      .orderBy(asc(telegramPollReceipts.checkpointOffset));
    expect(receipts).toEqual([{ checkpointOffset: 2_004n, requestedOffset: null }]);

    const [taskCount] = await connection.db.select({ value: count() }).from(telegramIngestTasks);
    expect(taskCount?.value).toBe(2);
    const [state] = await connection.db.select().from(telegramPollingState);
    expect(state?.nextUpdateId).toBe(2_004n);
  });
});
