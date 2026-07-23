import { and, asc, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { AdminPrincipal } from '../auth/runtime-auth.js';
import type { Database } from '../db/client.js';
import {
  messageRevisions,
  operationAuditEvents,
  telegramChannelAllowlist,
  telegramIngestTasks,
} from '../db/schema.js';
import { CURRENT_RENDERER_VERSION, renderTelegramMessage } from '../messages/renderer.js';

export interface BlockedIngestTask {
  attemptCount: number;
  blockedAt: string;
  channelTitle: string;
  channelUsername: string | null;
  id: string;
  lastError: string | null;
  telegramUpdateId: string;
}

export interface ConfiguredTelegramChannel {
  disabledAt: string | null;
  enabled: boolean;
  telegramChatId: string;
  title: string;
  username: string | null;
}

export interface RerenderResult {
  currentVersion: number;
  hasMore: boolean;
  updated: number;
}

export class AdminOperationNotFoundError extends Error {}
export class AdminOperationConflictError extends Error {}

function normalizedReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 500) {
    throw new Error('reason must contain between 1 and 500 characters');
  }
  return reason;
}

function auditActor(principal: AdminPrincipal) {
  return {
    actorId: principal.actorId,
    actorType: principal.actorType,
  };
}

export class PostgresAdminOperations {
  constructor(private readonly database: Database) {}

  async listBlockedTasks(): Promise<BlockedIngestTask[]> {
    const rows = await this.database
      .select({
        attemptCount: telegramIngestTasks.attemptCount,
        blockedAt: telegramIngestTasks.blockedAt,
        channelTitle: telegramChannelAllowlist.title,
        channelUsername: telegramChannelAllowlist.username,
        id: telegramIngestTasks.id,
        lastError: telegramIngestTasks.lastError,
        telegramUpdateId: telegramIngestTasks.telegramUpdateId,
      })
      .from(telegramIngestTasks)
      .innerJoin(
        telegramChannelAllowlist,
        eq(telegramChannelAllowlist.telegramChatId, telegramIngestTasks.telegramChatId),
      )
      .where(
        and(
          isNotNull(telegramIngestTasks.blockedAt),
          isNull(telegramIngestTasks.processedAt),
          isNull(telegramIngestTasks.skippedAt),
        ),
      )
      .orderBy(asc(telegramIngestTasks.blockedAt), asc(telegramIngestTasks.telegramUpdateId));

    return rows.flatMap((row) =>
      row.blockedAt
        ? [
            {
              ...row,
              blockedAt: row.blockedAt.toISOString(),
              telegramUpdateId: row.telegramUpdateId.toString(),
            },
          ]
        : [],
    );
  }

  async listConfiguredChannels(): Promise<ConfiguredTelegramChannel[]> {
    const rows = await this.database
      .select()
      .from(telegramChannelAllowlist)
      .orderBy(asc(telegramChannelAllowlist.title), asc(telegramChannelAllowlist.telegramChatId));

    return rows.map((row) => ({
      disabledAt: row.disabledAt?.toISOString() ?? null,
      enabled: row.enabled,
      telegramChatId: row.telegramChatId.toString(),
      title: row.title,
      username: row.username,
    }));
  }

  async retryTask(id: string, reasonValue: string, principal: AdminPrincipal): Promise<void> {
    const reason = normalizedReason(reasonValue);
    await this.database.transaction(async (transaction) => {
      const [task] = await transaction
        .select({
          blockedAt: telegramIngestTasks.blockedAt,
          id: telegramIngestTasks.id,
          processedAt: telegramIngestTasks.processedAt,
          skippedAt: telegramIngestTasks.skippedAt,
        })
        .from(telegramIngestTasks)
        .where(eq(telegramIngestTasks.id, id))
        .limit(1)
        .for('update');
      if (!task) {
        throw new AdminOperationNotFoundError('Blocked task was not found');
      }
      if (task.processedAt || task.skippedAt || !task.blockedAt) {
        throw new AdminOperationConflictError('Task is no longer blocked');
      }

      const now = new Date();
      await transaction
        .update(telegramIngestTasks)
        .set({
          attemptCount: 0,
          availableAt: now,
          blockedAt: null,
          updatedAt: now,
        })
        .where(eq(telegramIngestTasks.id, id));
      await transaction.insert(operationAuditEvents).values({
        ...auditActor(principal),
        action: 'task.retry',
        details: {},
        reason,
        targetId: id,
        targetType: 'task',
      });
    });
  }

