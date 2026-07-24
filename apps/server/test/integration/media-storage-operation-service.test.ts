import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  mediaBlobLocations,
  mediaCacheActions,
  mediaCacheBlobs,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  mediaStorageBackends,
  messageMedia,
  messageRevisions,
  messages,
  telegramChannels,
} from '../../src/db/schema.js';
import {
  LocalMediaBlobStore,
  type MediaBlobIdentity,
  MediaBlobIntegrityError,
} from '../../src/media-cache/blob-store.js';
import type { CommandStorageOperationInput } from '../../src/media-cache/command-queue.js';
import {
  LocalPersistentBlobBackend,
  type PersistentBlobBackend,
  PersistentBlobBackendRegistry,
  type PersistentBlobPutInput,
} from '../../src/media-cache/local-persistent-blob-backend.js';
import {
  PostgresLegacyLocalRestoreFinalizer,
  PostgresStorageOperationService,
} from '../../src/media-cache/storage-operation-service.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const NOW = new Date('2026-07-24T10:00:00.000Z');
let container: StartedPostgreSqlContainer | undefined;
let connection: DatabaseConnection | undefined;
let fixtureIndex = 0;
const temporaryRoots: string[] = [];

function stream(content: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(content);
      controller.close();
    },
  });
}

async function consume(source: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function blobIdentity(content: Buffer): MediaBlobIdentity {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    byteLength: content.byteLength,
    relativeKey: `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`,
    sha256,
  };
}

function memoryBackend(input: {
  close?: () => Promise<void>;
  content: Buffer;
  id: PersistentBlobBackend['id'];
  put?: (input: PersistentBlobPutInput) => Promise<{ outcome: 'already_present' | 'created' }>;
}): PersistentBlobBackend {
  return {
    id: input.id,
    async delete() {
      return 'absent_or_deleted';
    },
    put:
      input.put ??
      (async (putInput) => {
        await consume(putInput.source);
        return { outcome: 'created' };
      }),
    async read() {
      return {
        byteLength: input.content.byteLength,
        close: input.close ?? (async () => undefined),
        stream: () => stream(input.content),
      };
    },
  };
}

async function insertBackend(
  id: 'local' | 's3-default',
  input: { maxBytes?: bigint; readyBytes?: bigint } = {},
): Promise<void> {
  if (!connection) throw new Error('Database connection was not created');
  await connection.db.insert(mediaStorageBackends).values({
    configFingerprint: (id === 'local' ? 'a' : 'b').repeat(64),
    id,
    kind: id === 'local' ? 'local' : 's3',
    label: id,
    maxBytes: input.maxBytes ?? 5_368_709_120n,
    readPriority: id === 'local' ? 0 : 100,
    readyBytes: input.readyBytes ?? 0n,
    writePriority: id === 's3-default' ? 0 : 100,
  });
}

