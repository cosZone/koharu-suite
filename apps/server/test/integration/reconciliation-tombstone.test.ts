import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  messageMedia,
  messageRevisions,
  messageSourceObservations,
  messages,
  reconciliationActions,
  reconciliationFindings,
  telegramChannelAllowlist,
} from '../../src/db/schema.js';
import { PostgresMessageRepository } from '../../src/messages/repository.js';
import { MessageTombstoneService } from '../../src/reconciliation/tombstone.js';
import { PostgresMessageTombstoneRepository } from '../../src/reconciliation/tombstone-repository.js';
import { normalizeChannelPost } from '../../src/telegram/normalize.js';
import { channelPostFixture } from '../fixtures/telegram.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const CHANNEL_ID = -1_002_234_260_754n;

describe('owner message tombstone', () => {
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

  it('hides and unhides only the public projection while preserving immutable evidence', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const database = connection.db;
    await database.insert(telegramChannelAllowlist).values({
      telegramChatId: CHANNEL_ID,
      title: 'Koharu Test Channel',
      username: 'koharu_test',
    });
    const normalized = normalizeChannelPost(
      channelPostFixture({ channelId: Number(CHANNEL_ID) }),
      CHANNEL_ID,
    );
    if (!normalized) {
      throw new Error('Telegram fixture did not normalize');
    }
    const publicMessages = new PostgresMessageRepository(database);
    const ingested = await publicMessages.ingest(normalized);
    const [finding] = await database
      .insert(reconciliationFindings)
      .values({
        evidenceVersion: 1,
        kind: 'desktop_absence_candidate',
        messageId: ingested.messageId,
        sanitizedDetails: { rangeEnd: '42', rangeStart: '42' },
        severity: 'warning',
        stableKey: 'tombstone:desktop-absence:42',
        telegramChatId: CHANNEL_ID,
      })
      .returning({ id: reconciliationFindings.id });
    if (!finding) {
      throw new Error('Desktop absence finding was not created');
    }
    const evidenceSnapshot = async () => {
      const [revision, media, observation] = await Promise.all([
        database.select().from(messageRevisions),
        database.select().from(messageMedia),
        database.select().from(messageSourceObservations),
      ]);
      return { media, observation, revision };
    };
    const beforeEvidence = await evidenceSnapshot();
    await expect(publicMessages.getMessage(ingested.messageId)).resolves.toMatchObject({
      id: ingested.messageId,
    });
    await expect(
      publicMessages.listMessages(ingested.channelId, { limit: 10 }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: ingested.messageId })],
    });

    const tombstones = new MessageTombstoneService(
      new PostgresMessageTombstoneRepository(database),
    );
    const input = {
      expectedEvidenceVersion: 1,
      findingId: finding.id,
      initiatorId: 'owner-1',
      initiatorKind: 'owner_session' as const,
      messageId: ingested.messageId,
      reason: '  Complete Desktop export confirms this message should be hidden  ',
    };
    await expect(tombstones.hide(input)).resolves.toMatchObject({
      changed: true,
      replayed: false,
      tombstoned: true,
    });
    await expect(tombstones.hide(input)).resolves.toMatchObject({
      changed: false,
      replayed: true,
      tombstoned: true,
    });

    await expect(publicMessages.getMessage(ingested.messageId)).resolves.toBeNull();
    await expect(
      publicMessages.listMessages(ingested.channelId, { limit: 10 }),
    ).resolves.toMatchObject({ items: [] });
    expect(await evidenceSnapshot()).toEqual(beforeEvidence);
    const [hidden] = await database
      .select({ tombstonedAt: messages.tombstonedAt })
      .from(messages)
      .where(eq(messages.id, ingested.messageId));
    expect(hidden?.tombstonedAt).toBeInstanceOf(Date);

    let actions = await database
      .select()
      .from(reconciliationActions)
      .where(eq(reconciliationActions.findingId, finding.id));
    expect(actions).toHaveLength(2);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionKind: 'message.hide',
          afterState: expect.objectContaining({ tombstoned: true }),
          beforeState: expect.objectContaining({ tombstoned: false }),
          initiatorId: 'owner-1',
          initiatorKind: 'owner_session',
          reason: 'Complete Desktop export confirms this message should be hidden',
        }),
        expect.objectContaining({
          actionKind: 'message.hide',
          afterState: expect.objectContaining({ tombstoned: true }),
          beforeState: expect.objectContaining({ tombstoned: true }),
        }),
      ]),
    );

    await database
      .update(reconciliationFindings)
      .set({
        evidenceVersion: 2,
        resolvedAt: new Date('2026-07-24T12:00:00.000Z'),
        state: 'resolved',
      })
      .where(eq(reconciliationFindings.id, finding.id));
    await expect(tombstones.unhide(input)).rejects.toThrow('evidence version changed');
    await expect(publicMessages.getMessage(ingested.messageId)).resolves.toBeNull();
    await expect(
      tombstones.unhide({ ...input, expectedEvidenceVersion: 2 }),
    ).resolves.toMatchObject({
      changed: true,
      replayed: false,
      tombstoned: false,
    });
    await expect(
      tombstones.unhide({ ...input, expectedEvidenceVersion: 2 }),
    ).resolves.toMatchObject({
      changed: false,
      replayed: true,
      tombstoned: false,
    });
    await expect(publicMessages.getMessage(ingested.messageId)).resolves.toMatchObject({
      id: ingested.messageId,
    });
    expect(await evidenceSnapshot()).toEqual(beforeEvidence);

    actions = await database
      .select()
      .from(reconciliationActions)
      .where(eq(reconciliationActions.findingId, finding.id));
    expect(actions).toHaveLength(4);
    expect(actions.at(-1)).toMatchObject({
      actionKind: 'message.unhide',
      afterState: expect.objectContaining({ tombstoned: false }),
      beforeState: expect.objectContaining({ tombstoned: false }),
    });
  }, 30_000);

  it('rejects a non-absence finding without changing visibility or writing audit', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const database = connection.db;
    await database.insert(telegramChannelAllowlist).values({
      telegramChatId: CHANNEL_ID,
      title: 'Koharu Test Channel',
      username: 'koharu_test',
    });
    const normalized = normalizeChannelPost(
      channelPostFixture({ channelId: Number(CHANNEL_ID) }),
      CHANNEL_ID,
    );
    if (!normalized) {
      throw new Error('Telegram fixture did not normalize');
    }
    const publicMessages = new PostgresMessageRepository(database);
    const ingested = await publicMessages.ingest(normalized);
    const [finding] = await database
      .insert(reconciliationFindings)
      .values({
        kind: 'message_id_candidate',
        messageId: ingested.messageId,
        sanitizedDetails: {},
        severity: 'warning',
        stableKey: 'tombstone:unsafe-gap:42',
        telegramChatId: CHANNEL_ID,
      })
      .returning({ id: reconciliationFindings.id });
    if (!finding) {
      throw new Error('Unsafe finding was not created');
    }

    const tombstones = new MessageTombstoneService(
      new PostgresMessageTombstoneRepository(database),
    );
    await expect(
      tombstones.hide({
        expectedEvidenceVersion: 1,
        findingId: finding.id,
        initiatorId: 'owner-1',
        initiatorKind: 'owner_session',
        messageId: ingested.messageId,
        reason: 'unsafe action must be rejected',
      }),
    ).rejects.toThrow('Only a Desktop absence candidate');
    await expect(publicMessages.getMessage(ingested.messageId)).resolves.toMatchObject({
      id: ingested.messageId,
    });
    const [actionCount] = await database.select({ value: count() }).from(reconciliationActions);
    expect(actionCount?.value).toBe(0);
  }, 30_000);
});
