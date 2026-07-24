import {
  AbortController as GrammyAbortController,
  type AbortSignal as GrammyAbortSignal,
} from 'abort-controller';
import { Api } from 'grammy';
import type { ChatFullInfo, ChatMember, File, Update, UserFromGetMe } from 'grammy/types';

export interface TelegramFileApi {
  getFile(fileId: string, signal?: AbortSignal): Promise<File>;
}

export interface GrammyTelegramGetFileClient {
  getFile(fileId: string, signal?: GrammyAbortSignal): Promise<File>;
}

export interface TelegramApi {
  getFile?: TelegramFileApi['getFile'];
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

export class GrammyTelegramApi implements TelegramApi, TelegramFileApi {
  private readonly api: Api;
  private readonly getFileClient: GrammyTelegramGetFileClient;

  constructor(
    token: string,
    options: { apiRoot?: string; getFileClient?: GrammyTelegramGetFileClient } = {},
  ) {
    this.api = new Api(token, options.apiRoot === undefined ? {} : { apiRoot: options.apiRoot });
    this.getFileClient = options.getFileClient ?? this.api;
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

  async getFile(fileId: string, signal?: AbortSignal): Promise<File> {
    signal?.throwIfAborted();
    if (signal === undefined) {
      return this.getFileClient.getFile(fileId);
    }

    const controller = new GrammyAbortController();
    const abort = () => {
      controller.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
    }

    try {
      return await this.getFileClient.getFile(fileId, controller.signal);
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
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
