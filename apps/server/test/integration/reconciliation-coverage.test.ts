import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  importRunCoverages,
  importRunObservations,
  importRuns,
  messageRevisions,
  messageSourceObservations,
  messages,
  reconciliationActions,
  reconciliationFindings,
  reconciliationRuns,
  telegramChannelAllowlist,
  telegramChannels,
} from '../../src/db/schema.js';
import { PostgresTelegramDesktopImportRepository } from '../../src/imports/import-repository.js';
import { CURRENT_RENDERER_VERSION } from '../../src/messages/renderer.js';
import { PostgresReconciliationPersistenceRepository } from '../../src/reconciliation/persistence-repository.js';
import { DeterministicRepairService } from '../../src/reconciliation/repair.js';
import { PostgresDeterministicRepairRepository } from '../../src/reconciliation/repair-repository.js';
import { PostgresReconciliationRepository } from '../../src/reconciliation/repository.js';
import { ReconciliationService } from '../../src/reconciliation/service.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const CHANNEL_ID = -1_002_234_260_754n;

describe('explicit Desktop coverage and deterministic lineage repair', () => {
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
    await connection?.db.execute(
      sql`truncate table ${telegramChannelAllowlist}, ${telegramChannels} cascade`,
    );
  });

  it('persists replay-safe bounded coverage and rejects invalid declarations at the schema', async () => {
    if (!connection || !container) {
      throw new Error('Database connection was not created');
    }
    const fixture = await seedCoverageFixture(connection.db);
    const repository = new PostgresTelegramDesktopImportRepository(
      container.getConnectionUri(),
      connection.db,
    );
    try {
      const range = {
        endMessageId: 2n,
        startMessageId: 1n,
        telegramChatId: CHANNEL_ID,
      };
      await repository.persistRunCoverages(fixture.runId, [range]);
      await repository.persistRunCoverages(fixture.runId, [range]);
      const [coverageCount] = await connection.db
        .select({ value: count() })
        .from(importRunCoverages);
      expect(coverageCount?.value).toBe(1);

      await expect(
        connection.db.insert(importRunCoverages).values({
          endMessageId: 1n,
          explicitlyComplete: true,
          runId: fixture.runId,
          startMessageId: 2n,
          telegramChatId: CHANNEL_ID,
        }),
      ).rejects.toThrow();
      await expect(
        connection.db.insert(importRunCoverages).values({
          endMessageId: 3n,
          explicitlyComplete: false,
          runId: fixture.runId,
          startMessageId: 3n,
          telegramChatId: CHANNEL_ID,
        }),
      ).rejects.toThrow();
    } finally {
      await repository.close();
    }
  });

  it('emits absence only inside explicitly complete coverage with missing run lineage', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await seedCoverageFixture(connection.db);
    const service = new ReconciliationService(new PostgresReconciliationRepository(connection.db));

    const withoutDeclaration = await service.scan({ telegramChannelIds: [CHANNEL_ID] });
    expect(
      withoutDeclaration.findings.some((finding) => finding.kind === 'desktop_absence_candidate'),
    ).toBe(false);

    await connection.db.insert(importRunCoverages).values({
      endMessageId: 2n,
      explicitlyComplete: true,
      runId: fixture.runId,
      startMessageId: 1n,
      telegramChatId: CHANNEL_ID,
    });
    const declared = await service.scan({ telegramChannelIds: [CHANNEL_ID] });
    const absence = declared.findings.filter(
      (finding) => finding.kind === 'desktop_absence_candidate',
    );
    expect(absence).toEqual([
      expect.objectContaining({
        channelId: CHANNEL_ID.toString(),
        messageId: fixture.messageIds[1],
        severity: 'warning',
      }),
    ]);
    expect(JSON.stringify(absence)).not.toContain('private-source-locator');
  });

  it('repairs only observation-declared first-run lineage and audits the idempotent result', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const fixture = await seedCoverageFixture(connection.db);
    await connection.db
      .delete(importRunObservations)
      .where(eq(importRunObservations.observationId, fixture.observationId));
    const persisted = await new PostgresReconciliationPersistenceRepository(
      connection.db,
    ).persistScan({
      initiatorId: 'operator-1',
      initiatorKind: 'local_operator',
      telegramChannelIds: [CHANNEL_ID],
    });
    const [finding] = await connection.db
      .select()
      .from(reconciliationFindings)
      .where(eq(reconciliationFindings.kind, 'import_lineage_missing'));
    if (!finding) {
      throw new Error('Lineage finding was not persisted');
    }
    expect(persisted.report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'import_lineage_missing',
          observationId: fixture.observationId,
        }),
      ]),
    );
    const repair = new DeterministicRepairService(
      new PostgresDeterministicRepairRepository(connection.db),
    );
    const input = {
      expectedEvidenceVersion: finding.evidenceVersion,
      findingId: finding.id,
      initiatorId: 'operator-1',
      initiatorKind: 'local_operator' as const,
      reason: 'restore deterministic Desktop run lineage',
    };

    await expect(repair.apply(input)).resolves.toMatchObject({
      actionKind: 'import_lineage.restore',
      changed: true,
      replayed: false,
      runId: expect.any(String),
    });
    await expect(repair.apply(input)).resolves.toMatchObject({
      actionKind: 'import_lineage.restore',
      changed: false,
      replayed: true,
      runId: null,
    });
    const links = await connection.db
      .select()
      .from(importRunObservations)
      .where(eq(importRunObservations.observationId, fixture.observationId));
    expect(links).toEqual([
      expect.objectContaining({
        observationId: fixture.observationId,
        replayed: false,
        resolutionAtRun: 'created',
        runId: fixture.runId,
        sourceKind: 'telegram_desktop_json',
      }),
    ]);
    const actions = await connection.db
      .select()
      .from(reconciliationActions)
      .where(eq(reconciliationActions.findingId, finding.id));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      actionKind: 'import_lineage.restore',
      reason: input.reason,
    });
    const serializedAudit = JSON.stringify(actions);
    expect(serializedAudit).not.toContain('private-source-locator');
    expect(serializedAudit).not.toContain('raw_json');
    const [applyRun] = await connection.db
      .select()
      .from(reconciliationRuns)
      .where(
        eq(reconciliationRuns.id, actions[0]?.runId ?? '00000000-0000-0000-0000-000000000000'),
      );
    expect(applyRun).toMatchObject({ mode: 'apply', status: 'completed' });
  });
});

