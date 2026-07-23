import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import postgres from 'postgres';
import type { Database } from '../db/client.js';
import {
  telegramChannelAllowlist,
  telegramIngestTasks,
  telegramPollingState,
} from '../db/schema.js';
import { TELEGRAM_BOT_BIND_ADVISORY_LOCK, TELEGRAM_POLLER_ADVISORY_LOCK } from './constants.js';

function channelUpdate(update: Update) {
  if (update.channel_post !== undefined) {
    return {
      chatId: BigInt(update.channel_post.chat.id),
      type: 'channel_post' as const,
    };
  }
  if (update.edited_channel_post !== undefined) {
    return {
      chatId: BigInt(update.edited_channel_post.chat.id),
      type: 'edited_channel_post' as const,
    };
  }
  return null;
}

export class TelegramInboxRepository {
  constructor(private readonly database: Database) {}

  async bindBot(botId: bigint): Promise<bigint | null> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${TELEGRAM_BOT_BIND_ADVISORY_LOCK})`,
      );
      await transaction
        .insert(telegramPollingState)
        .values({ botId })
        .onConflictDoNothing({ target: telegramPollingState.singleton });

      const [state] = await transaction
        .select({
          botId: telegramPollingState.botId,
          nextUpdateId: telegramPollingState.nextUpdateId,
        })
        .from(telegramPollingState)
        .where(eq(telegramPollingState.singleton, 1))
        .limit(1)
        .for('update');

      if (!state) {
        throw new Error('Failed to initialize Telegram polling state');
      }
      if (state.botId !== botId) {
        throw new Error('This database is already bound to a different Telegram Bot');
      }
      return state.nextUpdateId;
    });
  }

  async checkpointBatch(botId: bigint, updates: Update[]): Promise<bigint | null> {
    return this.database.transaction(async (transaction) => {
      const [state] = await transaction
        .select({
          botId: telegramPollingState.botId,
          nextUpdateId: telegramPollingState.nextUpdateId,
        })
        .from(telegramPollingState)
        .where(eq(telegramPollingState.singleton, 1))
        .limit(1)
        .for('update');

      if (!state || state.botId !== botId) {
        throw new Error('Telegram polling state does not match the active Bot');
      }
      if (updates.length === 0) {
        return state.nextUpdateId;
      }

      const candidates = updates.flatMap((update) => {
        const details = channelUpdate(update);
        return details
          ? [
              {
                ...details,
                telegramUpdateId: BigInt(update.update_id),
                update,
              },
            ]
          : [];
      });
      const chatIds = [...new Set(candidates.map((candidate) => candidate.chatId))];
      const allowed =
        chatIds.length === 0
          ? []
          : await transaction
              .select({ telegramChatId: telegramChannelAllowlist.telegramChatId })
              .from(telegramChannelAllowlist)
              .where(
                and(
                  inArray(telegramChannelAllowlist.telegramChatId, chatIds),
                  eq(telegramChannelAllowlist.enabled, true),
                ),
              );
      const allowedIds = new Set(allowed.map((channel) => channel.telegramChatId));
      const accepted = candidates.filter((candidate) => allowedIds.has(candidate.chatId));

      if (accepted.length > 0) {
        await transaction
          .insert(telegramIngestTasks)
          .values(
            accepted.map((candidate) => ({
              botId,
              rawJson: candidate.update,
              telegramChatId: candidate.chatId,
              telegramUpdateId: candidate.telegramUpdateId,
              updateType: candidate.type,
            })),
          )
          .onConflictDoNothing({ target: telegramIngestTasks.telegramUpdateId });
      }

      const batchNext = BigInt(Math.max(...updates.map((update) => update.update_id))) + 1n;
      const nextUpdateId =
        state.nextUpdateId === null || batchNext > state.nextUpdateId
          ? batchNext
          : state.nextUpdateId;
      await transaction
        .update(telegramPollingState)
        .set({ nextUpdateId, updatedAt: new Date() })
        .where(eq(telegramPollingState.singleton, 1));

      return nextUpdateId;
    });
  }
}

export class ReservedTelegramInboxRepository {
  private readonly client;
  private readonly delegate: TelegramInboxRepository;
  private backendPid: number | undefined;
  private reserved: postgres.ReservedSql | undefined;
  private sessionLost = false;

  constructor(databaseUrl: string, database: Database) {
    this.client = postgres(databaseUrl, {
      max: 1,
      max_lifetime: null,
      onclose: () => {
        this.sessionLost = true;
      },
    });
    this.delegate = new TelegramInboxRepository(database);
  }

  async acquirePollerLock(): Promise<void> {
    if (this.reserved) {
      throw new Error('Telegram poller session was already reserved');
    }

    this.sessionLost = false;
    const reserved = await this.client.reserve();
    try {
      const [status] = await reserved<{ acquired: boolean; backendPid: number }[]>`
        select
          pg_try_advisory_lock(${TELEGRAM_POLLER_ADVISORY_LOCK}) as acquired,
          pg_backend_pid() as "backendPid"
      `;
      if (!status?.acquired) {
        throw new Error('Another Telegram poller already owns this database');
      }
      this.backendPid = status.backendPid;
    } catch (error) {
      reserved.release();
      throw error;
    }
    this.reserved = reserved;
  }

  async assertPollerLock(): Promise<void> {
    const reserved = this.reserved;
    const backendPid = this.backendPid;
    if (!reserved || backendPid === undefined) {
      throw new Error('Telegram poller session has not been reserved');
    }
    if (this.sessionLost) {
      throw new Error('Telegram poller database session changed and lost advisory lock ownership');
    }

    try {
      const [status] = await reserved<{ backendPid: number }[]>`
        select pg_backend_pid() as "backendPid"
      `;
      if (this.sessionLost || status?.backendPid !== backendPid) {
        throw new Error('Telegram poller backend identity changed');
      }
    } catch (error) {
      this.sessionLost = true;
      throw new Error('Telegram poller database session changed and lost advisory lock ownership', {
        cause: error,
      });
    }
  }

  async bindBot(botId: bigint): Promise<bigint | null> {
    await this.assertPollerLock();
    return this.delegate.bindBot(botId);
  }

  async checkpointBatch(botId: bigint, updates: Update[]): Promise<bigint | null> {
    await this.assertPollerLock();
    return this.delegate.checkpointBatch(botId, updates);
  }

  async close(): Promise<void> {
    try {
      if (this.reserved && this.backendPid !== undefined && !this.sessionLost) {
        await this.reserved`select pg_advisory_unlock(${TELEGRAM_POLLER_ADVISORY_LOCK})`;
      }
    } catch {
      // The pinned backend may already be gone; closing the client is the fail-closed release.
    }
    this.backendPid = undefined;
    this.sessionLost = true;
    this.reserved?.release();
    this.reserved = undefined;
    await this.client.end({ timeout: 1 });
  }
}
