import { setTimeout as delay } from 'node:timers/promises';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresArchiveExportRepository } from '../../src/archive/export-repository.js';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  archiveExportRuns,
  importRunObservations,
  importRuns,
  mediaCacheBlobs,
  mediaCacheObjects,
  mediaCachePostPlans,
  messageMedia,
  messageRevisions,
  messageSourceMediaObservations,
  messageSourceObservations,
  messages,
  telegramChannels,
  telegramUpdates,
} from '../../src/db/schema.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';

let container: StartedPostgreSqlContainer | undefined;
let connection: DatabaseConnection | undefined;
let databaseUrl: string | undefined;

interface CanonicalFixture {
  channelId: string;
  publicMessageId: string;
  publicRevisionId: string;
}

interface AdvisoryLockRow {
  [key: string]: unknown;
  pid: number;
}

async function waitForBlockedArchiveSnapshot(
  databaseConnection: DatabaseConnection,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await databaseConnection.db.execute<{ [key: string]: unknown; pid: number }>(sql`
      select pid
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and state = 'active'
        and wait_event_type = 'Lock'
        and query like '%telegram_channels%'
        and query not ilike 'lock table%'
    `);
    if (rows.length > 0) return;
    await delay(25);
  }
  throw new Error('Archive snapshot query did not reach a blocked PostgreSQL state');
}

async function waitForBlockedQuery(
  databaseConnection: DatabaseConnection,
  queryPattern: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await databaseConnection.db.execute<{ [key: string]: unknown; pid: number }>(sql`
      select pid
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and state = 'active'
        and wait_event_type = 'Lock'
        and query like ${queryPattern}
        and query not ilike 'lock table%'
    `);
    if (rows.length > 0) return;
    await delay(25);
  }
  throw new Error(`Query ${queryPattern} did not reach a blocked PostgreSQL state`);
}

async function insertCanonicalFixture(
  databaseConnection: DatabaseConnection,
): Promise<CanonicalFixture> {
  const [channel] = await databaseConnection.db
    .insert(telegramChannels)
    .values({ telegramChatId: -1_002n, title: 'Selected channel', username: 'selected' })
    .returning({ id: telegramChannels.id });
  if (!channel) throw new Error('Fixture channel was not created');
  await databaseConnection.db
    .insert(telegramChannels)
    .values({ telegramChatId: -1_001n, title: 'Other channel', username: null });

  const [publicMessage, hiddenMessage] = await databaseConnection.db
    .insert(messages)
    .values([
      {
        channelId: channel.id,
        currentRevisionNumber: 1,
        publishedAt: new Date('2026-08-03T00:00:00.000Z'),
        telegramMessageId: 10n,
      },
      {
        channelId: channel.id,
        currentRevisionNumber: 1,
        publishedAt: new Date('2026-08-03T01:00:00.000Z'),
        telegramMessageId: 11n,
        tombstonedAt: new Date('2026-08-03T02:00:00.000Z'),
      },
    ])
    .returning({ id: messages.id, telegramMessageId: messages.telegramMessageId });
  if (!publicMessage || !hiddenMessage) throw new Error('Fixture messages were not created');

  const [publicRevision] = await databaseConnection.db
    .insert(messageRevisions)
    .values([
      {
        contentKind: 'text',
        entities: [],
        messageId: publicMessage.id,
        revisionNumber: 1,
        text: 'public',
      },
      {
        contentKind: 'text',
        entities: [],
        messageId: hiddenMessage.id,
        revisionNumber: 1,
        text: 'hidden',
      },
    ])
    .returning({ id: messageRevisions.id, messageId: messageRevisions.messageId });
  if (!publicRevision) throw new Error('Fixture revisions were not created');

  const [media] = await databaseConnection.db
    .insert(messageMedia)
    .values({
      fileSize: 32n,
      kind: 'photo',
      mimeType: 'image/jpeg',
      position: 0,
      revisionId: publicRevision.id,
      sourceKind: 'telegram_desktop_json',
      sourceMediaType: 'photo',
      sourcePath: 'photos/photo.jpg',
    })
    .returning({ id: messageMedia.id });
  if (!media) throw new Error('Fixture media was not created');

  const digest = 'a'.repeat(64);
  await databaseConnection.db.insert(mediaCacheBlobs).values({
    byteLength: 32n,
    detectedMime: 'image/jpeg',
    relativeKey: `blobs/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`,
    sha256: digest,
    state: 'ready',
  });
  const [plan] = await databaseConnection.db
    .insert(mediaCachePostPlans)
    .values({
      messageId: publicMessage.id,
      readyOriginalBytes: 32n,
      revisionId: publicRevision.id,
      state: 'ready',
    })
    .returning({ id: mediaCachePostPlans.id });
  if (!plan) throw new Error('Fixture media plan was not created');
  await databaseConnection.db.insert(mediaCacheObjects).values({
    actualBytes: 32n,
    blobSha256: digest,
    canonicalMediaId: media.id,
    postPlanId: plan.id,
    recipeVersion: 1,
    revisionId: publicRevision.id,
    state: 'ready',
    variant: 'original',
  });
  return {
    channelId: channel.id,
    publicMessageId: publicMessage.id,
    publicRevisionId: publicRevision.id,
  };
}

