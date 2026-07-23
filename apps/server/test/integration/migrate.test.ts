import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { count } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  messageMedia,
  messageRevisions,
  messages,
  telegramChannels,
  telegramUpdates,
} from '../../src/db/schema.js';
import { PostgresMessageRepository } from '../../src/messages/repository.js';
import { normalizeChannelPost } from '../../src/telegram/normalize.js';
import { channelPostFixture } from '../fixtures/telegram.js';

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
});
