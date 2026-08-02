import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
} from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  messageMedia,
  messageRevisions,
  messageSourceObservations,
  messages,
  telegramChannelAllowlist,
  telegramChannels,
  telegramIngestTasks,
  telegramPollingState,
  telegramUpdates,
} from '../db/schema.js';
import type { MessageCursor } from '../http/cursor.js';
import { CURRENT_RENDERER_VERSION } from '../messages/renderer.js';
import {
  PostgresWorkerRuntimeRepository,
  type WorkerRuntimeStatus,
} from '../worker-runtime-repository.js';

export interface AdminStatusSnapshot {
  collector: WorkerRuntimeStatus;
  counts: {
    activeChannels: number;
    blockedTasks: number;
    configuredChannels: number;
    messages: number;
    pendingTasks: number;
    retryingTasks: number;
    skippedTasks: number;
    staleRendererRevisions: number;
    updates: number;
  };
  lastCheckpoint: string | null;
}

export interface AdminReader {
  getMessage(messageId: string): Promise<AdminMessage | null>;
  getRawUpdate(messageId: string): Promise<unknown | null>;
  getStatus(): Promise<AdminStatusSnapshot>;
  listMessages(
    channelId: string,
    options: AdminMessageListOptions,
  ): Promise<AdminMessagePage | null>;
}

export interface AdminMessage {
  authorSignature: string | null;
  channel: { id: string; title: string; username: string | null };
  content: { html: string | null; kind: 'caption' | 'none' | 'text'; text: string | null };
  id: string;
  media: Array<{ fileName: string | null; kind: string }>;
  publishedAt: string;
  revision: number;
  sourceUrl: string | null;
  tombstoned: boolean;
  updatedAt: string;
}

export type AdminMessageVisibility = 'all' | 'hidden' | 'visible';

export interface AdminMessageListOptions {
  cursor?: MessageCursor;
  limit: number;
  visibility: AdminMessageVisibility;
}

export interface AdminMessagePage {
  items: AdminMessage[];
  nextCursor: MessageCursor | null;
}

