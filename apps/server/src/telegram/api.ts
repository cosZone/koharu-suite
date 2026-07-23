import { Api } from 'grammy';
import type { ChatFullInfo, ChatMember, Update, UserFromGetMe } from 'grammy/types';

export interface TelegramApi {
  getChat(chatId: number | string, signal?: AbortSignal): Promise<ChatFullInfo>;
  getChatMember(chatId: number | string, userId: number, signal?: AbortSignal): Promise<ChatMember>;
  getMe(signal?: AbortSignal): Promise<UserFromGetMe>;
  getUpdates(
    options: {
      allowed_updates: ReadonlyArray<'channel_post' | 'edited_channel_post'>;
      limit: number;
      offset?: number;
      timeout: number;
    },
    signal?: AbortSignal,
  ): Promise<Update[]>;
}

export class GrammyTelegramApi implements TelegramApi {
  private readonly api: Api;

  constructor(token: string) {
    this.api = new Api(token);
  }

  getChat(chatId: number | string, signal?: AbortSignal): Promise<ChatFullInfo> {
    return this.api.getChat(chatId, signal as Parameters<Api['getChat']>[1]);
  }

  getChatMember(
    chatId: number | string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<ChatMember> {
    return this.api.getChatMember(chatId, userId, signal as Parameters<Api['getChatMember']>[2]);
  }

  getMe(signal?: AbortSignal): Promise<UserFromGetMe> {
    return this.api.getMe(signal as Parameters<Api['getMe']>[0]);
  }

  getUpdates(
    options: {
      allowed_updates: ReadonlyArray<'channel_post' | 'edited_channel_post'>;
      limit: number;
      offset?: number;
      timeout: number;
    },
    signal?: AbortSignal,
  ): Promise<Update[]> {
    return this.api.getUpdates(options, signal as Parameters<Api['getUpdates']>[1]);
  }
}

export function telegramIdAsNumber(id: bigint): number {
  const value = Number(id);
  if (!Number.isSafeInteger(value)) {
    throw new Error('Telegram ID is outside the JavaScript safe integer range');
  }
  return value;
}
