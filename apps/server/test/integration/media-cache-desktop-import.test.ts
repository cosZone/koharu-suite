import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  importRunObservations,
  importRuns,
  mediaCacheActions,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  messageMedia,
  messageRevisions,
  messageSourceMediaObservations,
  messageSourceObservations,
  messages,
  telegramChannels,
  telegramUpdates,
} from '../../src/db/schema.js';
import { LocalMediaBlobStore } from '../../src/media-cache/blob-store.js';
import { DesktopImportMediaCacheService } from '../../src/media-cache/desktop-import-service.js';
import { PostgresMediaCacheDiscoveryRepository } from '../../src/media-cache/discovery-repository.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

let container: StartedPostgreSqlContainer | undefined;
let connection: DatabaseConnection | undefined;
const temporaryDirectories: string[] = [];

async function createFixture() {
  if (!connection) throw new Error('Database connection was not created');
  const desktopRoot = await mkdtemp(join(tmpdir(), 'koharu-desktop-export-'));
  const cacheRoot = await mkdtemp(join(tmpdir(), 'koharu-desktop-cache-'));
  temporaryDirectories.push(desktopRoot, cacheRoot);
  await mkdir(join(desktopRoot, 'photos'));
  await writeFile(join(desktopRoot, 'photos', 'one.jpg'), JPEG);
  const inputPath = join(desktopRoot, 'result.json');
  const json = '{"about":"exact fixture"}';
  await writeFile(inputPath, json);
  const sourceFileSha256 = createHash('sha256').update(json).digest('hex');

  const [channel] = await connection.db
    .insert(telegramChannels)
    .values({ telegramChatId: -1_011_000_000_001n, title: 'Desktop exact import' })
    .returning({ id: telegramChannels.id });
  if (!channel) throw new Error('Channel fixture was not created');
  const [message] = await connection.db
    .insert(messages)
    .values({
      channelId: channel.id,
      currentRevisionNumber: 1,
      publishedAt: new Date('2026-07-24T09:00:00.000Z'),
      telegramMessageId: 1n,
    })
    .returning({ id: messages.id });
  if (!message) throw new Error('Message fixture was not created');
  const [revision] = await connection.db
    .insert(messageRevisions)
    .values({
      contentKind: 'none',
      entities: [],
      messageId: message.id,
      revisionNumber: 1,
    })
    .returning({ id: messageRevisions.id });
  if (!revision) throw new Error('Revision fixture was not created');
  await connection.db.insert(messageMedia).values({
    kind: 'photo',
    position: 0,
    revisionId: revision.id,
    sourceKind: 'telegram_desktop_json',
    sourcePath: 'photos/one.jpg',
  });
  const [run] = await connection.db
    .insert(importRuns)
    .values({
      completedAt: new Date('2026-07-24T09:01:00.000Z'),
      parserVersion: 1,
      selectedChannels: [channel.id],
      sourceFileSha256,
      sourceKind: 'telegram_desktop_json' as const,
      status: 'completed' as const,
    })
    .returning({ id: importRuns.id });
  if (!run) throw new Error('Import run fixture was not created');
  const [observation] = await connection.db
    .insert(messageSourceObservations)
    .values({
      channelId: channel.id,
      contentFingerprint: 'desktop-exact-fixture',
      contentFingerprintVersion: 1,
      importRunId: run.id,
      messageId: message.id,
      rawJson: {},
      resolution: 'created',
      revisionId: revision.id,
      sourceKey: 'telegram_desktop_json:exact-fixture',
      sourceKind: 'telegram_desktop_json',
      telegramMessageId: 1n,
    })
    .returning({ id: messageSourceObservations.id });
  if (!observation) throw new Error('Observation fixture was not created');
  await connection.db.insert(importRunObservations).values({
    observationId: observation.id,
    replayed: false,
    resolutionAtRun: 'created',
    runId: run.id,
  });
  await connection.db.insert(messageSourceMediaObservations).values({
    availability: 'available',
    desktopSourcePath: 'photos/one.jpg',
    mediaKind: 'photo',
    observationId: observation.id,
    position: 0,
    sourceKind: 'telegram_desktop_json',
  });
  return {
    cacheRoot,
    channelId: channel.id,
    desktopRoot,
    inputPath,
    messageId: message.id,
    observationId: observation.id,
    revisionId: revision.id,
    runId: run.id,
  };
}

