import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { messageRevisions, messages, telegramChannels } from '../../src/db/schema.js';
import { PostgresMessageRepository } from '../../src/messages/repository.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const CHANNEL_A = '10000000-0000-4000-8000-000000000001';
const CHANNEL_B = '10000000-0000-4000-8000-000000000002';
const A_OLDEST = '20000000-0000-4000-8000-000000000001';
const A_EQUAL_LOWER = '20000000-0000-4000-8000-000000000002';
const A_EQUAL_HIGHER = '20000000-0000-4000-8000-000000000003';
const A_TOMBSTONED = '20000000-0000-4000-8000-000000000004';
const A_NEWEST = '20000000-0000-4000-8000-000000000005';
const B_NEWEST = '20000000-0000-4000-8000-000000000006';
const LATE_INSERT = '20000000-0000-4000-8000-000000000007';

describe('message latest and context repository contracts', () => {
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
    if (!connection) throw new Error('Database connection was not created');
    await connection.db.execute(sql`truncate table ${telegramChannels} cascade`);
    await connection.db.insert(telegramChannels).values([
      { id: CHANNEL_A, telegramChatId: -1_001n, title: 'Channel A', username: 'channel_a' },
      { id: CHANNEL_B, telegramChatId: -1_002n, title: 'Channel B', username: 'channel_b' },
    ]);

    const rows = [
      [A_OLDEST, CHANNEL_A, 1n, '2026-07-24T12:00:00.000Z', 'oldest'],
      [A_EQUAL_LOWER, CHANNEL_A, 2n, '2026-07-24T12:01:00.000Z', 'equal lower'],
      [A_EQUAL_HIGHER, CHANNEL_A, 3n, '2026-07-24T12:01:00.000Z', `  ${'preview '.repeat(10)}  `],
      [A_TOMBSTONED, CHANNEL_A, 4n, '2026-07-24T12:02:00.000Z', 'hidden'],
      [A_NEWEST, CHANNEL_A, 5n, '2026-07-24T12:03:00.000Z', 'shared newest'],
      [B_NEWEST, CHANNEL_B, 6n, '2026-07-24T12:04:00.000Z', 'shared other channel'],
    ] as const;
    for (const [id, channelId, telegramMessageId, publishedAt, text] of rows) {
      await connection.db.insert(messages).values({
        channelId,
        id,
        publishedAt: new Date(publishedAt),
        telegramMessageId,
        ...(id === A_TOMBSTONED ? { tombstonedAt: new Date('2026-07-25T00:00:00.000Z') } : {}),
      });
      await connection.db.insert(messageRevisions).values({
        contentKind: 'text',
        entities: [],
        html: `<p>${text.trim()}</p>`,
        messageId: id,
        revisionNumber: 1,
        text,
      });
    }
  });

  it('keeps filtered latest pagination stable across equal timestamps and later inserts', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const repository = new PostgresMessageRepository(connection.db);
    const unfiltered = await repository.listLatestMessages({ channelIds: [], limit: 1 });
    expect(unfiltered.items.map((item) => item.id)).toEqual([B_NEWEST]);

    const first = await repository.listLatestMessages({ channelIds: [CHANNEL_A], limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([A_NEWEST, A_EQUAL_HIGHER]);
    expect(first.nextCursor).toMatchObject({
      channelId: CHANNEL_A,
      messageId: A_EQUAL_HIGHER,
      publishedAt: '2026-07-24T12:01:00.000Z',
    });
    expect(first.nextCursor?.snapshotAt).toMatch(/Z$/u);

    await connection.db.insert(messages).values({
      channelId: CHANNEL_A,
      id: LATE_INSERT,
      publishedAt: new Date('2026-07-24T12:00:30.000Z'),
      telegramMessageId: 7n,
    });
    await connection.db.insert(messageRevisions).values({
      contentKind: 'text',
      entities: [],
      messageId: LATE_INSERT,
      revisionNumber: 1,
      text: 'inserted after the snapshot',
    });

    if (!first.nextCursor) throw new Error('Expected a second page cursor');
    const second = await repository.listLatestMessages({
      channelIds: [CHANNEL_A],
      cursor: first.nextCursor,
      limit: 10,
    });
    expect(second.items.map((item) => item.id)).toEqual([A_EQUAL_LOWER, A_OLDEST]);
    expect(second.nextCursor).toBeNull();

    const search = await repository.searchMessages({
      channelId: null,
      channelIds: [CHANNEL_A],
      from: null,
      limit: 10,
      query: 'shared',
      sort: 'newest',
      to: null,
    });
    expect(search?.items.map((item) => item.message.id)).toEqual([A_NEWEST]);
  });

  it('returns same-channel tuple neighbors while skipping tombstones', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const repository = new PostgresMessageRepository(connection.db);
    const context = await repository.getMessageContext(A_EQUAL_HIGHER);

    expect(context?.message.id).toBe(A_EQUAL_HIGHER);
    expect(context?.newer).toEqual({
      channelId: CHANNEL_A,
      id: A_NEWEST,
      preview: 'shared newest',
      publishedAt: '2026-07-24T12:03:00.000Z',
    });
    expect(context?.older).toEqual({
      channelId: CHANNEL_A,
      id: A_EQUAL_LOWER,
      preview: 'equal lower',
      publishedAt: '2026-07-24T12:01:00.000Z',
    });
    expect(context?.newer?.id).not.toBe(B_NEWEST);
    expect(await repository.getMessageContext(A_TOMBSTONED)).toBeNull();

    const lower = await repository.getMessageContext(A_EQUAL_LOWER);
    expect(lower?.newer?.id).toBe(A_EQUAL_HIGHER);
    expect(Array.from(lower?.newer?.preview ?? '')).toHaveLength(40);
    const oldest = await repository.getMessageContext(A_OLDEST);
    expect(oldest?.older).toBeNull();
  });
});
