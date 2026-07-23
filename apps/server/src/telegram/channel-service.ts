import { asc, count, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { telegramChannelAllowlist } from '../db/schema.js';
import type { TelegramApi } from './api.js';
import { telegramIdAsNumber } from './api.js';

export interface ConfiguredChannel {
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

    const now = new Date();
    const [channel] = await this.database
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
        telegramChatId: telegramChannelAllowlist.telegramChatId,
        title: telegramChannelAllowlist.title,
        username: telegramChannelAllowlist.username,
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
