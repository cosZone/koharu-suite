import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { mediaCacheBlobs, mediaCacheRuntime } from '../../src/db/schema.js';
import { LocalMediaBlobStore } from '../../src/media-cache/blob-store.js';
import { createMediaCacheWorkerRuntime } from '../../src/media-cache/runtime.js';
import { GrammyTelegramApi } from '../../src/telegram/api.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
let container: StartedPostgreSqlContainer | undefined;
let connection: DatabaseConnection | undefined;

describe('PostgreSQL media cache worker runtime configuration', () => {
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
      truncate table ${mediaCacheBlobs}, ${mediaCacheRuntime} cascade
    `);
  });

  it('uses the database clock while applying a smaller cap and evicting bounded LRU excess', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const database = connection.db;
    const root = await mkdtemp(join(tmpdir(), 'koharu-media-runtime-'));
    try {
      const blobStore = new LocalMediaBlobStore(root);
      await blobStore.initialize();
      const lease = { leaseToken: randomUUID(), planId: randomUUID() };
      const staged = await blobStore.stage({
        lease,
        maxBytes: 128,
        objectId: randomUUID(),
        source: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(128).fill(7));
            controller.close();
          },
        }),
      });
      const published = await blobStore.publish(staged);
      await blobStore.settle(staged, 'db_committed');
      await database.insert(mediaCacheRuntime).values({
        maxBytes: 5n * 1024n * 1024n * 1024n,
        readyBytes: 128n,
      });
      await database.insert(mediaCacheBlobs).values({
        byteLength: 128n,
        detectedMime: 'image/jpeg',
        relativeKey: published.relativeKey,
        sha256: published.sha256,
        state: 'ready',
      });

      const runtime = createMediaCacheWorkerRuntime({
        botToken: 'test-token',
        config: {
          downloadConcurrency: 2,
          enabled: true,
          maxBytes: 64,
          root,
        },
        database,
        leaseOwner: 'runtime-test',
        telegramApi: new GrammyTelegramApi('test-token'),
      });
      const hostClock = vi.spyOn(Date, 'now').mockReturnValue(0);
      try {
        await runtime.initialize();
        void runtime.start();
        await vi.waitFor(
          async () => {
            const [blob] = await database
              .select({ state: mediaCacheBlobs.state })
              .from(mediaCacheBlobs)
              .where(eq(mediaCacheBlobs.sha256, published.sha256));
            expect(blob?.state).toBe('evicted');
          },
          { timeout: 5_000 },
        );
      } finally {
        hostClock.mockRestore();
      }

      const [configured] = await database
        .select({
          maxBytes: mediaCacheRuntime.maxBytes,
          readyBytes: mediaCacheRuntime.readyBytes,
        })
        .from(mediaCacheRuntime)
        .where(eq(mediaCacheRuntime.singletonKey, 'local'));
      expect(configured).toEqual({ maxBytes: 64n, readyBytes: 0n });
      await expect(blobStore.open(published)).rejects.toThrow();

      await runtime.stop();
      await expect(runtime.done).resolves.toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