  async skipTask(id: string, reasonValue: string, principal: AdminPrincipal): Promise<void> {
    const reason = normalizedReason(reasonValue);
    await this.database.transaction(async (transaction) => {
      const [task] = await transaction
        .select({
          blockedAt: telegramIngestTasks.blockedAt,
          id: telegramIngestTasks.id,
          processedAt: telegramIngestTasks.processedAt,
          skippedAt: telegramIngestTasks.skippedAt,
        })
        .from(telegramIngestTasks)
        .where(eq(telegramIngestTasks.id, id))
        .limit(1)
        .for('update');
      if (!task) {
        throw new AdminOperationNotFoundError('Blocked task was not found');
      }
      if (task.processedAt || task.skippedAt || !task.blockedAt) {
        throw new AdminOperationConflictError('Task is no longer blocked');
      }

      const now = new Date();
      await transaction
        .update(telegramIngestTasks)
        .set({
          skippedAt: now,
          skipReason: reason,
          updatedAt: now,
        })
        .where(eq(telegramIngestTasks.id, id));
      await transaction.insert(operationAuditEvents).values({
        ...auditActor(principal),
        action: 'task.skip',
        details: {},
        reason,
        targetId: id,
        targetType: 'task',
      });
    });
  }

  async setChannelEnabled(
    telegramChatId: bigint,
    enabled: boolean,
    principal: AdminPrincipal,
  ): Promise<ConfiguredTelegramChannel> {
    return this.database.transaction(async (transaction) => {
      const [channel] = await transaction
        .select()
        .from(telegramChannelAllowlist)
        .where(eq(telegramChannelAllowlist.telegramChatId, telegramChatId))
        .limit(1)
        .for('update');
      if (!channel) {
        throw new AdminOperationNotFoundError('Configured channel was not found');
      }
      if (channel.enabled === enabled) {
        return {
          disabledAt: channel.disabledAt?.toISOString() ?? null,
          enabled: channel.enabled,
          telegramChatId: channel.telegramChatId.toString(),
          title: channel.title,
          username: channel.username,
        };
      }

      const now = new Date();
      const [updated] = await transaction
        .update(telegramChannelAllowlist)
        .set({
          disabledAt: enabled ? null : now,
          enabled,
          updatedAt: now,
        })
        .where(eq(telegramChannelAllowlist.telegramChatId, telegramChatId))
        .returning();
      if (!updated) {
        throw new Error('Failed to update configured channel');
      }
      await transaction.insert(operationAuditEvents).values({
        ...auditActor(principal),
        action: enabled ? 'channel.enable' : 'channel.disable',
        details: {},
        targetId: telegramChatId.toString(),
        targetType: 'channel',
      });

      return {
        disabledAt: updated.disabledAt?.toISOString() ?? null,
        enabled: updated.enabled,
        telegramChatId: updated.telegramChatId.toString(),
        title: updated.title,
        username: updated.username,
      };
    });
  }

  async rerenderOutdated(principal: AdminPrincipal): Promise<RerenderResult> {
    return this.database.transaction(async (transaction) => {
      const revisions = await transaction
        .select({
          entities: messageRevisions.entities,
          id: messageRevisions.id,
          text: messageRevisions.text,
        })
        .from(messageRevisions)
        .where(lt(messageRevisions.rendererVersion, CURRENT_RENDERER_VERSION))
        .orderBy(asc(messageRevisions.id))
        .limit(500)
        .for('update', { skipLocked: true });

      for (const revision of revisions) {
        await transaction
          .update(messageRevisions)
          .set({
            html:
              revision.text === null
                ? null
                : renderTelegramMessage(revision.text, revision.entities),
            rendererVersion: CURRENT_RENDERER_VERSION,
          })
          .where(eq(messageRevisions.id, revision.id));
      }

      const [remaining] = await transaction
        .select({ id: messageRevisions.id })
        .from(messageRevisions)
        .where(lt(messageRevisions.rendererVersion, CURRENT_RENDERER_VERSION))
        .limit(1);
      await transaction.insert(operationAuditEvents).values({
        ...auditActor(principal),
        action: 'content.rerender',
        details: {
          rendererVersion: CURRENT_RENDERER_VERSION,
          updated: revisions.length,
        },
        targetId: String(CURRENT_RENDERER_VERSION),
        targetType: 'renderer',
      });

      return {
        currentVersion: CURRENT_RENDERER_VERSION,
        hasMore: remaining !== undefined,
        updated: revisions.length,
      };
    });
  }
}