type TestDatabase = DatabaseConnection['db'];

async function seedCoverageFixture(database: TestDatabase) {
  await database.insert(telegramChannelAllowlist).values({
    telegramChatId: CHANNEL_ID,
    title: 'Coverage channel',
    username: 'coverage_channel',
  });
  const [channel] = await database
    .insert(telegramChannels)
    .values({
      telegramChatId: CHANNEL_ID,
      title: 'Coverage channel',
      username: 'coverage_channel',
    })
    .returning({ id: telegramChannels.id });
  if (!channel) {
    throw new Error('Channel fixture was not created');
  }
  const now = new Date('2026-07-24T00:00:00.000Z');
  const [run] = await database
    .insert(importRuns)
    .values({
      completedAt: now,
      parserVersion: 1,
      report: {},
      selectedChannels: [CHANNEL_ID.toString()],
      sourceFileSha256: 'fixture-sha256',
      sourceKind: 'telegram_desktop_json',
      startedAt: now,
      status: 'completed',
    })
    .returning({ id: importRuns.id });
  if (!run) {
    throw new Error('Import run fixture was not created');
  }
  const messageRows = await database
    .insert(messages)
    .values(
      [1n, 2n, 3n].map((telegramMessageId) => ({
        channelId: channel.id,
        currentRevisionNumber: 1,
        publishedAt: now,
        telegramMessageId,
      })),
    )
    .returning({ id: messages.id, telegramMessageId: messages.telegramMessageId });
  await database.insert(messageRevisions).values(
    messageRows.map((message) => ({
      contentKind: 'none' as const,
      entities: [],
      html: null,
      messageId: message.id,
      rendererVersion: CURRENT_RENDERER_VERSION,
      revisionNumber: 1,
      text: null,
    })),
  );
  const firstMessage = messageRows.find((message) => message.telegramMessageId === 1n);
  if (!firstMessage) {
    throw new Error('Message fixture was not created');
  }
  const [observation] = await database
    .insert(messageSourceObservations)
    .values({
      channelId: channel.id,
      contentFingerprint: 'fixture-fingerprint',
      contentFingerprintVersion: 1,
      importRunId: run.id,
      messageId: firstMessage.id,
      observedAt: now,
      rawJson: { source: 'private-source-locator' },
      resolution: 'created',
      sourceKey: 'private-source-locator',
      sourceKind: 'telegram_desktop_json',
      telegramMessageId: 1n,
    })
    .returning({ id: messageSourceObservations.id });
  if (!observation) {
    throw new Error('Observation fixture was not created');
  }
  await database.insert(importRunObservations).values({
    observationId: observation.id,
    replayed: false,
    resolutionAtRun: 'created',
    runId: run.id,
    sourceKind: 'telegram_desktop_json',
  });
  return {
    messageIds: messageRows
      .sort((left, right) => (left.telegramMessageId < right.telegramMessageId ? -1 : 1))
      .map((message) => message.id),
    observationId: observation.id,
    runId: run.id,
  };
}
