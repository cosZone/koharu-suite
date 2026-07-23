import { and, count, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import type { Database } from '../db/client.js';
import {
  messageRevisions,
  messages,
  telegramChannelAllowlist,
  telegramChannels,
  telegramIngestTasks,
  telegramPollingState,
  telegramUpdates,
} from '../db/schema.js';

export interface AdminStatusSnapshot {
  counts: {
    activeChannels: number;
    blockedTasks: number;
    configuredChannels: number;
    messages: number;
    pendingTasks: number;
    retryingTasks: number;
    updates: number;
  };
  lastCheckpoint: string | null;
}

export interface AdminReader {
  getRawUpdate(messageId: string): Promise<Update | null>;
  getStatus(): Promise<AdminStatusSnapshot>;
}

async function countRows(
  database: Database,
  table:
    | typeof messages
    | typeof telegramChannelAllowlist
    | typeof telegramChannels
    | typeof telegramUpdates,
): Promise<number> {
  const [result] = await database.select({ value: count() }).from(table);
  return result?.value ?? 0;
}

export class PostgresAdminRepository implements AdminReader {
  constructor(private readonly database: Database) {}

  async getStatus(): Promise<AdminStatusSnapshot> {
    const [
      activeChannels,
      configuredChannels,
      messageCount,
      updates,
      pendingTasks,
      retryingTasks,
      blockedTasks,
      pollingState,
    ] = await Promise.all([
      countRows(this.database, telegramChannels),
      countRows(this.database, telegramChannelAllowlist),
      countRows(this.database, messages),
      countRows(this.database, telegramUpdates),
      this.taskCount(
        and(
          isNull(telegramIngestTasks.processedAt),
          isNull(telegramIngestTasks.blockedAt),
          eq(telegramIngestTasks.attemptCount, 0),
        ),
      ),
      this.taskCount(
        and(
          isNull(telegramIngestTasks.processedAt),
          isNull(telegramIngestTasks.blockedAt),
          gt(telegramIngestTasks.attemptCount, 0),
        ),
      ),
      this.taskCount(isNotNull(telegramIngestTasks.blockedAt)),
      this.database
        .select({
          nextUpdateId: telegramPollingState.nextUpdateId,
          updatedAt: telegramPollingState.updatedAt,
        })
        .from(telegramPollingState)
        .where(eq(telegramPollingState.singleton, 1))
        .limit(1),
    ]);

    const checkpoint = pollingState[0];
    return {
      counts: {
        activeChannels,
        blockedTasks,
        configuredChannels,
        messages: messageCount,
        pendingTasks,
        retryingTasks,
        updates,
      },
      lastCheckpoint:
        checkpoint?.nextUpdateId === null || checkpoint === undefined
          ? null
          : checkpoint.updatedAt.toISOString(),
    };
  }

  async getRawUpdate(messageId: string): Promise<Update | null> {
    const [row] = await this.database
      .select({ update: telegramUpdates.rawJson })
      .from(messages)
      .innerJoin(
        messageRevisions,
        and(
          eq(messageRevisions.messageId, messages.id),
          eq(messageRevisions.revisionNumber, messages.currentRevisionNumber),
        ),
      )
      .innerJoin(
        telegramUpdates,
        eq(telegramUpdates.telegramUpdateId, messageRevisions.telegramUpdateId),
      )
      .where(eq(messages.id, messageId))
      .limit(1);

    return row?.update ?? null;
  }

  private async taskCount(where: ReturnType<typeof and> | ReturnType<typeof isNotNull>) {
    const [result] = await this.database
      .select({ value: count() })
      .from(telegramIngestTasks)
      .where(where);
    return result?.value ?? 0;
  }
}
