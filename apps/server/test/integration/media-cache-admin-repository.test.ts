import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  mediaCacheBlobs,
  mediaCacheCommands,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  messageMedia,
  messageRevisions,
  messages,
  telegramChannels,
} from '../../src/db/schema.js';
import { PostgresMediaCacheAdminRepository } from '../../src/media-cache/admin-repository.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const MAX_BYTES = 5 * 1024 * 1024 * 1024;

let container: StartedPostgreSqlContainer | undefined;
let connection: DatabaseConnection | undefined;

async function insertObjectFixture(
  databaseConnection: DatabaseConnection,
  input: {
    index: number;
    state: 'blocked' | 'ready';
    updatedAt: Date;
  },
) {
  const [channel] = await databaseConnection.db
    .insert(telegramChannels)
    .values({
      telegramChatId: -1_007_000_000_000n - BigInt(input.index),
      title: `Cache admin ${input.index}`,
    })
    .returning({ id: telegramChannels.id });
  if (!channel) throw new Error('Fixture channel was not created');
  const [message] = await databaseConnection.db
    .insert(messages)
    .values({
      channelId: channel.id,
      publishedAt: input.updatedAt,
      telegramMessageId: BigInt(input.index),
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
      telegramFileId: `private-file-id-${input.index}`,
      telegramFileUniqueId: `private-unique-id-${input.index}`,
    })
    .returning({ id: messageMedia.id });
  if (!media) throw new Error('Fixture media was not created');
  const [plan] = await databaseConnection.db
    .insert(mediaCachePostPlans)
    .values({
      messageId: message.id,
      readyOriginalBytes: input.state === 'ready' ? 128n : 0n,
      revisionId: revision.id,
      state: input.state === 'ready' ? 'ready' : 'blocked',
      updatedAt: input.updatedAt,
    })
    .returning({ id: mediaCachePostPlans.id });
  if (!plan) throw new Error('Fixture plan was not created');

  const sha256 = input.index.toString(16).padStart(64, '0');
  if (input.state === 'ready') {
    await databaseConnection.db.insert(mediaCacheBlobs).values({
      byteLength: 128n,
      detectedMime: 'image/jpeg',
      relativeKey: `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`,
      sha256,
      state: 'ready',
      updatedAt: input.updatedAt,
    });
  }
  const [object] = await databaseConnection.db
    .insert(mediaCacheObjects)
    .values({
      actualBytes: input.state === 'ready' ? 128n : null,
      blobSha256: input.state === 'ready' ? sha256 : null,
      canonicalMediaId: media.id,
      lastErrorClass: input.state === 'blocked' ? 'upstream' : null,
      lastErrorCode: input.state === 'blocked' ? 'download_failed' : null,
      postPlanId: plan.id,
      recipeVersion: 1,
      revisionId: revision.id,
      state: input.state,
      updatedAt: input.updatedAt,
      variant: 'original',
    })
    .returning({ id: mediaCacheObjects.id });
  if (!object) throw new Error('Fixture object was not created');
  return { objectId: object.id, planId: plan.id };
}

describe('PostgreSQL media cache admin repository', () => {
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
        ${mediaCacheObjects},
        ${mediaCacheBlobs},
        ${mediaCachePostPlans},
        ${mediaCacheRuntime},
        ${telegramChannels}
      cascade
    `);
  });

  it('reports disabled empty usage without creating or trusting a runtime row', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const repository = new PostgresMediaCacheAdminRepository(connection.db, {
      enabled: false,
      maxBytes: MAX_BYTES,
    });

    await expect(repository.getStatus()).resolves.toEqual({
      commands: [],
      enabled: false,
      failures: [],
      stateCounts: { blobs: [], objects: [], plans: [] },
      usage: {
        lastReconciledAt: null,
        maxBytes: String(MAX_BYTES),
        readyBytes: '0',
        reservedBytes: '0',
        updatedAt: null,
      },
    });
  });

  it('returns bounded sanitized status and opaque object pages', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const updatedAt = new Date('2026-07-24T08:00:00.000Z');
    const ready = await insertObjectFixture(connection, { index: 1, state: 'ready', updatedAt });
    const blocked = await insertObjectFixture(connection, {
      index: 2,
      state: 'blocked',
      updatedAt,
    });
    await connection.db.insert(mediaCacheRuntime).values({
      maxBytes: 1_024n,
      readyBytes: 128n,
      reservedBytes: 64n,
      updatedAt,
    });
    await connection.db.insert(mediaCacheCommands).values({
      completedAt: updatedAt,
      initiatorId: 'owner-user-id',
      operation: 'reconcile',
      reason: 'verify cache',
      result: { cacheRoot: '/private/cache/root', checked: 2, pages: 1 },
      state: 'succeeded',
      updatedAt,
    });
    const repository = new PostgresMediaCacheAdminRepository(connection.db, {
      enabled: true,
      maxBytes: MAX_BYTES,
    });

    const status = await repository.getStatus();
    expect(status).toMatchObject({
      commands: [
        {
          operation: 'reconcile',
          result: { checked: 2, pages: 1 },
          state: 'succeeded',
        },
      ],
      enabled: true,
      failures: [
        {
          lastErrorClass: 'upstream',
          lastErrorCode: 'download_failed',
          objectId: blocked.objectId,
          planId: blocked.planId,
          state: 'blocked',
        },
      ],
      stateCounts: {
        blobs: [{ count: 1, state: 'ready' }],
        objects: [
          { count: 1, state: 'blocked' },
          { count: 1, state: 'ready' },
        ],
        plans: [
          { count: 1, state: 'blocked' },
          { count: 1, state: 'ready' },
        ],
      },
      usage: {
        maxBytes: '1024',
        readyBytes: '128',
        reservedBytes: '64',
      },
    });
    expect(JSON.stringify(status)).not.toContain('private-file-id');
    expect(JSON.stringify(status)).not.toContain('blobs/');
    expect(JSON.stringify(status)).not.toContain('/private/cache/root');
    expect(JSON.stringify(status)).not.toContain('0000000000000000');

    const first = await repository.listObjects({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    if (!first.nextCursor) throw new Error('Expected another media cache object page');
    const second = await repository.listObjects({
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
      new Set([ready.objectId, blocked.objectId]),
    );
    expect(JSON.stringify([...first.items, ...second.items])).not.toContain('private-file-id');
    expect(JSON.stringify([...first.items, ...second.items])).not.toContain('blobs/');
  });

  it('rejects malformed cursors and unbounded limits', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const repository = new PostgresMediaCacheAdminRepository(connection.db, {
      enabled: true,
      maxBytes: MAX_BYTES,
    });

    await expect(repository.listObjects({ cursor: 'not-a-cursor', limit: 20 })).rejects.toThrow(
      'cursor is invalid',
    );
    await expect(repository.listObjects({ limit: 101 })).rejects.toThrow(
      'limit must be between 1 and 100',
    );
  });
});
