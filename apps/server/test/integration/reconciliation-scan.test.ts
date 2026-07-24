import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { count } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  messageMedia,
  messageRevisions,
  messageSourceMediaObservations,
  messageSourceObservations,
  messages,
  reconciliationActions,
  reconciliationFindings,
  reconciliationRuns,
  telegramChannelAllowlist,
  telegramChannels,
  telegramIngestTasks,
  telegramPollingState,
  telegramPollReceipts,
  telegramUpdates,
} from '../../src/db/schema.js';
import { CURRENT_RENDERER_VERSION, renderTelegramMessage } from '../../src/messages/renderer.js';
import { PostgresReconciliationRepository } from '../../src/reconciliation/repository.js';
import { ReconciliationService } from '../../src/reconciliation/service.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const CHANNEL_ID = -1_002_234_260_754n;

describe('reconciliation read-only scan', () => {
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
    if (!connection) {
      return;
    }
    await connection.db.delete(reconciliationActions);
    await connection.db.delete(reconciliationFindings);
    await connection.db.delete(reconciliationRuns);
    await connection.db.delete(messageSourceMediaObservations);
    await connection.db.delete(messageSourceObservations);
    await connection.db.delete(messageMedia);
    await connection.db.delete(messageRevisions);
    await connection.db.delete(messages);
    await connection.db.delete(telegramUpdates);
    await connection.db.delete(telegramIngestTasks);
    await connection.db.delete(telegramPollReceipts);
    await connection.db.delete(telegramPollingState);
    await connection.db.delete(telegramChannels);
    await connection.db.delete(telegramChannelAllowlist);
  });

  it('reports global and channel numeric gaps without mutating business or reconciliation rows', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const database = connection.db;
    const now = new Date('2026-07-24T10:00:00.000Z');
    await database.insert(telegramChannelAllowlist).values({
      telegramChatId: CHANNEL_ID,
      title: 'Test channel',
      username: 'test_channel',
    });
    const [channel] = await database
      .insert(telegramChannels)
      .values({
        telegramChatId: CHANNEL_ID,
        title: 'Test channel',
        username: 'test_channel',
      })
      .returning({ id: telegramChannels.id });
    if (!channel) {
      throw new Error('Channel was not created');
    }

    const insertedMessages = await database
      .insert(messages)
      .values(
        [20n, 23n].map((telegramMessageId) => ({
          channelId: channel.id,
          currentRevisionNumber: 1,
          publishedAt: now,
          telegramMessageId,
        })),
      )
      .returning({ id: messages.id });
    const text = 'stable';
    await database.insert(messageRevisions).values(
      insertedMessages.map((message) => ({
        contentKind: 'text' as const,
        entities: [],
        html: renderTelegramMessage(text, []),
        messageId: message.id,
        rendererVersion: CURRENT_RENDERER_VERSION,
        revisionNumber: 1,
        text,
      })),
    );
    await database.insert(telegramPollingState).values({
      botId: 123n,
      nextUpdateId: 106n,
      updatedAt: now,
    });
    await database.insert(telegramPollReceipts).values({
      acceptedCount: 0,
      botId: 123n,
      checkpointOffset: 106n,
      completedAt: now,
      ignoredCount: 1,
      requestedOffset: 101n,
      returnedCount: 1,
      returnedFirstUpdateId: 105n,
      returnedLastUpdateId: 105n,
    });

    const before = await rowCounts(connection);
    const report = await new ReconciliationService(
      new PostgresReconciliationRepository(database),
    ).scan({
      now,
      telegramChannelIds: [CHANNEL_ID],
    });
    const after = await rowCounts(connection);

    expect(report.status).toBe('partial');
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: null,
          kind: 'transport_id_discontinuity',
        }),
        expect.objectContaining({
          channelId: CHANNEL_ID.toString(),
          kind: 'message_id_candidate',
        }),
      ]),
    );
    expect(report.findings.every((finding) => finding.state === 'open')).toBe(true);
    expect(report.findings.some((finding) => finding.kind === 'desktop_absence_candidate')).toBe(
      false,
    );
    expect(after).toEqual(before);
  });

  it('does not report clean when configured channels have no durable polling state', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const database = connection.db;
    await database.insert(telegramChannelAllowlist).values({
      telegramChatId: CHANNEL_ID,
      title: 'Configured without collector state',
      username: 'missing_state',
    });

    const report = await new ReconciliationService(
      new PostgresReconciliationRepository(database),
    ).scan({
      now: new Date('2026-07-24T10:30:00.000Z'),
      telegramChannelIds: [CHANNEL_ID],
    });

    expect(report.status).toBe('partial');
    expect(report.findings).toEqual([
      expect.objectContaining({
        channelId: null,
        kind: 'retention_risk',
        sanitizedReason: 'No durable Telegram polling state exists for the configured channels',
      }),
    ]);
  });

  it('keyset-scans beyond 1000 rows and preserves a gap at the end of the second channel', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const database = connection.db;
    const now = new Date('2026-07-24T11:00:00.000Z');
    const secondChannelId = CHANNEL_ID + 1n;
    await database.insert(telegramChannelAllowlist).values([
      { telegramChatId: CHANNEL_ID, title: 'First', username: 'first' },
      { telegramChatId: secondChannelId, title: 'Second', username: 'second' },
    ]);
    await database.insert(telegramPollingState).values({
      botId: 124n,
      updatedAt: now,
    });
    const channelRows = await database
      .insert(telegramChannels)
      .values([
        { telegramChatId: CHANNEL_ID, title: 'First', username: 'first' },
        { telegramChatId: secondChannelId, title: 'Second', username: 'second' },
      ])
      .returning({
        id: telegramChannels.id,
        telegramChatId: telegramChannels.telegramChatId,
      });
    const channelByTelegramId = new Map(
      channelRows.map((channel) => [channel.telegramChatId, channel.id]),
    );
    const firstChannel = channelByTelegramId.get(CHANNEL_ID);
    const secondChannel = channelByTelegramId.get(secondChannelId);
    if (!firstChannel || !secondChannel) {
      throw new Error('Test channels were not created');
    }

    const insertedMessages = await database
      .insert(messages)
      .values([
        ...Array.from({ length: 1_001 }, (_, index) => ({
          channelId: firstChannel,
          currentRevisionNumber: 1,
          publishedAt: now,
          telegramMessageId: BigInt(index + 1),
        })),
        ...[1n, 3n].map((telegramMessageId) => ({
          channelId: secondChannel,
          currentRevisionNumber: 1,
          publishedAt: now,
          telegramMessageId,
        })),
      ])
      .returning({ id: messages.id });
    await database.insert(messageRevisions).values(
      insertedMessages.map((message) => ({
        contentKind: 'none' as const,
        entities: [],
        html: null,
        messageId: message.id,
        rendererVersion: CURRENT_RENDERER_VERSION,
        revisionNumber: 1,
        text: null,
      })),
    );

    const report = await new ReconciliationService(
      new PostgresReconciliationRepository(database),
    ).scan({
      now,
      telegramChannelIds: [CHANNEL_ID, secondChannelId],
    });

    expect(report.counts.findings).toBe(1);
    expect(report.findings).toEqual([
      expect.objectContaining({
        channelId: secondChannelId.toString(),
        kind: 'message_id_candidate',
      }),
    ]);
    expect(report.counts.scanned).toBeGreaterThan(2_000);
  });

  it('uses one repeatable-read snapshot while live writes continue', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const database = connection.db;
    const now = new Date('2026-07-24T12:00:00.000Z');
    await database.insert(telegramChannelAllowlist).values({
      disabledAt: now,
      enabled: false,
      telegramChatId: CHANNEL_ID,
      title: 'Snapshot',
      username: 'snapshot',
    });
    await database.insert(telegramPollingState).values({
      botId: 125n,
      updatedAt: now,
    });
    const [channel] = await database
      .insert(telegramChannels)
      .values({
        telegramChatId: CHANNEL_ID,
        title: 'Snapshot',
        username: 'snapshot',
      })
      .returning({ id: telegramChannels.id });
    if (!channel) {
      throw new Error('Snapshot channel was not created');
    }

    let continueScan: (() => void) | undefined;
    let snapshotEstablished: (() => void) | undefined;
    const pause = new Promise<void>((resolve) => {
      continueScan = resolve;
    });
    const established = new Promise<void>((resolve) => {
      snapshotEstablished = resolve;
    });
    const firstCandidates: string[] = [];
    const repository = new PostgresReconciliationRepository(database);
    const firstScan = repository.scanDryRun([CHANNEL_ID], now, async (candidate) => {
      firstCandidates.push(candidate.kind);
      if (candidate.kind === 'disabled_window') {
        snapshotEstablished?.();
        await pause;
      }
    });
    await established;

    await database.insert(messages).values(
      [1n, 3n].map((telegramMessageId) => ({
        channelId: channel.id,
        currentRevisionNumber: 1,
        publishedAt: now,
        telegramMessageId,
      })),
    );
    continueScan?.();
    await firstScan;

    expect(firstCandidates).toEqual(['disabled_window']);

    const secondCandidates: string[] = [];
    await repository.scanDryRun([CHANNEL_ID], now, (candidate) => {
      secondCandidates.push(candidate.kind);
    });
    expect(secondCandidates).toContain('message_id_candidate');
  });

  it('serializes overlapping scans with the shared transaction advisory lock', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const database = connection.db;
    const now = new Date('2026-07-24T13:00:00.000Z');
    await database.insert(telegramChannelAllowlist).values({
      disabledAt: now,
      enabled: false,
      telegramChatId: CHANNEL_ID,
      title: 'Serialized',
      username: 'serialized',
    });

    let releaseFirst: (() => void) | undefined;
    let firstEntered: (() => void) | undefined;
    let secondEntered: (() => void) | undefined;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    const repository = new PostgresReconciliationRepository(database);
    const firstScan = repository.scanDryRun([CHANNEL_ID], now, async (candidate) => {
      if (candidate.kind === 'disabled_window') {
        firstEntered?.();
        await holdFirst;
      }
    });
    await firstStarted;

    const secondScan = repository.scanDryRun([CHANNEL_ID], now, (candidate) => {
      if (candidate.kind === 'disabled_window') {
        secondEntered?.();
      }
    });
    const stateBeforeRelease = await Promise.race([
      secondStarted.then(() => 'entered' as const),
      new Promise<'waiting'>((resolve) => {
        setTimeout(() => resolve('waiting'), 100);
      }),
    ]);
    expect(stateBeforeRelease).toBe('waiting');

    releaseFirst?.();
    await Promise.all([firstScan, secondScan]);
    await expect(secondStarted).resolves.toBeUndefined();
  });
});

async function rowCounts(connection: DatabaseConnection): Promise<number[]> {
  return Promise.all(
    [
      telegramChannelAllowlist,
      telegramChannels,
      telegramPollingState,
      telegramPollReceipts,
      telegramIngestTasks,
      telegramUpdates,
      messages,
      messageRevisions,
      messageMedia,
      messageSourceObservations,
      messageSourceMediaObservations,
      reconciliationRuns,
      reconciliationFindings,
      reconciliationActions,
    ].map(async (table) => {
      const [result] = await connection.db.select({ value: count() }).from(table);
      return result?.value ?? 0;
    }),
  );
}