async function insertBotProvenance(
  databaseConnection: DatabaseConnection,
  fixture: CanonicalFixture,
): Promise<void> {
  await databaseConnection.db.insert(telegramUpdates).values({
    channelId: fixture.channelId,
    rawJson: { update_id: 500 },
    telegramUpdateId: 500n,
    updateType: 'channel_post',
  });
  const [observation] = await databaseConnection.db
    .insert(messageSourceObservations)
    .values({
      channelId: fixture.channelId,
      contentFingerprint: 'bot-fingerprint',
      contentFingerprintVersion: 1,
      messageId: fixture.publicMessageId,
      observedAt: new Date('2026-08-03T00:00:01.000Z'),
      rawJson: { type: 'message' },
      resolution: 'matched',
      revisionId: fixture.publicRevisionId,
      sourceKey: 'bot:500',
      sourceKind: 'telegram_bot_update',
      telegramMessageId: 10n,
      telegramUpdateId: 500n,
    })
    .returning({ id: messageSourceObservations.id });
  if (!observation) throw new Error('Bot observation was not created');
  await databaseConnection.db.insert(messageSourceMediaObservations).values({
    availability: 'available',
    mediaKind: 'photo',
    observationId: observation.id,
    position: 0,
    sourceKind: 'telegram_bot_update',
    telegramFileId: 'private-file-id',
    telegramFileUniqueId: 'portable-unique-id',
  });
}

async function insertDesktopProvenance(
  databaseConnection: DatabaseConnection,
  fixture: CanonicalFixture,
  input: { mapping: 'conflicting' | 'missing' | 'valid' },
): Promise<{ observationId: string; runId: string }> {
  const digest = 'b'.repeat(64);
  const [run] = await databaseConnection.db
    .insert(importRuns)
    .values({
      completedAt: new Date('2026-08-03T00:02:00.000Z'),
      parserVersion: 4,
      report: {
        selectedChats:
          input.mapping === 'conflicting'
            ? [
                { canonicalChannelId: '-1002', sourceChatId: '1002' },
                { canonicalChannelId: '-1002', sourceChatId: '2002' },
              ]
            : [{ canonicalChannelId: '-1002', sourceChatId: '1002' }],
      },
      selectedChannels: ['-1002'],
      sourceFileSha256: digest,
      sourceKind: 'telegram_desktop_json',
      status: 'completed',
    })
    .returning({ id: importRuns.id });
  if (!run) throw new Error('Desktop import run was not created');
  const [observation] = await databaseConnection.db
    .insert(messageSourceObservations)
    .values({
      channelId: fixture.channelId,
      contentFingerprint: 'desktop-fingerprint',
      contentFingerprintVersion: 1,
      importRunId: run.id,
      messageId: fixture.publicMessageId,
      observedAt: new Date('2026-08-03T00:00:02.000Z'),
      rawJson: { type: 'message' },
      resolution: 'matched',
      revisionId: fixture.publicRevisionId,
      sourceKey: `desktop:${input.mapping}`,
      sourceKind: 'telegram_desktop_json',
      telegramMessageId: 10n,
    })
    .returning({ id: messageSourceObservations.id });
  if (!observation) throw new Error('Desktop observation was not created');
  if (input.mapping !== 'missing') {
    await databaseConnection.db.insert(importRunObservations).values({
      observationId: observation.id,
      replayed: true,
      resolutionAtRun: 'matched',
      runId: run.id,
    });
  }
  await databaseConnection.db.insert(messageSourceMediaObservations).values({
    availability: 'not_included',
    mediaKind: 'photo',
    observationId: observation.id,
    position: 0,
    sourceKind: 'telegram_desktop_json',
  });
  return { observationId: observation.id, runId: run.id };
}

