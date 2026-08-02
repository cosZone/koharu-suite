import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OwnerMessageVisibilityConflictError,
  OwnerMessageVisibilityService,
} from '../../src/admin/message-visibility.js';
import { PostgresOwnerMessageVisibilityRepository } from '../../src/admin/message-visibility-repository.js';
import { PostgresAdminRepository } from '../../src/admin/repository.js';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  messageRevisions,
  messageSourceObservations,
  operationAuditEvents,
  telegramChannelAllowlist,
} from '../../src/db/schema.js';
import { PostgresMessageRepository } from '../../src/messages/repository.js';
import { normalizeChannelPost } from '../../src/telegram/normalize.js';
import { channelPostFixture } from '../fixtures/telegram.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';
const CHANNEL_ID = -1_002_234_260_754n;

describe('owner-selected message visibility', () => {
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

  it('hides and restores any selected message with CAS and independent audit', async () => {
    if (!connection) throw new Error('Database connection was not created');
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
    if (!normalized) throw new Error('Telegram fixture did not normalize');
    const publicMessages = new PostgresMessageRepository(database);
    const ingested = await publicMessages.ingest(normalized);
    const admin = new PostgresAdminRepository(database);
    const initial = (await admin.listMessages(ingested.channelId, { limit: 10, visibility: 'all' }))
      ?.items[0];
    if (!initial) throw new Error('Admin message was not found');
    const evidenceBefore = {
      observations: await database.select().from(messageSourceObservations),
      revisions: await database.select().from(messageRevisions),
    };
    const service = new OwnerMessageVisibilityService(
      new PostgresOwnerMessageVisibilityRepository(database),
    );
    const input = {
      actorId: 'owner-1',
      actorType: 'owner_session' as const,
      expectedUpdatedAt: initial.updatedAt,
      messageId: ingested.messageId,
      reason: 'Owner chose to remove this message from the public archive',
    };

    const hidden = await service.hide(input);
    expect(hidden).toMatchObject({ changed: true, tombstoned: true });
    await expect(publicMessages.getMessage(ingested.messageId)).resolves.toBeNull();
    await expect(
      admin.listMessages(ingested.channelId, { limit: 10, visibility: 'hidden' }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ id: ingested.messageId, tombstoned: true })],
      nextCursor: null,
    });
    expect({
      observations: await database.select().from(messageSourceObservations),
      revisions: await database.select().from(messageRevisions),
    }).toEqual(evidenceBefore);

    await expect(service.unhide(input)).rejects.toBeInstanceOf(OwnerMessageVisibilityConflictError);
    const restored = await service.unhide({ ...input, expectedUpdatedAt: hidden.updatedAt });
    expect(restored).toMatchObject({ changed: true, tombstoned: false });
    await expect(publicMessages.getMessage(ingested.messageId)).resolves.toMatchObject({
      id: ingested.messageId,
    });

    const actions = await database
      .select()
      .from(operationAuditEvents)
      .where(eq(operationAuditEvents.targetId, ingested.messageId));
    expect(actions).toEqual([
      expect.objectContaining({
        action: 'message.hide',
        actorId: 'owner-1',
        actorType: 'owner_session',
        reason: input.reason,
        targetType: 'message',
      }),
      expect.objectContaining({
        action: 'message.unhide',
        actorId: 'owner-1',
        actorType: 'owner_session',
        targetType: 'message',
      }),
    ]);

    const olderNormalized = normalizeChannelPost(
      channelPostFixture({
        channelId: Number(CHANNEL_ID),
        date: 1_751_299_000,
        messageId: 41,
        text: 'An older message',
        updateId: 1_000,
      }),
      CHANNEL_ID,
    );
    if (!olderNormalized) throw new Error('Older Telegram fixture did not normalize');
    const older = await publicMessages.ingest(olderNormalized);
    const olderManaged = await admin.getMessage(older.messageId);
    const currentManaged = await admin.getMessage(ingested.messageId);
    if (!olderManaged || !currentManaged) throw new Error('Managed messages were not found');
    await service.hide({
      ...input,
      expectedUpdatedAt: olderManaged.updatedAt,
      messageId: older.messageId,
      reason: 'Hide older message for pagination test',
    });
    await service.hide({
      ...input,
      expectedUpdatedAt: currentManaged.updatedAt,
      reason: 'Hide current message for pagination test',
    });
    const firstHiddenPage = await admin.listMessages(ingested.channelId, {
      limit: 1,
      visibility: 'hidden',
    });
    expect(firstHiddenPage?.items).toHaveLength(1);
    expect(firstHiddenPage?.nextCursor).not.toBeNull();
    const secondHiddenPage = await admin.listMessages(ingested.channelId, {
      ...(firstHiddenPage?.nextCursor ? { cursor: firstHiddenPage.nextCursor } : {}),
      limit: 1,
      visibility: 'hidden',
    });
    expect(secondHiddenPage).toMatchObject({ items: [expect.any(Object)], nextCursor: null });
    expect(
      new Set([
        ...(firstHiddenPage?.items.map((item) => item.id) ?? []),
        ...(secondHiddenPage?.items.map((item) => item.id) ?? []),
      ]),
    ).toEqual(new Set([ingested.messageId, older.messageId]));
  }, 30_000);
});
