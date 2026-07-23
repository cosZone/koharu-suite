import { asc, count, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { telegramChannelAllowlist, telegramPollingState } from '../db/schema.js';
import type { TelegramApi } from './api.js';
import { telegramIdAsNumber } from './api.js';
import { TELEGRAM_BOT_BIND_ADVISORY_LOCK } from './constants.js';

export interface ConfiguredChannel {
  disabledAt: Date | null;
  enabled: boolean;
  telegramChatId: bigint;
  title: string;
  username: string | null;
}

export class TelegramChannelService {
  constructor(
    private readonly database: Database,
    private readonly api?: TelegramApi,
  ) {}

  async add(telegramChatId: bigint): Promise<ConfiguredChannel> {
    if (!this.api) {
      throw new Error('Telegram API is required to add a channel');
    }
    const chatId = telegramIdAsNumber(telegramChatId);
    if (telegramChatId >= 0n) {
      throw new Error('Telegram channel ID must be negative');
    }

    const [bot, chat] = await Promise.all([this.api.getMe(), this.api.getChat(chatId)]);
    if (chat.type !== 'channel') {
      throw new Error('Telegram chat must be a channel');
    }
    if (!chat.username) {
      throw new Error('Telegram channel must be public and have a username');
    }

    const membership = await this.api.getChatMember(chatId, bot.id);
    if (membership.status !== 'administrator' && membership.status !== 'creator') {
      throw new Error('Telegram Bot must be an administrator of the channel');
    }

    const channel = await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${TELEGRAM_BOT_BIND_ADVISORY_LOCK})`,
      );
      const botId = BigInt(bot.id);
      await transaction
        .insert(telegramPollingState)
        .values({ botId })
        .onConflictDoNothing({ target: telegramPollingState.singleton });
      const [state] = await transaction
        .select({ botId: telegramPollingState.botId })
        .from(telegramPollingState)
        .where(eq(telegramPollingState.singleton, 1))
        .limit(1)
        .for('update');
      if (!state || state.botId !== botId) {
        throw new Error('This database is already bound to a different Telegram Bot');
      }

      const now = new Date();
      const [configured] = await transaction
        .insert(telegramChannelAllowlist)
        .values({
          telegramChatId,
          title: chat.title,
          username: chat.username,
        })
        .onConflictDoUpdate({
          target: telegramChannelAllowlist.telegramChatId,
          set: {
            title: chat.title,
            updatedAt: now,
            username: chat.username,
          },
        })
        .returning({
          disabledAt: telegramChannelAllowlist.disabledAt,
          enabled: telegramChannelAllowlist.enabled,
          telegramChatId: telegramChannelAllowlist.telegramChatId,
          title: telegramChannelAllowlist.title,
          username: telegramChannelAllowlist.username,
        });
      return configured;
    });
    if (!channel) {
      throw new Error('Failed to configure Telegram channel');
    }
    return channel;
  }

  async bootstrapLegacy(telegramChatId: bigint | undefined): Promise<ConfiguredChannel | null> {
    if (telegramChatId === undefined) {
      return null;
    }

    const [result] = await this.database.select({ value: count() }).from(telegramChannelAllowlist);
    if ((result?.value ?? 0) > 0) {
      return null;
    }

    return this.add(telegramChatId);
  }

  async list(): Promise<ConfiguredChannel[]> {
    const rows = await this.database
      .select({
        disabledAt: telegramChannelAllowlist.disabledAt,
        enabled: telegramChannelAllowlist.enabled,
        telegramChatId: telegramChannelAllowlist.telegramChatId,
        title: telegramChannelAllowlist.title,
        username: telegramChannelAllowlist.username,
      })
      .from(telegramChannelAllowlist)
      .orderBy(asc(telegramChannelAllowlist.title), asc(telegramChannelAllowlist.telegramChatId));

    return rows;
  }

  async contains(telegramChatId: bigint): Promise<boolean> {
    const [row] = await this.database
      .select({ telegramChatId: telegramChannelAllowlist.telegramChatId })
      .from(telegramChannelAllowlist)
      .where(eq(telegramChannelAllowlist.telegramChatId, telegramChatId))
      .limit(1);
    return row !== undefined;
  }
}
