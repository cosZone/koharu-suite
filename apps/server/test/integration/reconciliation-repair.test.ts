import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { count, eq, sql } from 'drizzle-orm';
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
} from '../../src/db/schema.js';
import { CURRENT_RENDERER_VERSION, renderTelegramMessage } from '../../src/messages/renderer.js';
import { PostgresMessageRepository } from '../../src/messages/repository.js';
import { DeterministicRepairService } from '../../src/reconciliation/repair.js';
import { PostgresDeterministicRepairRepository } from '../../src/reconciliation/repair-repository.js';
import { normalizeChannelPost } from '../../src/telegram/normalize.js';
import { channelPostFixture } from '../fixtures/telegram.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const CHANNEL_ID = -1_002_234_260_754n;

describe('deterministic reconciliation repair', () => {
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
    await connection?.db.execute(sql`truncate table ${telegramChannelAllowlist} cascade`);
  });

  it('rerenders only derived HTML and records one idempotent audit action', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const database = connection.db;
    const { messageId } = await seedMessage(database, 41n, 1);
    const text = 'Koharu **derived** state';
    const [revision] = await database
      .insert(messageRevisions)
      .values({
        contentKind: 'text',
        entities: [],
        html: '<p>stale</p>',
        messageId,
        rendererVersion: 0,
        revisionNumber: 1,
        text,
      })
      .returning();
    if (!revision) {
      throw new Error('Revision was not created');
    }
    const findingId = await insertFinding(database, {
      kind: 'derived_html_drift',
      messageId,
      stableKey: 'repair:derived',
    });
    const repair = new DeterministicRepairService(
      new PostgresDeterministicRepairRepository(database),
    );
    const input = {
      expectedEvidenceVersion: 1,
      findingId,
      initiatorId: 'owner-1',
      initiatorKind: 'owner_session' as const,
      reason: 'rerender deterministic HTML',
    };

    await expect(repair.apply(input)).resolves.toMatchObject({
      actionKind: 'derived_html.rerender',
      changed: true,
      replayed: false,
    });
    await expect(repair.apply(input)).resolves.toMatchObject({
      actionKind: 'derived_html.rerender',
      changed: false,
      replayed: true,
    });

    const [storedRevision] = await database
      .select()
      .from(messageRevisions)
      .where(eq(messageRevisions.id, revision.id));
    expect(storedRevision).toMatchObject({
      contentKind: revision.contentKind,
      entities: revision.entities,
      html: renderTelegramMessage(text, []),
      rendererVersion: CURRENT_RENDERER_VERSION,
      text,
    });
    const [actionCount] = await database
      .select({ value: count() })
      .from(reconciliationActions)
      .where(eq(reconciliationActions.findingId, findingId));
    expect(actionCount?.value).toBe(1);
    const [action] = await database
      .select()
      .from(reconciliationActions)
      .where(eq(reconciliationActions.findingId, findingId));
    expect(action).toMatchObject({
      actionKind: 'derived_html.rerender',
      initiatorId: 'owner-1',
      initiatorKind: 'owner_session',
      reason: input.reason,
    });
    expect(action?.runId).toBeTruthy();
    const [run] = await database
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.id, action?.runId ?? '00000000-0000-0000-0000-000000000000'));
    expect(run).toMatchObject({
      initiatorId: 'owner-1',
      initiatorKind: 'owner_session',
      mode: 'apply',
      scope: [CHANNEL_ID.toString()],
      status: 'completed',
    });
    expect(run?.report).toMatchObject({
      counts: {
        findings: 1,
        repaired: 1,
        resolved: 1,
      },
      findings: [
        {
          evidenceVersion: 1,
          kind: 'derived_html_drift',
          messageId,
          stableKey: 'repair:derived',
          state: 'resolved',
        },
      ],
      mode: 'apply',
      schemaVersion: 1,
      status: 'repaired',
    });
    const [finding] = await database
      .select()
      .from(reconciliationFindings)
      .where(eq(reconciliationFindings.id, findingId));
    expect(finding).toMatchObject({ evidenceVersion: 1, state: 'resolved' });
    expect(finding?.resolvedAt).toBeInstanceOf(Date);
  });

  it('repairs only a uniquely proven contiguous current pointer', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const database = connection.db;
    const valid = await seedMessage(database, 42n, 4);
    await database.insert(messageRevisions).values(
      [1, 2, 3].map((revisionNumber) => ({
        contentKind: 'none' as const,
        entities: [],
        html: null,
        messageId: valid.messageId,
        rendererVersion: CURRENT_RENDERER_VERSION,
        revisionNumber,
        text: null,
      })),
    );
    const validFinding = await insertFinding(database, {
      kind: 'current_pointer_invalid',
      messageId: valid.messageId,
      stableKey: 'repair:pointer:valid',
    });
    const repair = new DeterministicRepairService(
      new PostgresDeterministicRepairRepository(database),
    );

    await expect(repair.apply(repairInput(validFinding))).resolves.toMatchObject({
      actionKind: 'current_pointer.repair',
      changed: true,
    });
    const [repaired] = await database
      .select({ currentRevisionNumber: messages.currentRevisionNumber })
      .from(messages)
      .where(eq(messages.id, valid.messageId));
    expect(repaired?.currentRevisionNumber).toBe(3);

    const ambiguous = await seedMessage(database, 43n, 4);
    await database.insert(messageRevisions).values(
      [1, 3].map((revisionNumber) => ({
        contentKind: 'none' as const,
        entities: [],
        html: null,
        messageId: ambiguous.messageId,
        rendererVersion: CURRENT_RENDERER_VERSION,
        revisionNumber,
        text: null,
      })),
    );
    const ambiguousFinding = await insertFinding(database, {
      kind: 'current_pointer_invalid',
      messageId: ambiguous.messageId,
      stableKey: 'repair:pointer:ambiguous',
    });

    await expect(repair.apply(repairInput(ambiguousFinding))).rejects.toThrow(
      'Current pointer target cannot be uniquely proven',
    );
    const [unchanged] = await database
      .select({ currentRevisionNumber: messages.currentRevisionNumber })
      .from(messages)
      .where(eq(messages.id, ambiguous.messageId));
    expect(unchanged?.currentRevisionNumber).toBe(4);

    const alreadyValid = await seedMessage(database, 45n, 1);
    await database.insert(messageRevisions).values({
      contentKind: 'none',
      entities: [],
      html: null,
      messageId: alreadyValid.messageId,
      rendererVersion: CURRENT_RENDERER_VERSION,
      revisionNumber: 1,
      text: null,
    });
    const alreadyValidFinding = await insertFinding(database, {
      kind: 'current_pointer_invalid',
      messageId: alreadyValid.messageId,
      stableKey: 'repair:pointer:already-valid',
    });
    const alreadyConsistent = await repair.apply(repairInput(alreadyValidFinding));
    expect(alreadyConsistent).toMatchObject({
      changed: false,
      replayed: false,
      runId: expect.any(String),
    });
    const [noopAction] = await database
      .select()
      .from(reconciliationActions)
      .where(eq(reconciliationActions.findingId, alreadyValidFinding));
    expect(noopAction).toMatchObject({
      actionKind: 'resolve_already_consistent',
      reason: repairInput(alreadyValidFinding).reason,
      runId: alreadyConsistent.runId,
    });
    const [noopRun] = await database
      .select()
      .from(reconciliationRuns)
      .where(
        eq(
          reconciliationRuns.id,
          alreadyConsistent.runId ?? '00000000-0000-0000-0000-000000000000',
        ),
      );
    expect(noopRun?.report).toMatchObject({
      counts: { findings: 1, repaired: 0, resolved: 1 },
      mode: 'apply',
      schemaVersion: 1,
      status: 'clean',
    });
    await expect(repair.apply(repairInput(alreadyValidFinding))).resolves.toMatchObject({
      replayed: true,
      runId: null,
    });
    const [noopActionCount] = await database
      .select({ value: count() })
      .from(reconciliationActions)
      .where(eq(reconciliationActions.findingId, alreadyValidFinding));
    expect(noopActionCount?.value).toBe(1);
  });

  it('restores missing observation media from immutable raw without touching canonical media', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const database = connection.db;
    await database.insert(telegramChannelAllowlist).values({
      telegramChatId: CHANNEL_ID,
      title: 'Repair channel',
      username: 'repair_channel',
    });
    const post = normalizeChannelPost(
      channelPostFixture({
        channelId: Number(CHANNEL_ID),
        messageId: 44,
        updateId: 4_404,
        username: 'repair_channel',
      }),
      CHANNEL_ID,
    );
    if (!post) {
      throw new Error('Bot fixture did not normalize');
    }
    const ingested = await new PostgresMessageRepository(database).ingest(post);
    const [observation] = await database
      .select()
      .from(messageSourceObservations)
      .where(eq(messageSourceObservations.messageId, ingested.messageId));
    if (!observation) {
      throw new Error('Observation was not created');
    }
    const [canonicalBefore] = await database.select({ value: count() }).from(messageMedia);
    await database
      .delete(messageSourceMediaObservations)
      .where(eq(messageSourceMediaObservations.observationId, observation.id));
    const findingId = await insertFinding(database, {
      kind: 'media_evidence_missing',
      messageId: ingested.messageId,
      observationId: observation.id,
      stableKey: 'repair:source-media',
    });
    const repair = new DeterministicRepairService(
      new PostgresDeterministicRepairRepository(database),
    );

    await expect(repair.apply(repairInput(findingId))).resolves.toMatchObject({
      actionKind: 'source_media.restore',
      changed: true,
    });
    const restored = await database
      .select()
      .from(messageSourceMediaObservations)
      .where(eq(messageSourceMediaObservations.observationId, observation.id));
    expect(restored).toHaveLength(post.media.length);
    expect(restored[0]).toMatchObject({
      desktopSourcePath: null,
      sourceKind: 'telegram_bot_update',
      telegramFileId: post.media[0]?.fileId,
      telegramFileUniqueId: post.media[0]?.fileUniqueId,
    });
    const [canonicalAfter] = await database.select({ value: count() }).from(messageMedia);
    expect(canonicalAfter?.value).toBe(canonicalBefore?.value);

    const unsafeFinding = await insertFinding(database, {
      kind: 'observation_conflict',
      messageId: ingested.messageId,
      observationId: observation.id,
      stableKey: 'repair:unsafe-conflict',
    });
    await expect(repair.apply(repairInput(unsafeFinding))).rejects.toThrow(
      'This finding kind has no deterministic safe repair',
    );
    const [unsafeActionCount] = await database
      .select({ value: count() })
      .from(reconciliationActions)
      .where(eq(reconciliationActions.findingId, unsafeFinding));
    expect(unsafeActionCount?.value).toBe(0);
  });
});