async function insertBlobFixture(input: {
  content: Buffer;
  objectCount?: number;
  objectState?: 'evicted' | 'ready';
  sourceBackendId: 'local' | 's3-default';
}) {
  if (!connection) throw new Error('Database connection was not created');
  fixtureIndex += 1;
  const identity = blobIdentity(input.content);
  const objectState = input.objectState ?? 'ready';
  await connection.db.insert(mediaCacheBlobs).values({
    byteLength: BigInt(identity.byteLength),
    detectedMime: 'image/jpeg',
    relativeKey: identity.relativeKey,
    sha256: identity.sha256,
    state: objectState === 'ready' ? 'ready' : 'evicted',
  });
  await connection.db.insert(mediaBlobLocations).values({
    backendId: input.sourceBackendId,
    blobSha256: identity.sha256,
    state: 'ready',
    storageKey: identity.relativeKey,
    verifiedAt: NOW,
    verifiedByteLength: BigInt(identity.byteLength),
    verifiedSha256: identity.sha256,
  });
  await connection.db
    .update(mediaStorageBackends)
    .set({ readyBytes: BigInt(identity.byteLength) })
    .where(eq(mediaStorageBackends.id, input.sourceBackendId));
  const [channel] = await connection.db
    .insert(telegramChannels)
    .values({
      telegramChatId: -1_020_000_000_000n - BigInt(fixtureIndex),
      title: `Storage operation ${fixtureIndex}`,
    })
    .returning({ id: telegramChannels.id });
  if (!channel) throw new Error('Fixture channel was not created');
  const [message] = await connection.db
    .insert(messages)
    .values({
      channelId: channel.id,
      publishedAt: NOW,
      telegramMessageId: BigInt(fixtureIndex),
    })
    .returning({ id: messages.id });
  if (!message) throw new Error('Fixture message was not created');
  const [revision] = await connection.db
    .insert(messageRevisions)
    .values({
      contentKind: 'none',
      entities: [],
      messageId: message.id,
      revisionNumber: 1,
    })
    .returning({ id: messageRevisions.id });
  if (!revision) throw new Error('Fixture revision was not created');
  const objectCount = input.objectCount ?? 1;
  const media = await connection.db
    .insert(messageMedia)
    .values(
      Array.from({ length: objectCount }, (_, position) => ({
        kind: 'photo' as const,
        position,
        revisionId: revision.id,
        sourceKind: 'telegram_bot_update' as const,
        telegramFileId: `storage-file-${fixtureIndex}-${position}`,
        telegramFileUniqueId: `storage-unique-${fixtureIndex}-${position}`,
      })),
    )
    .returning({ id: messageMedia.id });
  const [plan] = await connection.db
    .insert(mediaCachePostPlans)
    .values({
      messageId: message.id,
      readyOriginalBytes: objectState === 'ready' ? BigInt(identity.byteLength * objectCount) : 0n,
      revisionId: revision.id,
      state: 'ready',
    })
    .returning({ id: mediaCachePostPlans.id });
  if (!plan) throw new Error('Fixture plan was not created');
  const objects = await connection.db
    .insert(mediaCacheObjects)
    .values(
      media.map(({ id }) => ({
        actualBytes: BigInt(identity.byteLength),
        blobSha256: identity.sha256,
        canonicalMediaId: id,
        postPlanId: plan.id,
        recipeVersion: 1,
        revisionId: revision.id,
        state: objectState,
        variant: 'original' as const,
      })),
    )
    .returning({ id: mediaCacheObjects.id });
  return { identity, objectIds: objects.map(({ id }) => id) };
}

function migrateInput(
  objectId: string,
): CommandStorageOperationInput<'migrate'> & { renewLease: ReturnType<typeof vi.fn> } {
  return {
    command: {
      id: randomUUID(),
      initiatorId: 'owner',
      initiatorKind: 'owner_session',
      objectId,
      operation: 'migrate',
      reason: 'copy to durable storage',
      sourceBackendId: 'local',
      targetBackendId: 's3-default',
      targetBytes: null,
      token: randomUUID(),
    },
    renewLease: vi.fn(async () => undefined),
  };
}

function restoreInput(objectId: string): CommandStorageOperationInput<'restore'> {
  return {
    command: {
      id: randomUUID(),
      initiatorId: 'owner',
      initiatorKind: 'owner_session',
      objectId,
      operation: 'restore',
      reason: 'restore local hot copy',
      sourceBackendId: null,
      targetBackendId: 'local',
      targetBytes: null,
      token: randomUUID(),
    },
    renewLease: vi.fn(async () => undefined),
  };
}

