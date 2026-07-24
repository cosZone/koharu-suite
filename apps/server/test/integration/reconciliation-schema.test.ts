import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  importRuns,
  messageMedia,
  messageRevisions,
  messageSourceMediaObservations,
  messageSourceObservations,
  messages,
  reconciliationActions,
  reconciliationFindings,
  reconciliationRuns,
  reconciliationSchedule,
  telegramChannelAllowlist,
  telegramChannels,
  telegramPollingState,
  telegramPollReceipts,
  telegramUpdates,
} from '../../src/db/schema.js';
import { channelPostFixture } from '../fixtures/telegram.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const TELEGRAM_CHANNEL_ID = -1_001_234_567_890n;

describe('G2.2 reconciliation schema', () => {
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
    await connection?.db.execute(sql`
      truncate table
        ${reconciliationActions},
        ${reconciliationFindings},
        ${reconciliationSchedule},
        ${reconciliationRuns},
        ${messageSourceMediaObservations},
        ${telegramPollReceipts},
        ${telegramPollingState},
        ${telegramChannelAllowlist},
        ${telegramChannels}
      cascade
    `);
  }, 30_000);

  it('enforces typed media locators and observation source integrity', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const database = connection.db;
    const [channel] = await database
      .insert(telegramChannels)
      .values({
        telegramChatId: TELEGRAM_CHANNEL_ID,
        title: 'Koharu Test Channel',
        username: 'koharu_test',
      })
      .returning({ id: telegramChannels.id });
    if (!channel) {
      throw new Error('Fixture channel was not created');
    }
    const [message] = await database
      .insert(messages)
      .values({
        channelId: channel.id,
        publishedAt: new Date('2026-07-24T00:00:00.000Z'),
        telegramMessageId: 42n,
      })
      .returning({ id: messages.id });
    if (!message) {
      throw new Error('Fixture message was not created');
    }
    const [desktopObservation] = await database
      .insert(messageSourceObservations)
      .values({
        channelId: channel.id,
        contentFingerprint: 'desktop-fingerprint',
        contentFingerprintVersion: 1,
        messageId: message.id,
        observedAt: new Date('2026-07-24T00:00:00.000Z'),
        rawJson: {},
        resolution: 'matched',
        sourceKey: 'desktop:fixture:42',
        sourceKind: 'telegram_desktop_json',
        telegramMessageId: 42n,
      })
      .returning({ id: messageSourceObservations.id });
    if (!desktopObservation) {
      throw new Error('Desktop observation was not created');
    }

    await expect(
      database.insert(messageSourceMediaObservations).values({
        availability: 'available',
        desktopSourcePath: 'photos/photo_1.jpg',
        mediaKind: 'photo',
        observationId: desktopObservation.id,
        position: 0,
        sourceKind: 'telegram_desktop_json',
      }),
    ).resolves.toBeDefined();
    await expect(
      database.insert(messageSourceMediaObservations).values({
        availability: 'not_included',
        mediaKind: 'video',
        observationId: desktopObservation.id,
        position: 1,
        sourceKind: 'telegram_desktop_json',
      }),
    ).resolves.toBeDefined();

    await expect(
      database.insert(messageSourceMediaObservations).values({
        availability: 'available',
        desktopSourcePath: '/Users/operator/private/photo.jpg',
        mediaKind: 'photo',
        observationId: desktopObservation.id,
        position: 2,
        sourceKind: 'telegram_desktop_json',
      }),
    ).rejects.toThrow();
    for (const desktopSourcePath of [
      'https://example.invalid/private/photo.jpg',
      'file:photos/private/photo.jpg',
      'photos/private\u0000photo.jpg',
    ]) {
      await expect(
        database.insert(messageSourceMediaObservations).values({
          availability: 'available',
          desktopSourcePath,
          mediaKind: 'photo',
          observationId: desktopObservation.id,
          position: 2,
          sourceKind: 'telegram_desktop_json',
        }),
      ).rejects.toThrow();
    }
    await expect(
      database.insert(messageSourceMediaObservations).values({
        availability: 'unavailable',
        desktopSourcePath: 'photos/placeholder.jpg',
        mediaKind: 'photo',
        observationId: desktopObservation.id,
        position: 2,
        sourceKind: 'telegram_desktop_json',
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(messageSourceMediaObservations).values({
        availability: 'available',
        mediaKind: 'photo',
        observationId: desktopObservation.id,
        position: 2,
        sourceKind: 'telegram_bot_update',
        telegramFileId: 'bot-file-id',
        telegramFileUniqueId: 'bot-file-unique-id',
      }),
    ).rejects.toThrow();

    const telegramUpdateId = 9_001n;
    await database.insert(telegramUpdates).values({
      channelId: channel.id,
      rawJson: channelPostFixture({ updateId: Number(telegramUpdateId) }),
      telegramUpdateId,
      updateType: 'channel_post',
    });
    const [botObservation] = await database
      .insert(messageSourceObservations)
      .values({
        channelId: channel.id,
        contentFingerprint: 'bot-fingerprint',
        contentFingerprintVersion: 1,
        messageId: message.id,
        rawJson: channelPostFixture({ updateId: Number(telegramUpdateId) }),
        resolution: 'matched',
        sourceKey: telegramUpdateId.toString(),
        sourceKind: 'telegram_bot_update',
        telegramMessageId: 42n,
        telegramUpdateId,
      })
      .returning({ id: messageSourceObservations.id });
    if (!botObservation) {
      throw new Error('Bot observation was not created');
    }
    await expect(
      database.insert(messageSourceMediaObservations).values({
        availability: 'available',
        mediaKind: 'photo',
        observationId: botObservation.id,
        position: 0,
        sourceKind: 'telegram_bot_update',
        telegramFileId: 'bot-file-id',
        telegramFileUniqueId: 'bot-file-unique-id',
      }),
    ).resolves.toBeDefined();
  }, 30_000);

  it('requires poll receipt checkpoints to equal the returned range end plus one', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const database = connection.db;
    await database.insert(telegramPollingState).values({
      botId: 123_456n,
      nextUpdateId: 2_004n,
    });

    await expect(
      database.insert(telegramPollReceipts).values({
        acceptedCount: 1,
        botId: 123_456n,
        checkpointOffset: 2_004n,
        ignoredCount: 0,
        requestedOffset: 2_003n,
        returnedCount: 1,
        returnedFirstUpdateId: 2_003n,
        returnedLastUpdateId: 2_003n,
      }),
    ).resolves.toBeDefined();

    await expect(
      database.insert(telegramPollReceipts).values({
        acceptedCount: 1,
        botId: 123_456n,
        checkpointOffset: 2_006n,
        ignoredCount: 0,
        requestedOffset: 2_004n,
        returnedCount: 1,
        returnedFirstUpdateId: 2_004n,
        returnedLastUpdateId: 2_004n,
      }),
    ).rejects.toThrow();
  }, 30_000);

  it('backfills only source-matched media evidence and stays idempotent', async () => {
    if (!container) {
      throw new Error('PostgreSQL test container did not start');
    }

    const databaseName = 'koharu_g22_legacy';
    const adminClient = postgres(container.getConnectionUri(), { max: 1 });
    const legacyUrl = new URL(container.getConnectionUri());
    legacyUrl.pathname = `/${databaseName}`;
    const migrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
    const legacyMigrations = await mkdtemp(join(tmpdir(), 'koharu-g22-migrations-'));

    try {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.unsafe(`create database "${databaseName}"`);
      await mkdir(join(legacyMigrations, 'meta'));
      for (const file of [
        '0000_green_sleepwalker.sql',
        '0001_fancy_carmella_unuscione.sql',
        '0002_majestic_tinkerer.sql',
        '0003_public_slipstream.sql',
        '0004_sleepy_carlie_cooper.sql',
        '0005_silent_pixie.sql',
        '0006_unusual_wolfsbane.sql',
      ]) {
        await cp(join(migrationRoot, file), join(legacyMigrations, file));
      }
      const journal = JSON.parse(
        await readFile(join(migrationRoot, 'meta/_journal.json'), 'utf8'),
      ) as { entries: Array<{ idx: number }>; version: string; dialect: string };
      await writeFile(
        join(legacyMigrations, 'meta/_journal.json'),
        JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 6) }),
      );

      await runMigrations(legacyUrl.toString(), { migrationsFolder: legacyMigrations });
      const legacyConnection = createDatabaseConnection(legacyUrl.toString());
      let crossSourceObservationId: string;
      let matchedBotObservationId: string;
      let ambiguousDesktopObservationIds: string[];
      try {
        const [channel] = await legacyConnection.db
          .insert(telegramChannels)
          .values({
            telegramChatId: TELEGRAM_CHANNEL_ID,
            title: 'Legacy G2.1 Channel',
            username: 'legacy_g21',
          })
          .returning({ id: telegramChannels.id });
        if (!channel) {
          throw new Error('Legacy channel was not created');
        }

        const telegramUpdateId = 8_001n;
        const update = channelPostFixture({ updateId: Number(telegramUpdateId) });
        await legacyConnection.db.insert(telegramUpdates).values({
          channelId: channel.id,
          rawJson: update,
          telegramUpdateId,
          updateType: 'channel_post',
        });
        const [botMessage] = await legacyConnection.db
          .insert(messages)
          .values({
            channelId: channel.id,
            publishedAt: new Date('2026-07-24T00:00:00.000Z'),
            telegramMessageId: 42n,
          })
          .returning({ id: messages.id });
        if (!botMessage) {
          throw new Error('Legacy Bot message was not created');
        }
        const [botRevision] = await legacyConnection.db
          .insert(messageRevisions)
          .values({
            contentKind: 'text',
            entities: [],
            messageId: botMessage.id,
            revisionNumber: 1,
            telegramUpdateId,
            text: 'Bot-created message',
          })
          .returning({ id: messageRevisions.id });
        if (!botRevision) {
          throw new Error('Legacy Bot revision was not created');
        }
        await legacyConnection.db.insert(messageMedia).values({
          kind: 'photo',
          position: 0,
          revisionId: botRevision.id,
          sourceKind: 'telegram_bot_update',
          telegramFileId: 'bot-file-id',
          telegramFileUniqueId: 'bot-file-unique-id',
        });
        await legacyConnection.db.insert(messageSourceObservations).values({
          channelId: channel.id,
          contentFingerprint: 'bot-fingerprint',
          contentFingerprintVersion: 1,
          messageId: botMessage.id,
          rawJson: update,
          resolution: 'created',
          revisionId: botRevision.id,
          sourceKey: telegramUpdateId.toString(),
          sourceKind: 'telegram_bot_update',
          telegramMessageId: 42n,
          telegramUpdateId,
        });
        const matchedTelegramUpdateId = 8_002n;
        await legacyConnection.db.insert(telegramUpdates).values({
          channelId: channel.id,
          rawJson: channelPostFixture({ updateId: Number(matchedTelegramUpdateId) }),
          telegramUpdateId: matchedTelegramUpdateId,
          updateType: 'channel_post',
        });
        const [matchedBotObservation] = await legacyConnection.db
          .insert(messageSourceObservations)
          .values({
            channelId: channel.id,
            contentFingerprint: 'bot-fingerprint',
            contentFingerprintVersion: 1,
            messageId: botMessage.id,
            rawJson: channelPostFixture({ updateId: Number(matchedTelegramUpdateId) }),
            resolution: 'matched',
            revisionId: botRevision.id,
            sourceKey: matchedTelegramUpdateId.toString(),
            sourceKind: 'telegram_bot_update',
            telegramMessageId: 42n,
            telegramUpdateId: matchedTelegramUpdateId,
          })
          .returning({ id: messageSourceObservations.id });
        if (!matchedBotObservation) {
          throw new Error('Legacy matched Bot observation was not created');
        }
        matchedBotObservationId = matchedBotObservation.id;

        const [importRun] = await legacyConnection.db
          .insert(importRuns)
          .values({
            completedAt: new Date('2026-07-24T00:02:00.000Z'),
            parserVersion: 1,
            selectedChannels: [TELEGRAM_CHANNEL_ID.toString()],
            sourceFileSha256: 'legacy-desktop-export',
            sourceKind: 'telegram_desktop_json',
            status: 'completed',
          })
          .returning({ id: importRuns.id });
        if (!importRun) {
          throw new Error('Legacy import run was not created');
        }
        const [desktopMessage] = await legacyConnection.db
          .insert(messages)
          .values({
            channelId: channel.id,
            publishedAt: new Date('2026-07-24T00:01:00.000Z'),
            telegramMessageId: 43n,
          })
          .returning({ id: messages.id });
        if (!desktopMessage) {
          throw new Error('Legacy Desktop message was not created');
        }
        const [desktopRevision] = await legacyConnection.db
          .insert(messageRevisions)
          .values({
            contentKind: 'text',
            entities: [],
            messageId: desktopMessage.id,
            revisionNumber: 1,
            text: 'Desktop-created message',
          })
          .returning({ id: messageRevisions.id });
        if (!desktopRevision) {
          throw new Error('Legacy Desktop revision was not created');
        }
        await legacyConnection.db.insert(messageMedia).values([
          {
            kind: 'photo',
            position: 0,
            revisionId: desktopRevision.id,
            sourceKind: 'telegram_desktop_json',
            sourcePath: 'photos/photo_1.jpg',
          },
          {
            availabilityReason: 'not_included',
            kind: 'video',
            position: 1,
            revisionId: desktopRevision.id,
            sourceKind: 'telegram_desktop_json',
          },
        ]);
        await legacyConnection.db.insert(messageSourceObservations).values({
          channelId: channel.id,
          contentFingerprint: 'desktop-fingerprint',
          contentFingerprintVersion: 1,
          importRunId: importRun.id,
          messageId: desktopMessage.id,
          rawJson: {},
          resolution: 'created',
          revisionId: desktopRevision.id,
          sourceKey: 'desktop:fixture:43',
          sourceKind: 'telegram_desktop_json',
          telegramMessageId: 43n,
        });
        const [crossSourceObservation] = await legacyConnection.db
          .insert(messageSourceObservations)
          .values({
            channelId: channel.id,
            contentFingerprint: 'bot-fingerprint',
            contentFingerprintVersion: 1,
            importRunId: importRun.id,
            messageId: botMessage.id,
            rawJson: {},
            resolution: 'matched',
            revisionId: botRevision.id,
            sourceKey: 'desktop:fixture:42',
            sourceKind: 'telegram_desktop_json',
            telegramMessageId: 42n,
          })
          .returning({ id: messageSourceObservations.id });
        if (!crossSourceObservation) {
          throw new Error('Legacy cross-source observation was not created');
        }
        crossSourceObservationId = crossSourceObservation.id;

        const [ambiguousDesktopMessage] = await legacyConnection.db
          .insert(messages)
          .values({
            channelId: channel.id,
            publishedAt: new Date('2026-07-24T00:03:00.000Z'),
            telegramMessageId: 44n,
          })
          .returning({ id: messages.id });
        if (!ambiguousDesktopMessage) {
          throw new Error('Legacy ambiguous Desktop message was not created');
        }
        const [ambiguousDesktopRevision] = await legacyConnection.db
          .insert(messageRevisions)
          .values({
            contentKind: 'text',
            entities: [],
            messageId: ambiguousDesktopMessage.id,
            revisionNumber: 1,
            text: 'Ambiguous Desktop media provenance',
          })
          .returning({ id: messageRevisions.id });
        if (!ambiguousDesktopRevision) {
          throw new Error('Legacy ambiguous Desktop revision was not created');
        }
        await legacyConnection.db.insert(messageMedia).values({
          kind: 'photo',
          position: 0,
          revisionId: ambiguousDesktopRevision.id,
          sourceKind: 'telegram_desktop_json',
          sourcePath: 'photos/ambiguous.jpg',
        });
        const ambiguousDesktopObservations = await legacyConnection.db
          .insert(messageSourceObservations)
          .values([
            {
              channelId: channel.id,
              contentFingerprint: 'ambiguous-desktop-fingerprint',
              contentFingerprintVersion: 1,
              importRunId: importRun.id,
              messageId: ambiguousDesktopMessage.id,
              rawJson: {},
              resolution: 'created' as const,
              revisionId: ambiguousDesktopRevision.id,
              sourceKey: 'desktop:ambiguous:creator',
              sourceKind: 'telegram_desktop_json' as const,
              telegramMessageId: 44n,
            },
            {
              channelId: channel.id,
              contentFingerprint: 'ambiguous-desktop-fingerprint',
              contentFingerprintVersion: 1,
              importRunId: importRun.id,
              messageId: ambiguousDesktopMessage.id,
              rawJson: {},
              resolution: 'matched' as const,
              revisionId: ambiguousDesktopRevision.id,
              sourceKey: 'desktop:ambiguous:matched',
              sourceKind: 'telegram_desktop_json' as const,
              telegramMessageId: 44n,
            },
          ])
          .returning({ id: messageSourceObservations.id });
        ambiguousDesktopObservationIds = ambiguousDesktopObservations.map((row) => row.id);
      } finally {
        await legacyConnection.close();
      }

      await runMigrations(legacyUrl.toString());
      await runMigrations(legacyUrl.toString());
      const upgradedConnection = createDatabaseConnection(legacyUrl.toString());
      try {
        const evidence = await upgradedConnection.db
          .select({
            availability: messageSourceMediaObservations.availability,
            desktopSourcePath: messageSourceMediaObservations.desktopSourcePath,
            observationId: messageSourceMediaObservations.observationId,
            position: messageSourceMediaObservations.position,
            sourceKind: messageSourceMediaObservations.sourceKind,
            telegramFileId: messageSourceMediaObservations.telegramFileId,
          })
          .from(messageSourceMediaObservations)
          .orderBy(
            messageSourceMediaObservations.sourceKind,
            messageSourceMediaObservations.position,
          );
        expect(evidence).toHaveLength(3);
        expect(evidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              availability: 'available',
              sourceKind: 'telegram_bot_update',
              telegramFileId: 'bot-file-id',
            }),
            expect.objectContaining({
              availability: 'available',
              desktopSourcePath: 'photos/photo_1.jpg',
              position: 0,
              sourceKind: 'telegram_desktop_json',
            }),
            expect.objectContaining({
              availability: 'not_included',
              desktopSourcePath: null,
              position: 1,
              sourceKind: 'telegram_desktop_json',
            }),
          ]),
        );
        expect(evidence.some((row) => row.observationId === crossSourceObservationId)).toBe(false);
        expect(evidence.some((row) => row.observationId === matchedBotObservationId)).toBe(false);
        expect(
          evidence.some((row) => ambiguousDesktopObservationIds.includes(row.observationId)),
        ).toBe(false);
      } finally {
        await upgradedConnection.close();
      }
    } finally {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end();
      await rm(legacyMigrations, { force: true, recursive: true });
    }
  }, 60_000);

  it('enforces persisted run, finding, action, and schedule lifecycle constraints', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }

    const database = connection.db;
    await database.insert(telegramChannelAllowlist).values({
      telegramChatId: TELEGRAM_CHANNEL_ID,
      title: 'Allowlisted channel without archive rows',
      username: 'koharu_test',
    });

    await expect(
      database.insert(reconciliationRuns).values({
        initiatorKind: 'local_operator',
        mode: 'persisted_scan',
        scope: [TELEGRAM_CHANNEL_ID.toString()],
        status: 'completed',
      }),
    ).rejects.toThrow();
    const completedAt = new Date('2026-07-24T00:10:00.000Z');
    const [run] = await database
      .insert(reconciliationRuns)
      .values({
        completedAt,
        initiatorKind: 'worker',
        mode: 'scheduled_scan',
        scope: [TELEGRAM_CHANNEL_ID.toString()],
        status: 'completed',
      })
      .returning({ id: reconciliationRuns.id });
    if (!run) {
      throw new Error('Fixture reconciliation run was not created');
    }

    await database.insert(reconciliationSchedule).values({
      intervalSeconds: 300,
      lastRunId: run.id,
      lastStatus: 'completed',
      nextRunAt: new Date('2026-07-24T00:15:00.000Z'),
    });
    await expect(
      database
        .update(reconciliationSchedule)
        .set({ leaseOwner: 'worker-1' })
        .where(eq(reconciliationSchedule.singletonKey, 'telegram')),
    ).rejects.toThrow();
    await expect(
      database
        .update(reconciliationSchedule)
        .set({
          claimedRunId: run.id,
          leaseExpiresAt: new Date('2026-07-24T00:16:00.000Z'),
          leaseOwner: 'worker-1',
          leaseToken: '1559f4b4-1349-49d5-b58e-75eeefa072ba',
        })
        .where(eq(reconciliationSchedule.singletonKey, 'telegram')),
    ).resolves.toBeDefined();

    await expect(
      database.insert(reconciliationFindings).values({
        kind: 'transport_id_discontinuity',
        sanitizedDetails: { rangeEnd: '9002', rangeStart: '9001' },
        severity: 'warning',
        stableKey: 'reconciliation:v1:global-transport',
      }),
    ).resolves.toBeDefined();
    await expect(
      database.insert(reconciliationFindings).values({
        kind: 'transport_id_discontinuity',
        severity: 'warning',
        stableKey: 'reconciliation:v1:invalid-channel-transport',
        telegramChatId: TELEGRAM_CHANNEL_ID,
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(reconciliationFindings).values({
        kind: 'message_id_candidate',
        sanitizedDetails: { rangeEnd: '43', rangeStart: '42' },
        severity: 'warning',
        stableKey: 'reconciliation:v1:invalid-global-message-gap',
      }),
    ).rejects.toThrow();

    const [finding] = await database
      .insert(reconciliationFindings)
      .values({
        kind: 'message_id_candidate',
        sanitizedDetails: { rangeEnd: '43', rangeStart: '42' },
        severity: 'warning',
        stableKey: 'reconciliation:v1:fixture',
        telegramChatId: TELEGRAM_CHANNEL_ID,
      })
      .returning({ id: reconciliationFindings.id });
    if (!finding) {
      throw new Error('Fixture reconciliation finding was not created');
    }
    await expect(
      database.insert(reconciliationFindings).values({
        kind: 'message_id_candidate',
        severity: 'warning',
        stableKey: 'reconciliation:v1:fixture',
        telegramChatId: TELEGRAM_CHANNEL_ID,
      }),
    ).rejects.toThrow();
    await expect(
      database
        .update(reconciliationFindings)
        .set({ state: 'resolved' })
        .where(eq(reconciliationFindings.id, finding.id)),
    ).rejects.toThrow();
    await expect(
      database
        .update(reconciliationFindings)
        .set({ resolvedAt: completedAt, state: 'resolved' })
        .where(eq(reconciliationFindings.id, finding.id)),
    ).resolves.toBeDefined();

    await expect(
      database.insert(reconciliationActions).values({
        actionKind: 'resolve_verified_invariant',
        findingId: finding.id,
        initiatorKind: 'local_operator',
        reason: '  ',
        runId: run.id,
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(reconciliationActions).values({
        actionKind: 'resolve_verified_invariant',
        afterState: { evidenceVersion: 1, state: 'resolved' },
        beforeState: { evidenceVersion: 1, state: 'open' },
        findingId: finding.id,
        initiatorKind: 'local_operator',
        reason: 'Verified deterministic transport evidence',
        runId: run.id,
      }),
    ).resolves.toBeDefined();
  }, 30_000);
});