describe('exact Desktop import media cache', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations(container.getConnectionUri());
    connection = createDatabaseConnection(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await container?.stop();
  }, 30_000);

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  beforeEach(async () => {
    if (!connection) throw new Error('Database connection was not created');
    await connection.db.execute(sql`
      truncate table ${mediaCacheRuntime}, ${telegramChannels} cascade
    `);
  });

  it('claims only exact-run Desktop evidence and publishes through the shared ledger', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const database = connection.db;
    const fixture = await createFixture();
    const blobs = new LocalMediaBlobStore(fixture.cacheRoot);
    await blobs.initialize();
    const result = await new DesktopImportMediaCacheService(database, blobs, () =>
      new PostgresMediaCacheDiscoveryRepository(database).discoverBatch(),
    ).run({
      desktopRoot: fixture.desktopRoot,
      importRunId: fixture.runId,
      initiatorId: 'desktop-cli:123',
      inputPath: fixture.inputPath,
      reason: 'cache this exact completed export',
    });

    expect(result).toMatchObject({
      auditedObjects: 1,
      completedPlans: 1,
      failedPlans: 0,
      hasMore: false,
      inputStable: true,
      offeredPlans: 1,
      scannedEvidence: 1,
      status: 'completed',
      unclaimedPlans: 0,
    });
    const [plan] = await connection.db.select().from(mediaCachePostPlans);
    expect(plan).toMatchObject({ state: 'ready' });
    const [object] = await connection.db.select().from(mediaCacheObjects);
    expect(object).toMatchObject({ state: 'ready' });
    expect(object?.blobSha256).toMatch(/^[0-9a-f]{64}$/u);
    const [action] = await connection.db.select().from(mediaCacheActions);
    expect(action).toMatchObject({
      actionKind: 'retry',
      initiatorId: 'desktop-cli:123',
      initiatorKind: 'local_operator',
      reason: 'cache this exact completed export',
    });
    expect(JSON.stringify(action)).not.toContain(fixture.desktopRoot);
  });

  it('atomically completes a mixed Bot/Desktop plan when the exact run covers every object', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const database = connection.db;
    const fixture = await createFixture();
    await writeFile(join(fixture.desktopRoot, 'photos', 'two.jpg'), JPEG);
    await database.insert(messageMedia).values({
      kind: 'photo',
      position: 1,
      revisionId: fixture.revisionId,
      sourceKind: 'telegram_desktop_json',
      sourcePath: 'photos/two.jpg',
    });
    await database.insert(messageSourceMediaObservations).values({
      availability: 'available',
      desktopSourcePath: 'photos/two.jpg',
      mediaKind: 'photo',
      observationId: fixture.observationId,
      position: 1,
      sourceKind: 'telegram_desktop_json',
    });
    await database.insert(telegramUpdates).values({
      channelId: fixture.channelId,
      rawJson: { update_id: 42 },
      telegramUpdateId: 42n,
      updateType: 'channel_post',
    });
    const [botObservation] = await database
      .insert(messageSourceObservations)
      .values({
        channelId: fixture.channelId,
        contentFingerprint: 'bot-mixed-fixture',
        contentFingerprintVersion: 1,
        messageId: fixture.messageId,
        rawJson: {},
        resolution: 'matched',
        revisionId: fixture.revisionId,
        sourceKey: 'telegram_bot_update:mixed-fixture',
        sourceKind: 'telegram_bot_update',
        telegramMessageId: 1n,
        telegramUpdateId: 42n,
      })
      .returning({ id: messageSourceObservations.id });
    if (!botObservation) throw new Error('Bot observation fixture was not created');
    await database.insert(messageSourceMediaObservations).values({
      availability: 'available',
      mediaKind: 'photo',
      observationId: botObservation.id,
      position: 0,
      sourceKind: 'telegram_bot_update',
      telegramFileId: 'bot-file-id',
      telegramFileUniqueId: 'bot-file-unique-id',
    });

    const discovery = new PostgresMediaCacheDiscoveryRepository(database);
    await discovery.discoverBatch();
    const [planBefore] = await database.select().from(mediaCachePostPlans);
    const objectsBefore = await database
      .select({ position: messageMedia.position, state: mediaCacheObjects.state })
      .from(mediaCacheObjects)
      .innerJoin(messageMedia, eq(messageMedia.id, mediaCacheObjects.canonicalMediaId))
      .orderBy(asc(messageMedia.position));
    expect(planBefore).toMatchObject({ state: 'awaiting_local_source' });
    expect(objectsBefore).toEqual([
      { position: 0, state: 'discovered' },
      { position: 1, state: 'awaiting_local_source' },
    ]);

    const blobs = new LocalMediaBlobStore(fixture.cacheRoot);
    await blobs.initialize();
    const result = await new DesktopImportMediaCacheService(database, blobs, () =>
      discovery.discoverBatch(),
    ).run({
      desktopRoot: fixture.desktopRoot,
      importRunId: fixture.runId,
      initiatorId: 'desktop-cli:123',
      inputPath: fixture.inputPath,
      reason: 'cache the exact mixed-source post atomically',
    });

    expect(result).toMatchObject({
      auditedObjects: 2,
      completedPlans: 1,
      failedPlans: 0,
      hasMore: false,
      offeredPlans: 1,
      status: 'completed',
      unclaimedPlans: 0,
    });
    const [planAfter] = await database.select().from(mediaCachePostPlans);
    expect(planAfter).toMatchObject({ state: 'ready' });
    const originals = await database
      .select({ state: mediaCacheObjects.state })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.variant, 'original'))
      .orderBy(asc(mediaCacheObjects.id));
    expect(originals).toEqual([{ state: 'ready' }, { state: 'ready' }]);
  });

  it('rejects a mismatched input without claiming the awaiting plan', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const database = connection.db;
    const fixture = await createFixture();
    await writeFile(fixture.inputPath, '{"about":"different fixture"}');
    const blobs = new LocalMediaBlobStore(fixture.cacheRoot);
    await blobs.initialize();
    await expect(
      new DesktopImportMediaCacheService(database, blobs, () =>
        new PostgresMediaCacheDiscoveryRepository(database).discoverBatch(),
      ).run({
        desktopRoot: fixture.desktopRoot,
        importRunId: fixture.runId,
        initiatorId: 'desktop-cli:123',
        inputPath: fixture.inputPath,
        reason: 'attempt wrong export',
      }),
    ).rejects.toThrow('provenance could not be verified');
    expect(await connection.db.select().from(mediaCachePostPlans)).toHaveLength(0);
  });

  it('reports a budget-refused exact plan as partial instead of completed or spinning', async () => {
    if (!connection) throw new Error('Database connection was not created');
    const database = connection.db;
    const fixture = await createFixture();
    await database.insert(mediaCacheRuntime).values({
      maxBytes: 1n,
      singletonKey: 'local',
    });
    const blobs = new LocalMediaBlobStore(fixture.cacheRoot);
    await blobs.initialize();
    const result = await new DesktopImportMediaCacheService(database, blobs, () =>
      new PostgresMediaCacheDiscoveryRepository(database).discoverBatch(),
    ).run({
      desktopRoot: fixture.desktopRoot,
      importRunId: fixture.runId,
      initiatorId: 'desktop-cli:123',
      inputPath: fixture.inputPath,
      reason: 'test bounded budget refusal',
    });

    expect(result).toMatchObject({
      completedPlans: 0,
      failedPlans: 0,
      hasMore: false,
      offeredPlans: 1,
      status: 'partial',
      unclaimedPlans: 1,
    });
    const [plan] = await database.select().from(mediaCachePostPlans);
    expect(plan).toMatchObject({ state: 'awaiting_local_source' });
  });
});