describe('PostgreSQL storage copy operations', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations(container.getConnectionUri());
    connection = createDatabaseConnection(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await container?.stop();
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  }, 30_000);

  beforeEach(async () => {
    if (!connection) throw new Error('Database connection was not created');
    await connection.db.execute(sql`
      truncate table
        ${mediaCacheActions},
        ${mediaBlobLocations},
        ${mediaStorageBackends},
        ${mediaCacheObjects},
        ${mediaCacheBlobs},
        ${mediaCachePostPlans},
        ${mediaCacheRuntime},
        ${telegramChannels}
      cascade
    `);
  });

  it('migrates one shared local blob once and then converges idempotently', async () => {
    if (!connection) throw new Error('Database connection was not created');
    await insertBackend('local');
    await insertBackend('s3-default');
    const content = Buffer.from('shared local blob');
    const fixture = await insertBlobFixture({
      content,
      objectCount: 2,
      sourceBackendId: 'local',
    });
    const put = vi.fn(async (input: PersistentBlobPutInput) => {
      expect(await consume(input.source)).toEqual(content);
      if (!connection) throw new Error('Database connection was not created');
      await connection.db
        .update(mediaStorageBackends)
        .set({ maxBytes: 1n })
        .where(eq(mediaStorageBackends.id, 's3-default'));
      return { outcome: 'created' as const };
    });
    const service = new PostgresStorageOperationService(
      connection.db,
      new PersistentBlobBackendRegistry([
        memoryBackend({ content, id: 'local' }),
        memoryBackend({ content, id: 's3-default', put }),
      ]),
    );
    const command = migrateInput(fixture.objectIds[0] ?? '');

    await expect(service.migrate(command)).resolves.toMatchObject({
      hasMore: false,
      migratedBlobCount: 1,
      migratedBytes: String(content.byteLength),
      sourceBackendId: 'local',
      targetBackendId: 's3-default',
    });
    await expect(service.migrate(migrateInput(fixture.objectIds[1] ?? ''))).resolves.toMatchObject({
      alreadyApplied: true,
      hasMore: false,
      migratedBlobCount: 0,
      migratedBytes: '0',
    });
    expect(put).toHaveBeenCalledOnce();
    const [target] = await connection.db
      .select()
      .from(mediaBlobLocations)
      .where(
        and(
          eq(mediaBlobLocations.backendId, 's3-default'),
          eq(mediaBlobLocations.blobSha256, fixture.identity.sha256),
        ),
      );
    const [backend] = await connection.db
      .select({
        maxBytes: mediaStorageBackends.maxBytes,
        readyBytes: mediaStorageBackends.readyBytes,
      })
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 's3-default'));
    const [action] = await connection.db
      .select()
      .from(mediaCacheActions)
      .where(eq(mediaCacheActions.actionKind, 'migrate'));
    expect(target).toMatchObject({
      mutationToken: null,
      state: 'ready',
      verifiedByteLength: BigInt(content.byteLength),
      verifiedSha256: fixture.identity.sha256,
    });
    expect(backend).toEqual({
      maxBytes: 1n,
      readyBytes: BigInt(content.byteLength),
    });
    expect(action).toMatchObject({
      objectId: fixture.objectIds[0],
      actionKind: 'migrate',
    });
    expect(action?.afterState).toEqual({
      byteLength: String(content.byteLength),
      sourceBackendId: 'local',
      state: 'ready',
      targetBackendId: 's3-default',
    });
  });

  it('restores shared legacy objects and the local location without double-counting', async () => {
    if (!connection) throw new Error('Database connection was not created');
    await insertBackend('local');
    await insertBackend('s3-default');
    const content = Buffer.from('restore from S3');
    const fixture = await insertBlobFixture({
      content,
      objectCount: 2,
      objectState: 'evicted',
      sourceBackendId: 's3-default',
    });
    const root = await mkdtemp(join(tmpdir(), 'koharu-storage-restore-'));
    temporaryRoots.push(root);
    const store = new LocalMediaBlobStore(root);
    await store.initialize();
    await connection.db.insert(mediaCacheRuntime).values({
      maxBytes: 5_368_709_120n,
      singletonKey: 'local',
    });
    const localBackend = new LocalPersistentBlobBackend(store);
    const capacityDownshiftLocalBackend: PersistentBlobBackend = {
      ...localBackend,
      id: 'local',
      delete: localBackend.delete.bind(localBackend),
      put: async (input) => {
        const result = await localBackend.put(input);
        if (!connection) throw new Error('Database connection was not created');
        await connection.db
          .update(mediaCacheRuntime)
          .set({ maxBytes: 1n })
          .where(eq(mediaCacheRuntime.singletonKey, 'local'));
        await connection.db
          .update(mediaStorageBackends)
          .set({ maxBytes: 1n })
          .where(eq(mediaStorageBackends.id, 'local'));
        return result;
      },
      read: localBackend.read.bind(localBackend),
    };
    const backends = new PersistentBlobBackendRegistry([
      capacityDownshiftLocalBackend,
      memoryBackend({ content, id: 's3-default' }),
    ]);
    const unavailableService = new PostgresStorageOperationService(connection.db, backends);
    await expect(
      unavailableService.restore(restoreInput(fixture.objectIds[0] ?? '')),
    ).rejects.toThrow('Legacy local restore finalizer is unavailable');
    await expect(store.read(fixture.identity)).rejects.toThrow();

    const service = new PostgresStorageOperationService(
      connection.db,
      backends,
      new PostgresLegacyLocalRestoreFinalizer(),
    );

    await expect(service.restore(restoreInput(fixture.objectIds[0] ?? ''))).resolves.toMatchObject({
      hasMore: false,
      restoredBytes: String(content.byteLength),
      restoredObjectCount: 1,
      targetBackendId: 'local',
    });
    const restored = await store.read(fixture.identity);
    try {
      await expect(consume(restored.stream())).resolves.toEqual(content);
    } finally {
      await restored.close();
    }
    const [legacyBlob] = await connection.db
      .select({ state: mediaCacheBlobs.state })
      .from(mediaCacheBlobs)
      .where(eq(mediaCacheBlobs.sha256, fixture.identity.sha256));
    const restoredObjects = await connection.db
      .select({ state: mediaCacheObjects.state })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.blobSha256, fixture.identity.sha256));
    const [plan] = await connection.db
      .select({
        readyOriginalBytes: mediaCachePostPlans.readyOriginalBytes,
        state: mediaCachePostPlans.state,
      })
      .from(mediaCachePostPlans);
    const [runtime] = await connection.db
      .select({
        maxBytes: mediaCacheRuntime.maxBytes,
        readyBytes: mediaCacheRuntime.readyBytes,
      })
      .from(mediaCacheRuntime);
    const [localBackendLedger] = await connection.db
      .select({
        maxBytes: mediaStorageBackends.maxBytes,
        readyBytes: mediaStorageBackends.readyBytes,
      })
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 'local'));
    const [localLocation] = await connection.db
      .select({ state: mediaBlobLocations.state })
      .from(mediaBlobLocations)
      .where(eq(mediaBlobLocations.backendId, 'local'));
    expect(legacyBlob?.state).toBe('ready');
    expect(restoredObjects).toEqual([{ state: 'ready' }, { state: 'ready' }]);
    expect(plan).toEqual({
      readyOriginalBytes: BigInt(content.byteLength * 2),
      state: 'ready',
    });
    expect(runtime).toEqual({
      maxBytes: 1n,
      readyBytes: BigInt(content.byteLength),
    });
    expect(localBackendLedger).toEqual({
      maxBytes: 1n,
      readyBytes: BigInt(content.byteLength),
    });
    expect(localLocation?.state).toBe('ready');
  });

  it('rolls back legacy and additive ledgers together when local restore finalization fails', async () => {
    if (!connection) throw new Error('Database connection was not created');
    await insertBackend('local');
    await insertBackend('s3-default');
    const content = Buffer.from('restore rollback');
    const fixture = await insertBlobFixture({
      content,
      objectState: 'evicted',
      sourceBackendId: 's3-default',
    });
    await connection.db
      .update(mediaCacheObjects)
      .set({ actualBytes: null })
      .where(eq(mediaCacheObjects.id, fixture.objectIds[0] ?? ''));
    const root = await mkdtemp(join(tmpdir(), 'koharu-storage-restore-rollback-'));
    temporaryRoots.push(root);
    const store = new LocalMediaBlobStore(root);
    await store.initialize();
    const service = new PostgresStorageOperationService(
      connection.db,
      new PersistentBlobBackendRegistry([
        new LocalPersistentBlobBackend(store),
        memoryBackend({ content, id: 's3-default' }),
      ]),
      new PostgresLegacyLocalRestoreFinalizer(),
    );

    await expect(service.restore(restoreInput(fixture.objectIds[0] ?? ''))).rejects.toThrow(
      'positive byte length',
    );
    const [legacyBlob] = await connection.db
      .select({ state: mediaCacheBlobs.state })
      .from(mediaCacheBlobs);
    const [object] = await connection.db
      .select({ state: mediaCacheObjects.state })
      .from(mediaCacheObjects);
    const [runtime] = await connection.db.select().from(mediaCacheRuntime);
    const [localBackend] = await connection.db
      .select({ readyBytes: mediaStorageBackends.readyBytes })
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 'local'));
    const [localLocation] = await connection.db
      .select({ state: mediaBlobLocations.state })
      .from(mediaBlobLocations)
      .where(eq(mediaBlobLocations.backendId, 'local'));
    expect(legacyBlob?.state).toBe('evicted');
    expect(object?.state).toBe('evicted');
    expect(runtime).toBeUndefined();
    expect(localBackend?.readyBytes).toBe(0n);
    expect(localLocation?.state).toBe('missing');

    const copiedFile = await store.read(fixture.identity);
    try {
      await expect(consume(copiedFile.stream())).resolves.toEqual(content);
    } finally {
      await copiedFile.close();
    }
  });

  it('takes over an expired copying lease but leaves a fresh lease untouched', async () => {
    if (!connection) throw new Error('Database connection was not created');
    await insertBackend('local');
    await insertBackend('s3-default');
    const content = Buffer.from('lease recovery');
    const fixture = await insertBlobFixture({ content, sourceBackendId: 'local' });
    const put = vi.fn(async (input: PersistentBlobPutInput) => {
      await consume(input.source);
      return { outcome: 'created' as const };
    });
    await connection.db.insert(mediaBlobLocations).values({
      backendId: 's3-default',
      blobSha256: fixture.identity.sha256,
      mutationExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
      mutationOwner: 'crashed-worker',
      mutationToken: randomUUID(),
      state: 'copying',
      storageKey: fixture.identity.relativeKey,
    });
    const service = new PostgresStorageOperationService(
      connection.db,
      new PersistentBlobBackendRegistry([
        memoryBackend({ content, id: 'local' }),
        memoryBackend({ content, id: 's3-default', put }),
      ]),
    );

    await expect(service.migrate(migrateInput(fixture.objectIds[0] ?? ''))).resolves.toMatchObject({
      migratedBlobCount: 1,
    });
    await connection.db
      .update(mediaBlobLocations)
      .set({
        mutationExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
        mutationOwner: 'active-worker',
        mutationToken: randomUUID(),
        state: 'copying',
        verifiedAt: null,
        verifiedByteLength: null,
        verifiedSha256: null,
      })
      .where(eq(mediaBlobLocations.backendId, 's3-default'));
    await connection.db
      .update(mediaStorageBackends)
      .set({ readyBytes: 0n })
      .where(eq(mediaStorageBackends.id, 's3-default'));

    await expect(service.migrate(migrateInput(fixture.objectIds[0] ?? ''))).resolves.toMatchObject({
      alreadyApplied: false,
      hasMore: true,
      migratedBlobCount: 0,
    });
    expect(put).toHaveBeenCalledOnce();
  });

  it('does not copy beyond target capacity and preserves source accounting on failure', async () => {
    if (!connection) throw new Error('Database connection was not created');
    await insertBackend('local');
    await insertBackend('s3-default', { maxBytes: 1n });
    const content = Buffer.from('larger than target');
    const fixture = await insertBlobFixture({ content, sourceBackendId: 'local' });
    const close = vi.fn(async () => undefined);
    const put = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    let service = new PostgresStorageOperationService(
      connection.db,
      new PersistentBlobBackendRegistry([
        memoryBackend({ close, content, id: 'local' }),
        memoryBackend({ content, id: 's3-default', put }),
      ]),
    );

    await expect(service.migrate(migrateInput(fixture.objectIds[0] ?? ''))).resolves.toMatchObject({
      hasMore: true,
      migratedBlobCount: 0,
    });
    expect(put).not.toHaveBeenCalled();
    await connection.db
      .update(mediaStorageBackends)
      .set({ maxBytes: 1_024n })
      .where(eq(mediaStorageBackends.id, 's3-default'));
    service = new PostgresStorageOperationService(
      connection.db,
      new PersistentBlobBackendRegistry([
        memoryBackend({ close, content, id: 'local' }),
        memoryBackend({ content, id: 's3-default', put }),
      ]),
    );
    await expect(service.migrate(migrateInput(fixture.objectIds[0] ?? ''))).rejects.toThrow(
      'provider unavailable',
    );
    const [source] = await connection.db
      .select({ state: mediaBlobLocations.state })
      .from(mediaBlobLocations)
      .where(eq(mediaBlobLocations.backendId, 'local'));
    const [target] = await connection.db
      .select({ state: mediaBlobLocations.state })
      .from(mediaBlobLocations)
      .where(eq(mediaBlobLocations.backendId, 's3-default'));
    const [targetBackend] = await connection.db
      .select({ readyBytes: mediaStorageBackends.readyBytes })
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 's3-default'));
    expect(source?.state).toBe('ready');
    expect(target?.state).toBe('missing');
    expect(targetBackend?.readyBytes).toBe(0n);
    expect(close).toHaveBeenCalledOnce();

    await connection.db
      .update(mediaBlobLocations)
      .set({
        state: 'missing',
        verifiedAt: null,
        verifiedByteLength: null,
        verifiedSha256: null,
      })
      .where(eq(mediaBlobLocations.backendId, 'local'));
    await expect(service.migrate(migrateInput(fixture.objectIds[0] ?? ''))).rejects.toThrow(
      'source media storage location is not readable',
    );
  });

  it('revalidates an integrity failure and quarantines the corrupt source, not the target', async () => {
    if (!connection) throw new Error('Database connection was not created');
    await insertBackend('local');
    await insertBackend('s3-default');
    const expected = Buffer.from('expected source');
    const corrupt = Buffer.from('corrupt source!');
    expect(corrupt.byteLength).toBe(expected.byteLength);
    const fixture = await insertBlobFixture({ content: expected, sourceBackendId: 'local' });
    const close = vi.fn(async () => undefined);
    const put = vi.fn(async (input: PersistentBlobPutInput) => {
      const received = await consume(input.source);
      const receivedSha256 = createHash('sha256').update(received).digest('hex');
      if (receivedSha256 !== input.identity.sha256) {
        throw new MediaBlobIntegrityError('Target rejected a source identity mismatch');
      }
      return { outcome: 'created' as const };
    });
    const service = new PostgresStorageOperationService(
      connection.db,
      new PersistentBlobBackendRegistry([
        memoryBackend({ close, content: corrupt, id: 'local' }),
        memoryBackend({ content: expected, id: 's3-default', put }),
      ]),
    );

    await expect(service.migrate(migrateInput(fixture.objectIds[0] ?? ''))).rejects.toThrow(
      'source identity mismatch',
    );
    const locations = await connection.db
      .select({
        backendId: mediaBlobLocations.backendId,
        state: mediaBlobLocations.state,
      })
      .from(mediaBlobLocations);
    const backends = await connection.db
      .select({
        id: mediaStorageBackends.id,
        readyBytes: mediaStorageBackends.readyBytes,
      })
      .from(mediaStorageBackends);
    expect(locations).toEqual(
      expect.arrayContaining([
        { backendId: 'local', state: 'corrupt' },
        { backendId: 's3-default', state: 'missing' },
      ]),
    );
    expect(backends).toEqual(
      expect.arrayContaining([
        { id: 'local', readyBytes: 0n },
        { id: 's3-default', readyBytes: 0n },
      ]),
    );
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('fences finalization after another worker takes over the location token', async () => {
    if (!connection) throw new Error('Database connection was not created');
    await insertBackend('local');
    await insertBackend('s3-default');
    const content = Buffer.from('token fencing');
    const fixture = await insertBlobFixture({ content, sourceBackendId: 'local' });
    const takeoverToken = randomUUID();
    const put = vi.fn(async (input: PersistentBlobPutInput) => {
      await consume(input.source);
      if (!connection) throw new Error('Database connection was not created');
      await connection.db
        .update(mediaBlobLocations)
        .set({
          mutationExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
          mutationOwner: 'takeover-worker',
          mutationToken: takeoverToken,
        })
        .where(eq(mediaBlobLocations.backendId, 's3-default'));
      return { outcome: 'created' as const };
    });
    const service = new PostgresStorageOperationService(
      connection.db,
      new PersistentBlobBackendRegistry([
        memoryBackend({ content, id: 'local' }),
        memoryBackend({ content, id: 's3-default', put }),
      ]),
    );

    await expect(service.migrate(migrateInput(fixture.objectIds[0] ?? ''))).rejects.toThrow(
      'stale',
    );
    const [target] = await connection.db
      .select({
        mutationToken: mediaBlobLocations.mutationToken,
        state: mediaBlobLocations.state,
      })
      .from(mediaBlobLocations)
      .where(eq(mediaBlobLocations.backendId, 's3-default'));
    const [targetBackend] = await connection.db
      .select({ readyBytes: mediaStorageBackends.readyBytes })
      .from(mediaStorageBackends)
      .where(eq(mediaStorageBackends.id, 's3-default'));
    expect(target).toEqual({ mutationToken: takeoverToken, state: 'copying' });
    expect(targetBackend?.readyBytes).toBe(0n);
  });
});