async function countRows(
  database: Database,
  table: typeof messages | typeof telegramChannelAllowlist | typeof telegramUpdates,
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
      skippedTasks,
      staleRendererRevisions,
      pollingState,
      collector,
    ] = await Promise.all([
      this.database
        .select({ value: count() })
        .from(telegramChannelAllowlist)
        .where(eq(telegramChannelAllowlist.enabled, true)),
      countRows(this.database, telegramChannelAllowlist),
      countRows(this.database, messages),
      countRows(this.database, telegramUpdates),
      this.taskCount(
        and(
          isNull(telegramIngestTasks.processedAt),
          isNull(telegramIngestTasks.blockedAt),
          isNull(telegramIngestTasks.skippedAt),
          eq(telegramIngestTasks.attemptCount, 0),
        ),
      ),
      this.taskCount(
        and(
          isNull(telegramIngestTasks.processedAt),
          isNull(telegramIngestTasks.blockedAt),
          isNull(telegramIngestTasks.skippedAt),
          gt(telegramIngestTasks.attemptCount, 0),
        ),
      ),
      this.taskCount(
        and(
          isNotNull(telegramIngestTasks.blockedAt),
          isNull(telegramIngestTasks.processedAt),
          isNull(telegramIngestTasks.skippedAt),
        ),
      ),
      this.taskCount(isNotNull(telegramIngestTasks.skippedAt)),
      this.database
        .select({ value: count() })
        .from(messageRevisions)
        .where(lt(messageRevisions.rendererVersion, CURRENT_RENDERER_VERSION)),
      this.database
        .select({
          nextUpdateId: telegramPollingState.nextUpdateId,
          updatedAt: telegramPollingState.updatedAt,
        })
        .from(telegramPollingState)
        .where(eq(telegramPollingState.singleton, 1))
        .limit(1),
      new PostgresWorkerRuntimeRepository(this.database).getStatus(),
    ]);

    const checkpoint = pollingState[0];
    return {
      collector,
      counts: {
        activeChannels: activeChannels[0]?.value ?? 0,
        blockedTasks,
        configuredChannels,
        messages: messageCount,
        pendingTasks,
        retryingTasks,
        skippedTasks,
        staleRendererRevisions: staleRendererRevisions[0]?.value ?? 0,
        updates,
      },
      lastCheckpoint:
        checkpoint?.nextUpdateId === null || checkpoint === undefined
          ? null
          : checkpoint.updatedAt.toISOString(),
    };
  }

  async getRawUpdate(messageId: string): Promise<unknown | null> {
    const [row] = await this.database
      .select({ update: messageSourceObservations.rawJson })
      .from(messages)
      .innerJoin(
        messageRevisions,
        and(
          eq(messageRevisions.messageId, messages.id),
          eq(messageRevisions.revisionNumber, messages.currentRevisionNumber),
        ),
      )
      .innerJoin(
        messageSourceObservations,
        eq(messageSourceObservations.revisionId, messageRevisions.id),
      )
      .where(eq(messages.id, messageId))
      .orderBy(desc(messageSourceObservations.createdAt), desc(messageSourceObservations.id))
      .limit(1);

    return row?.update ?? null;
  }

  async getMessage(messageId: string): Promise<AdminMessage | null> {
    return (await this.projectMessages(eq(messages.id, messageId), 1))[0] ?? null;
  }

  async listMessages(
    channelId: string,
    options: AdminMessageListOptions,
  ): Promise<AdminMessagePage | null> {
    const [channel] = await this.database
      .select({ id: telegramChannels.id })
      .from(telegramChannels)
      .where(eq(telegramChannels.id, channelId))
      .limit(1);
    if (!channel) return null;

    const cursorWhere = options.cursor
      ? or(
          lt(messages.publishedAt, new Date(options.cursor.publishedAt)),
          and(
            eq(messages.publishedAt, new Date(options.cursor.publishedAt)),
            lt(messages.id, options.cursor.messageId),
          ),
        )
      : undefined;
    const visibilityWhere =
      options.visibility === 'hidden'
        ? isNotNull(messages.tombstonedAt)
        : options.visibility === 'visible'
          ? isNull(messages.tombstonedAt)
          : undefined;
    const items = await this.projectMessages(
      and(eq(messages.channelId, channelId), visibilityWhere, cursorWhere),
      options.limit + 1,
    );
    const hasMore = items.length > options.limit;
    const pageItems = items.slice(0, options.limit);
    const last = pageItems.at(-1);
    return {
      items: pageItems,
      nextCursor:
        hasMore && last
          ? {
              channelId,
              messageId: last.id,
              publishedAt: last.publishedAt,
            }
          : null,
    };
  }

  private async projectMessages(where: SQL | undefined, limit: number): Promise<AdminMessage[]> {
    const rows = await this.database
      .select({
        authorSignature: messageRevisions.authorSignature,
        channelId: telegramChannels.id,
        channelTitle: telegramChannels.title,
        channelUsername: telegramChannels.username,
        contentKind: messageRevisions.contentKind,
        html: messageRevisions.html,
        messageId: messages.id,
        publishedAt: messages.publishedAt,
        revisionId: messageRevisions.id,
        revisionNumber: messageRevisions.revisionNumber,
        telegramMessageId: messages.telegramMessageId,
        text: messageRevisions.text,
        tombstonedAt: messages.tombstonedAt,
        updatedAt: messages.updatedAt,
      })
      .from(messages)
      .innerJoin(telegramChannels, eq(telegramChannels.id, messages.channelId))
      .innerJoin(
        messageRevisions,
        and(
          eq(messageRevisions.messageId, messages.id),
          eq(messageRevisions.revisionNumber, messages.currentRevisionNumber),
        ),
      )
      .where(where)
      .orderBy(desc(messages.publishedAt), desc(messages.id))
      .limit(limit);
    if (rows.length === 0) return [];

    const mediaRows = await this.database
      .select({
        fileName: messageMedia.fileName,
        kind: messageMedia.kind,
        revisionId: messageMedia.revisionId,
      })
      .from(messageMedia)
      .where(
        inArray(
          messageMedia.revisionId,
          rows.map((row) => row.revisionId),
        ),
      )
      .orderBy(asc(messageMedia.position));
    const mediaByRevision = new Map<string, Array<{ fileName: string | null; kind: string }>>();
    for (const media of mediaRows) {
      const items = mediaByRevision.get(media.revisionId) ?? [];
      items.push({ fileName: media.fileName, kind: media.kind });
      mediaByRevision.set(media.revisionId, items);
    }

    return rows.map((row) => ({
      authorSignature: row.authorSignature,
      channel: {
        id: row.channelId,
        title: row.channelTitle,
        username: row.channelUsername,
      },
      content: { html: row.html, kind: row.contentKind, text: row.text },
      id: row.messageId,
      media: mediaByRevision.get(row.revisionId) ?? [],
      publishedAt: row.publishedAt.toISOString(),
      revision: row.revisionNumber,
      sourceUrl: row.channelUsername
        ? `https://t.me/${row.channelUsername}/${row.telegramMessageId}`
        : null,
      tombstoned: row.tombstonedAt !== null,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private async taskCount(where: ReturnType<typeof and> | ReturnType<typeof isNotNull>) {
    const [result] = await this.database
      .select({ value: count() })
      .from(telegramIngestTasks)
      .where(where);
    return result?.value ?? 0;
  }
}