type TestDatabase = DatabaseConnection['db'];

async function seedMessage(
  database: TestDatabase,
  telegramMessageId: bigint,
  currentRevisionNumber: number,
) {
  await database
    .insert(telegramChannelAllowlist)
    .values({
      telegramChatId: CHANNEL_ID,
      title: 'Repair channel',
      username: 'repair_channel',
    })
    .onConflictDoNothing();
  const [channel] = await database
    .insert(telegramChannels)
    .values({
      telegramChatId: CHANNEL_ID,
      title: 'Repair channel',
      username: 'repair_channel',
    })
    .onConflictDoUpdate({
      set: { title: 'Repair channel', username: 'repair_channel' },
      target: telegramChannels.telegramChatId,
    })
    .returning({ id: telegramChannels.id });
  if (!channel) {
    throw new Error('Channel was not created');
  }
  const [message] = await database
    .insert(messages)
    .values({
      channelId: channel.id,
      currentRevisionNumber,
      publishedAt: new Date('2026-07-24T00:00:00.000Z'),
      telegramMessageId,
    })
    .returning({ id: messages.id });
  if (!message) {
    throw new Error('Message was not created');
  }
  return { channelId: channel.id, messageId: message.id };
}

async function insertFinding(
  database: TestDatabase,
  input: {
    kind:
      | 'current_pointer_invalid'
      | 'derived_html_drift'
      | 'media_evidence_missing'
      | 'observation_conflict';
    messageId: string;
    observationId?: string;
    stableKey: string;
  },
) {
  const [finding] = await database
    .insert(reconciliationFindings)
    .values({
      kind: input.kind,
      messageId: input.messageId,
      observationId: input.observationId,
      sanitizedDetails: {},
      severity: 'error',
      stableKey: input.stableKey,
      telegramChatId: CHANNEL_ID,
    })
    .returning({ id: reconciliationFindings.id });
  if (!finding) {
    throw new Error('Finding was not created');
  }
  return finding.id;
}

function repairInput(findingId: string) {
  return {
    expectedEvidenceVersion: 1,
    findingId,
    initiatorId: 'operator-1',
    initiatorKind: 'local_operator' as const,
    reason: 'apply deterministic repair',
  };
}
