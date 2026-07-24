import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { mediaBlobLocations, mediaCacheBlobs, mediaStorageBackends } from '../../src/db/schema.js';
import {
  reconcileLocalStorageLedger,
  type S3StorageBackendConfig,
  StorageLedgerRepository,
} from '../../src/media-cache/storage-ledger-repository.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const GIB = 1024n * 1024n * 1024n;
const CREATED_AT = new Date('2026-07-24T09:00:00.000Z');
const UPDATED_AT = new Date('2026-07-24T09:05:00.000Z');
const EVICTION_EXPIRES_AT = new Date('2026-07-24T09:10:00.000Z');
const EVICTION_TOKEN = randomUUID();
const S3_CONFIG: S3StorageBackendConfig = {
  bucket: 'archive',
  endpointOrigin: 'http://minio:9000',
  forcePathStyle: true,
  maxBytes: 5n * GIB,
  prefix: 'koharu',
  region: 'us-east-1',
};

let container: StartedPostgreSqlContainer | undefined;
let connection: DatabaseConnection | undefined;

function sha256(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function storageKey(hash: string): string {
  return `blobs/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

async function insertLegacyBlob(
  databaseConnection: DatabaseConnection,
  input: {
    byteLength: bigint;
    seed: string;
    state: 'deleting' | 'evicted' | 'missing' | 'ready';
  },
) {
  const hash = sha256(input.seed);
  await databaseConnection.db.insert(mediaCacheBlobs).values({
    byteLength: input.byteLength,
    createdAt: CREATED_AT,
    detectedMime: 'image/jpeg',
    evictionExpiresAt: input.state === 'deleting' ? EVICTION_EXPIRES_AT : null,
    evictionOwner: input.state === 'deleting' ? 'g2.4-test' : null,
    evictionToken: input.state === 'deleting' ? EVICTION_TOKEN : null,
    lastAccessedAt: CREATED_AT,
    relativeKey: storageKey(hash),
    sha256: hash,
    state: input.state,
    updatedAt: UPDATED_AT,
  });
  return hash;
}

function repository(databaseConnection: DatabaseConnection) {
  return new StorageLedgerRepository(databaseConnection.db);
}

describe('storage ledger bootstrap', () => {
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
        ${mediaBlobLocations},
        ${mediaStorageBackends},
        ${mediaCacheBlobs}
      cascade
    `);
  }, 30_000);

  it('backfills populated legacy blobs with physical identity and deletion leases', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const readySha = await insertLegacyBlob(connection, {
      byteLength: 400n,
      seed: 'a',
      state: 'ready',
    });
    const deletingSha = await insertLegacyBlob(connection, {
      byteLength: 300n,
      seed: 'b',
      state: 'deleting',
    });
    await insertLegacyBlob(connection, { byteLength: 200n, seed: 'c', state: 'evicted' });
    await insertLegacyBlob(connection, { byteLength: 100n, seed: 'd', state: 'missing' });

    const result = await repository(connection).bootstrap({
      local: { maxBytes: 2n * GIB, root: '/var/lib/koharu/media' },
      s3: S3_CONFIG,
    });
    const locations = await connection.db
      .select()
      .from(mediaBlobLocations)
      .where(eq(mediaBlobLocations.backendId, 'local'))
      .orderBy(asc(mediaBlobLocations.blobSha256));
    const backends = await connection.db
      .select({
        id: mediaStorageBackends.id,
        readPriority: mediaStorageBackends.readPriority,
        writePriority: mediaStorageBackends.writePriority,
      })
      .from(mediaStorageBackends)
      .orderBy(asc(mediaStorageBackends.id));

    expect(result.local).toMatchObject({
      enabled: true,
      id: 'local',
      maxBytes: 2n * GIB,
      readable: true,
      readyBytes: 700n,
      writable: true,
    });
    expect(result.s3).toMatchObject({
      enabled: true,
      id: 's3-default',
      readable: true,
      readyBytes: 0n,
      writable: true,
    });
    expect(backends).toEqual([
      { id: 'local', readPriority: 0, writePriority: 100 },
      { id: 's3-default', readPriority: 100, writePriority: 0 },
    ]);
    expect(locations).toHaveLength(4);
    expect(locations.find((location) => location.blobSha256 === readySha)).toMatchObject({
      mutationExpiresAt: null,
      mutationOwner: null,
      mutationToken: null,
      state: 'ready',
      storageKey: storageKey(readySha),
      verifiedAt: UPDATED_AT,
      verifiedByteLength: 400n,
      verifiedSha256: readySha,
    });
    expect(locations.find((location) => location.blobSha256 === deletingSha)).toMatchObject({
      mutationExpiresAt: EVICTION_EXPIRES_AT,
      mutationOwner: 'g2.4-test',
      mutationToken: EVICTION_TOKEN,
      state: 'deleting',
      verifiedAt: UPDATED_AT,
      verifiedByteLength: 300n,
      verifiedSha256: deletingSha,
    });
    for (const state of ['evicted', 'missing'] as const) {
      expect(locations.find((location) => location.state === state)).toMatchObject({
        mutationExpiresAt: null,
        mutationOwner: null,
        mutationToken: null,
        verifiedAt: null,
        verifiedByteLength: null,
        verifiedSha256: null,
      });
    }
  });

  it('keyset-backfills more than one batch without duplicate locations', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const blobs = Array.from({ length: 501 }, (_, index) => {
      const hash = index.toString(16).padStart(64, '0');
      return {
        byteLength: 1n,
        createdAt: CREATED_AT,
        detectedMime: 'image/jpeg' as const,
        lastAccessedAt: CREATED_AT,
        relativeKey: storageKey(hash),
        sha256: hash,
        state: 'ready' as const,
        updatedAt: UPDATED_AT,
      };
    });
    await connection.db.insert(mediaCacheBlobs).values(blobs);
    const storageLedger = repository(connection);
    const input = {
      local: { maxBytes: 2n * GIB, root: '/var/lib/koharu/media' },
    };

    const first = await storageLedger.bootstrap(input);
    const second = await storageLedger.bootstrap(input);
    const [count] = await connection.db
      .select({ locations: sql<string>`count(*)::text` })
      .from(mediaBlobLocations)
      .where(eq(mediaBlobLocations.backendId, 'local'));

    expect(first.local.readyBytes).toBe(501n);
    expect(second.local.readyBytes).toBe(501n);
    expect(count?.locations).toBe('501');
  });

  it('is idempotent and treats existing locations as the authoritative byte ledger', async () => {
    if (!connection) throw new Error('Database connection was not created');
    await insertLegacyBlob(connection, { byteLength: 600n, seed: 'e', state: 'ready' });
    const storageLedger = repository(connection);
    const input = {
      local: { maxBytes: 2n * GIB, root: '/var/lib/koharu/media' },
      s3: S3_CONFIG,
    };

    await storageLedger.bootstrap(input);
    await connection.db
      .update(mediaBlobLocations)
      .set({
        state: 'evicted',
        verifiedAt: null,
        verifiedByteLength: null,
        verifiedSha256: null,
      })
      .where(eq(mediaBlobLocations.backendId, 'local'));
    await connection.db
      .update(mediaStorageBackends)
      .set({ readyBytes: 9_999n })
      .where(eq(mediaStorageBackends.id, 'local'));
    const second = await storageLedger.bootstrap(input);
    const [counts] = await connection.db
      .select({
        backends: sql<string>`(select count(*) from ${mediaStorageBackends})::text`,
        locations: sql<string>`(select count(*) from ${mediaBlobLocations})::text`,
      })
      .from(mediaStorageBackends)
      .limit(1);
    const [localLocation] = await connection.db
      .select({ state: mediaBlobLocations.state })
      .from(mediaBlobLocations)
      .where(eq(mediaBlobLocations.backendId, 'local'));

    expect(second.local.readyBytes).toBe(0n);
    expect(counts).toEqual({ backends: '2', locations: '1' });
    expect(localLocation?.state).toBe('evicted');
  });

  it('preserves fresh local mutation leases and only repairs expired locations', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const copyingSha = await insertLegacyBlob(connection, {
      byteLength: 100n,
      seed: '5',
      state: 'evicted',
    });
    const deletingSha = await insertLegacyBlob(connection, {
      byteLength: 200n,
      seed: '6',
      state: 'ready',
    });
    const expiredSha = await insertLegacyBlob(connection, {
      byteLength: 300n,
      seed: '7',
      state: 'ready',
    });
    await repository(connection).bootstrap({
      local: { maxBytes: 2n * GIB, root: '/var/lib/koharu/media' },
    });
    const copyingToken = randomUUID();
    const deletingToken = randomUUID();
    const expiredToken = randomUUID();
    const freshExpiry = new Date(Date.now() + 60_000);
    await connection.db
      .update(mediaBlobLocations)
      .set({
        mutationExpiresAt: freshExpiry,
        mutationOwner: 'copy-worker',
        mutationToken: copyingToken,
        state: 'copying',
      })
      .where(eq(mediaBlobLocations.blobSha256, copyingSha));
    await connection.db
      .update(mediaBlobLocations)
      .set({
        mutationExpiresAt: freshExpiry,
        mutationOwner: 'delete-worker',
        mutationToken: deletingToken,
        state: 'deleting',
      })
      .where(eq(mediaBlobLocations.blobSha256, deletingSha));
    await connection.db
      .update(mediaBlobLocations)
      .set({
        mutationExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
        mutationOwner: 'expired-worker',
        mutationToken: expiredToken,
        state: 'copying',
        verifiedAt: null,
        verifiedByteLength: null,
        verifiedSha256: null,
      })
      .where(eq(mediaBlobLocations.blobSha256, expiredSha));
    await connection.db
      .update(mediaStorageBackends)
      .set({ readyBytes: 9_999n })
      .where(eq(mediaStorageBackends.id, 'local'));

    await connection.db.transaction(async (transaction) => {
      await reconcileLocalStorageLedger(transaction);
    });

    const locations = await connection.db
      .select({
        mutationToken: mediaBlobLocations.mutationToken,
        sha256: mediaBlobLocations.blobSha256,
        state: mediaBlobLocations.state,
        verifiedByteLength: mediaBlobLocations.verifiedByteLength,
      })
      .from(mediaBlobLocations)
      .where(eq(mediaBlobLocations.backendId, 'local'))
      .orderBy(asc(mediaBlobLocations.blobSha256));
    expect(locations).toEqual([
      {
        mutationToken: copyingToken,
        sha256: copyingSha,
        state: 'copying',
        verifiedByteLength: null,
      },
      {
        mutationToken: deletingToken,
        sha256: deletingSha,
        state: 'deleting',
        verifiedByteLength: 200n,
      },
      {
        mutationToken: null,
        sha256: expiredSha,
        state: 'ready',
        verifiedByteLength: 300n,
      },
    ]);
    const [local] = await connection.db
      .select({ readyBytes: mediaStorageBackends.readyBytes })
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 'local'));
    expect(local?.readyBytes).toBe(500n);
  });

  it('records a capacity downshift even when the local backend is already over budget', async () => {
    if (!connection) throw new Error('Database connection was not created');
    await insertLegacyBlob(connection, { byteLength: 700n, seed: 'f', state: 'ready' });
    await insertLegacyBlob(connection, { byteLength: 400n, seed: '0', state: 'deleting' });
    const storageLedger = repository(connection);

    await storageLedger.bootstrap({
      local: { maxBytes: 2_000n, root: '/var/lib/koharu/media' },
    });
    const [beforeDownshift] = await connection.db
      .select({ configFingerprint: mediaStorageBackends.configFingerprint })
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 'local'));
    const downshifted = await storageLedger.bootstrap({
      local: { maxBytes: 500n, root: '/var/lib/koharu/media' },
    });
    const [local] = await connection.db
      .select({
        configFingerprint: mediaStorageBackends.configFingerprint,
        readPriority: mediaStorageBackends.readPriority,
        writePriority: mediaStorageBackends.writePriority,
      })
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 'local'));

    expect(downshifted.local).toMatchObject({
      maxBytes: 500n,
      readyBytes: 1_100n,
    });
    expect(local).toEqual({
      configFingerprint: beforeDownshift?.configFingerprint,
      readPriority: 0,
      writePriority: 0,
    });
  });

  it('disables S3 without deleting its locations and counts deleting bytes', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const blobSha256 = await insertLegacyBlob(connection, {
      byteLength: 800n,
      seed: '1',
      state: 'ready',
    });
    const storageLedger = repository(connection);
    await storageLedger.bootstrap({
      local: { maxBytes: 2n * GIB, root: '/var/lib/koharu/media' },
      s3: S3_CONFIG,
    });
    await connection.db.insert(mediaBlobLocations).values({
      backendId: 's3-default',
      blobSha256,
      mutationExpiresAt: EVICTION_EXPIRES_AT,
      mutationOwner: 'g2.4-test',
      mutationToken: EVICTION_TOKEN,
      state: 'deleting',
      storageKey: storageKey(blobSha256),
      verifiedAt: UPDATED_AT,
      verifiedByteLength: 800n,
      verifiedSha256: blobSha256,
    });
    await connection.db
      .update(mediaStorageBackends)
      .set({ readyBytes: 9_999n })
      .where(eq(mediaStorageBackends.id, 's3-default'));

    await storageLedger.bootstrap({
      local: { maxBytes: 2n * GIB, root: '/var/lib/koharu/media' },
    });
    const [s3] = await connection.db
      .select()
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 's3-default'));
    const [location] = await connection.db
      .select()
      .from(mediaBlobLocations)
      .where(eq(mediaBlobLocations.backendId, 's3-default'));

    expect(s3).toMatchObject({
      enabled: false,
      readable: false,
      readyBytes: 800n,
      writable: false,
    });
    expect(location).toMatchObject({
      backendId: 's3-default',
      blobSha256,
      state: 'deleting',
    });
  });

  it('fails closed when the local namespace changes while locations exist', async () => {
    if (!connection) throw new Error('Database connection was not created');
    await insertLegacyBlob(connection, { byteLength: 100n, seed: '2', state: 'ready' });
    const storageLedger = repository(connection);
    await storageLedger.bootstrap({
      local: { maxBytes: 2n * GIB, root: '/var/lib/koharu/media-a' },
    });
    const [before] = await connection.db
      .select()
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 'local'));

    await expect(
      storageLedger.bootstrap({
        local: { maxBytes: 3n * GIB, root: '/var/lib/koharu/media-b' },
      }),
    ).rejects.toThrow('Storage backend local namespace changed while locations still exist');
    const [after] = await connection.db
      .select()
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 'local'));

    expect(after).toEqual(before);
  });

  it('fails closed when the S3 bucket or prefix changes while locations exist', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const blobSha256 = await insertLegacyBlob(connection, {
      byteLength: 100n,
      seed: '3',
      state: 'ready',
    });
    const storageLedger = repository(connection);
    const input = {
      local: { maxBytes: 2n * GIB, root: '/var/lib/koharu/media' },
      s3: S3_CONFIG,
    };
    await storageLedger.bootstrap(input);
    await connection.db.insert(mediaBlobLocations).values({
      backendId: 's3-default',
      blobSha256,
      state: 'ready',
      storageKey: storageKey(blobSha256),
      verifiedAt: UPDATED_AT,
      verifiedByteLength: 100n,
      verifiedSha256: blobSha256,
    });
    const [before] = await connection.db
      .select()
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 's3-default'));

    await expect(
      storageLedger.bootstrap({
        ...input,
        s3: { ...S3_CONFIG, bucket: 'other-archive' },
      }),
    ).rejects.toThrow('Storage backend s3-default namespace changed while locations still exist');
    await expect(
      storageLedger.bootstrap({
        ...input,
        s3: { ...S3_CONFIG, prefix: 'other-prefix' },
      }),
    ).rejects.toThrow('Storage backend s3-default namespace changed while locations still exist');
    const [after] = await connection.db
      .select()
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 's3-default'));

    expect(after).toEqual(before);
  });
});