describe('PostgreSQL archive export repository', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    databaseUrl = container.getConnectionUri();
    await runMigrations(databaseUrl);
    connection = createDatabaseConnection(databaseUrl);
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await container?.stop();
  }, 30_000);

  beforeEach(async () => {
    if (!connection) throw new Error('Database connection was not created');
    await connection.db.execute(
      sql`truncate table ${archiveExportRuns}, ${telegramChannels}, ${mediaCacheBlobs} cascade`,
    );
  });

  it('persists the acquired snapshot boundary when an export run fails', async () => {
    if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
    const repository = new PostgresArchiveExportRepository(databaseUrl);
    const snapshotAt = '2026-08-03T00:00:00.000Z';

    try {
      const runId = await repository.createRun({
        includeProvenance: false,
        selection: { mode: 'all' },
      });
      await repository.failRun(runId, {
        code: 'archive_export_failed',
        snapshotAt,
        status: 'failed',
      });

      const [run] = await connection.db
        .select({ snapshotAt: archiveExportRuns.snapshotAt, status: archiveExportRuns.status })
        .from(archiveExportRuns)
        .where(eq(archiveExportRuns.id, runId));
      expect(run).toMatchObject({ snapshotAt: new Date(snapshotAt), status: 'failed' });
    } finally {
      await repository.close();
    }
  });

  it.each(['create', 'complete', 'fail'] as const)(
    'cancels a blocked %s run lifecycle query',
    async (operation) => {
      if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
      const blocker = createDatabaseConnection(databaseUrl);
      const repository = new PostgresArchiveExportRepository(databaseUrl);
      const controller = new AbortController();
      const runId =
        operation === 'create'
          ? undefined
          : await repository.createRun({
              includeProvenance: false,
              selection: { mode: 'all' },
            });
      let releaseBlocker: (() => void) | undefined;
      let markLocked: (() => void) | undefined;
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      const blockerReleased = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      const blockingTransaction = blocker.db.transaction(async (transaction) => {
        await transaction.execute(sql`lock table ${archiveExportRuns} in access exclusive mode`);
        markLocked?.();
        await blockerReleased;
      });

      try {
        await locked;
        const writing =
          operation === 'create'
            ? repository.createRun({
                includeProvenance: false,
                selection: { mode: 'all' },
                signal: controller.signal,
              })
            : operation === 'complete'
              ? repository.completeRun(runId as string, {
                  artifactByteLength: '42',
                  artifactSha256: 'a'.repeat(64),
                  counts: {
                    blobs: 0,
                    channels: 0,
                    hiddenMessages: 0,
                    messages: 0,
                    provenanceMedia: 0,
                    provenanceObservations: 0,
                    revisionMedia: 0,
                    revisions: 0,
                    visibleMessages: 0,
                  },
                  signal: controller.signal,
                  snapshotAt: '2026-08-03T00:00:00.000Z',
                })
              : repository.failRun(runId as string, {
                  code: 'archive_export_failed',
                  signal: controller.signal,
                  status: 'failed',
                });
        await waitForBlockedQuery(blocker, '%archive_export_runs%');
        controller.abort();

        await expect(writing).rejects.toMatchObject({ code: 'archive_export_aborted' });
      } finally {
        releaseBlocker?.();
        await blockingTransaction;
        await repository.close();
        await blocker.close();
      }
    },
    30_000,
  );

  it('streams deterministic canonical records with hidden state and original media identity', async () => {
    if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
    await insertCanonicalFixture(connection);
    const repository = new PostgresArchiveExportRepository(databaseUrl);
    const visited: Array<{ family: string; record: Record<string, unknown> }> = [];

    try {
      const summary = await repository.readSnapshot(
        {
          includeProvenance: false,
          pageSize: 1,
          selection: { mode: 'channels', telegramChatIds: ['-1002'] },
        },
        (family, record) => {
          visited.push({ family, record });
        },
      );

      expect(summary.selection).toEqual({ mode: 'channels', telegramChatIds: ['-1002'] });
      expect(summary.counts).toEqual({
        blobs: 0,
        channels: 1,
        hiddenMessages: 1,
        messages: 2,
        provenanceMedia: 0,
        provenanceObservations: 0,
        revisionMedia: 1,
        revisions: 2,
        visibleMessages: 1,
      });
      expect(visited.map(({ family }) => family)).toEqual([
        'channels',
        'messages',
        'messages',
        'revisions',
        'revisions',
        'revision-media',
      ]);
      expect(visited[2]?.record).toMatchObject({
        telegramMessageId: '11',
        visibility: { changedAt: '2026-08-03T02:00:00.000Z', state: 'hidden' },
      });
      expect(visited.at(-1)?.record).toMatchObject({
        original: {
          byteLength: '32',
          detectedMimeType: 'image/jpeg',
          included: false,
          sha256: 'a'.repeat(64),
        },
        source: { metadata: {}, telegramFileId: null, telegramFileUniqueId: null },
      });
    } finally {
      await repository.close();
    }
  });

  it('rejects an unknown selected channel before visiting any records', async () => {
    if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
    await insertCanonicalFixture(connection);
    const repository = new PostgresArchiveExportRepository(databaseUrl);
    let visits = 0;

    try {
      await expect(
        repository.readSnapshot(
          {
            includeProvenance: false,
            selection: { mode: 'channels', telegramChatIds: ['-1999', '-1002'] },
          },
          () => {
            visits += 1;
          },
        ),
      ).rejects.toMatchObject({
        code: 'archive_export_unknown_channel',
        telegramChatIds: ['-1999'],
      });
      expect(visits).toBe(0);
    } finally {
      await repository.close();
    }
  });

  it('projects Bot and Desktop observations and media into typed portable provenance', async () => {
    if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
    const fixture = await insertCanonicalFixture(connection);
    await insertBotProvenance(connection, fixture);
    const desktop = await insertDesktopProvenance(connection, fixture, { mapping: 'valid' });
    const [replayRun] = await connection.db
      .insert(importRuns)
      .values({
        completedAt: new Date('2026-08-03T00:03:00.000Z'),
        parserVersion: 4,
        report: {
          selectedChats: [{ canonicalChannelId: '-1002', sourceChatId: '1002' }],
        },
        selectedChannels: ['-1002'],
        sourceFileSha256: 'c'.repeat(64),
        sourceKind: 'telegram_desktop_json',
        status: 'completed',
      })
      .returning({ id: importRuns.id });
    if (!replayRun) throw new Error('Replay import run was not created');
    await connection.db.insert(importRunObservations).values({
      observationId: desktop.observationId,
      replayed: true,
      resolutionAtRun: 'matched',
      runId: replayRun.id,
    });
    const repository = new PostgresArchiveExportRepository(databaseUrl);
    const records: Record<string, unknown>[] = [];

    try {
      const summary = await repository.readSnapshot(
        { includeProvenance: true, selection: { mode: 'channels', telegramChatIds: ['-1002'] } },
        (family, record) => {
          if (family === 'provenance-observations' || family === 'provenance-media') {
            records.push(record);
          }
        },
      );

      expect(summary.counts).toMatchObject({ provenanceMedia: 3, provenanceObservations: 3 });
      expect(
        records.filter(
          (record) =>
            record.recordType === 'provenance-observation' &&
            (record.source as { kind?: string } | undefined)?.kind === 'telegram_desktop_json',
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: expect.objectContaining({ sourceFileSha256: 'b'.repeat(64) }),
          }),
          expect.objectContaining({
            source: expect.objectContaining({ sourceFileSha256: 'c'.repeat(64) }),
          }),
        ]),
      );
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            recordType: 'provenance-observation',
            source: {
              kind: 'telegram_bot_update',
              telegramUpdateId: '500',
              updateType: 'channel_post',
            },
          }),
          expect.objectContaining({
            recordType: 'provenance-observation',
            source: {
              kind: 'telegram_desktop_json',
              sourceChatId: '1002',
              sourceFileSha256: 'b'.repeat(64),
              sourceMessageId: '10',
            },
          }),
          expect.objectContaining({
            availability: 'available',
            recordType: 'provenance-media',
            telegramFileId: 'private-file-id',
            telegramFileUniqueId: 'portable-unique-id',
          }),
          expect.objectContaining({
            availability: 'not_included',
            recordType: 'provenance-media',
            telegramFileId: null,
            telegramFileUniqueId: null,
          }),
        ]),
      );
    } finally {
      await repository.close();
    }
  });

  it.each(['missing', 'conflicting'] as const)(
    'fails closed when a Desktop observation has a %s source mapping',
    async (mapping) => {
      if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
      const fixture = await insertCanonicalFixture(connection);
      await insertDesktopProvenance(connection, fixture, { mapping });
      const repository = new PostgresArchiveExportRepository(databaseUrl);

      try {
        await expect(
          repository.readSnapshot(
            {
              includeProvenance: true,
              selection: { mode: 'channels', telegramChatIds: ['-1002'] },
            },
            () => undefined,
          ),
        ).rejects.toMatchObject({ code: 'archive_export_invalid_database_state' });
      } finally {
        await repository.close();
      }
    },
  );

  it('excludes writes committed after the repeatable-read snapshot begins', async () => {
    if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
    const fixture = await insertCanonicalFixture(connection);
    const writer = createDatabaseConnection(databaseUrl);
    const repository = new PostgresArchiveExportRepository(databaseUrl);
    let resumeVisitor: (() => void) | undefined;
    let markVisitorReached: (() => void) | undefined;
    const visitorReached = new Promise<void>((resolve) => {
      markVisitorReached = resolve;
    });
    const visitorResume = new Promise<void>((resolve) => {
      resumeVisitor = resolve;
    });
    let paused = false;

    try {
      const reading = repository.readSnapshot(
        { includeProvenance: false, selection: { mode: 'channels', telegramChatIds: ['-1002'] } },
        async () => {
          if (paused) return;
          paused = true;
          markVisitorReached?.();
          await visitorResume;
        },
      );
      await visitorReached;
      const [lateMessage] = await writer.db
        .insert(messages)
        .values({
          channelId: fixture.channelId,
          publishedAt: new Date('2026-08-03T03:00:00.000Z'),
          telegramMessageId: 12n,
        })
        .returning({ id: messages.id });
      if (!lateMessage) throw new Error('Concurrent fixture message was not created');
      await writer.db.insert(messageRevisions).values({
        contentKind: 'text',
        entities: [],
        messageId: lateMessage.id,
        revisionNumber: 1,
        text: 'late',
      });
      resumeVisitor?.();

      await expect(reading).resolves.toMatchObject({
        counts: { messages: 2, revisions: 2 },
      });
    } finally {
      resumeVisitor?.();
      await repository.close();
      await writer.close();
    }
  });

  it('cancels the active PostgreSQL snapshot query when the export is aborted', async () => {
    if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
    await insertCanonicalFixture(connection);
    const blocker = createDatabaseConnection(databaseUrl);
    const repository = new PostgresArchiveExportRepository(databaseUrl);
    const controller = new AbortController();
    let releaseBlocker: (() => void) | undefined;
    let markLocked: (() => void) | undefined;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockingTransaction = blocker.db.transaction(async (transaction) => {
      await transaction.execute(sql`lock table ${telegramChannels} in access exclusive mode`);
      markLocked?.();
      await blockerReleased;
    });

    try {
      await locked;
      const reading = repository.readSnapshot(
        {
          includeProvenance: false,
          selection: { mode: 'all' },
          signal: controller.signal,
        },
        () => undefined,
      );
      await waitForBlockedArchiveSnapshot(blocker);
      controller.abort();

      await expect(reading).rejects.toMatchObject({ code: 'archive_export_aborted' });
    } finally {
      releaseBlocker?.();
      await blockingTransaction;
      await repository.close();
      await blocker.close();
    }
  }, 30_000);

  it('bounds PostgreSQL lock waits after acquiring the snapshot boundary', async () => {
    if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
    await insertCanonicalFixture(connection);
    const blocker = createDatabaseConnection(databaseUrl);
    const repository = new PostgresArchiveExportRepository(databaseUrl, {
      databaseWaitTimeoutMs: 2_000,
    });
    let releaseBlocker: (() => void) | undefined;
    let markLocked: (() => void) | undefined;
    let snapshotAt: string | undefined;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockingTransaction = blocker.db.transaction(async (transaction) => {
      await transaction.execute(sql`lock table ${telegramChannels} in access exclusive mode`);
      markLocked?.();
      await blockerReleased;
    });

    try {
      await locked;
      await expect(
        repository.readSnapshot(
          {
            includeProvenance: false,
            onSnapshotAt: (value) => {
              snapshotAt = value;
            },
            selection: { mode: 'all' },
          },
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'archive_export_timed_out' });
      expect(snapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    } finally {
      releaseBlocker?.();
      await blockingTransaction;
      await repository.close();
      await blocker.close();
    }
  }, 30_000);

  it('cancels before the initial snapshot boundary is acquired', async () => {
    if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
    const repository = new PostgresArchiveExportRepository(databaseUrl);
    const controller = new AbortController();

    try {
      const reading = repository.readSnapshot(
        {
          includeProvenance: false,
          selection: { mode: 'all' },
          signal: controller.signal,
        },
        () => undefined,
      );
      controller.abort();

      await expect(reading).rejects.toMatchObject({ code: 'archive_export_aborted' });
    } finally {
      await repository.close();
    }
  });

  it('holds one session lease until release and permits the next exporter afterwards', async () => {
    if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
    const first = new PostgresArchiveExportRepository(databaseUrl);
    const second = new PostgresArchiveExportRepository(databaseUrl);

    try {
      const firstLease = await first.acquireExportLease();
      await expect(second.acquireExportLease()).rejects.toMatchObject({
        code: 'archive_export_busy',
      });
      await firstLease.release();
      const secondLease = await second.acquireExportLease();
      await secondLease.release();
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('bounds concurrent lease session reservation', async () => {
    if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
    const repository = new PostgresArchiveExportRepository(databaseUrl, {
      databaseWaitTimeoutMs: 1_000,
    });

    try {
      const attempts = await Promise.allSettled([
        repository.acquireExportLease(),
        repository.acquireExportLease(),
      ]);
      const acquired = attempts.filter(
        (
          attempt,
        ): attempt is PromiseFulfilledResult<
          Awaited<ReturnType<typeof repository.acquireExportLease>>
        > => attempt.status === 'fulfilled',
      );
      const rejected = attempts.filter(
        (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
      );

      expect(acquired).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ code: 'archive_export_timed_out' });
      await acquired[0]?.value.release();
    } finally {
      await repository.close();
    }
  });

  it('fails the first exporter closed after its lock session dies while a second takes the lease', async () => {
    if (!connection || !databaseUrl) throw new Error('Database fixture was not created');
    const first = new PostgresArchiveExportRepository(databaseUrl);
    const second = new PostgresArchiveExportRepository(databaseUrl);
    const firstLease = await first.acquireExportLease();

    try {
      const lockRows = await connection.db.execute<AdvisoryLockRow>(sql`
        select pid
        from pg_locks
        where locktype = 'advisory' and granted
        order by pid
      `);
      expect(lockRows).toHaveLength(1);
      const lockPid = lockRows[0]?.pid;
      if (lockPid === undefined) throw new Error('Archive advisory lock backend was not found');
      const [terminated] = await connection.db.execute<{
        [key: string]: unknown;
        terminated: boolean;
      }>(sql`select pg_terminate_backend(${lockPid}) as terminated`);
      expect(terminated?.terminated).toBe(true);

      const secondLease = await second.acquireExportLease();
      await expect(firstLease.assertActive()).rejects.toMatchObject({
        code: 'archive_export_lock_lost',
      });
      await secondLease.release();
      await expect(firstLease.release()).rejects.toMatchObject({
        code: 'archive_export_lock_lost',
      });
    } finally {
      await first.close();
      await second.close();
    }
  });
});
