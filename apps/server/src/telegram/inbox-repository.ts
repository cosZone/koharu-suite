import { eq, inArray, sql } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import type { Database } from '../db/client.js';
import {
  telegramChannelAllowlist,
  telegramIngestTasks,
  telegramPollingState,
} from '../db/schema.js';

const POLLER_ADVISORY_LOCK = 5_832_943_008_958_395;

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

  async acquirePollerLock(): Promise<void> {
    const rows = await this.database.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_lock(${POLLER_ADVISORY_LOCK}) as acquired`,
    );
    if (!rows[0]?.acquired) {
      throw new Error('Another Telegram poller already owns this database');
    }
  }

  async bindBot(botId: bigint): Promise<bigint | null> {
    return this.database.transaction(async (transaction) => {
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
              .where(inArray(telegramChannelAllowlist.telegramChatId, chatIds));
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
