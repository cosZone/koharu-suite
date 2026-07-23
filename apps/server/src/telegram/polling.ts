import { Bot, type PollingOptions } from 'grammy';
import type { Update } from 'grammy/types';

export type TelegramUpdateHandler = (update: Update) => Promise<void>;

export interface TelegramPolling {
  isRunning(): boolean;
  start(handler: TelegramUpdateHandler): Promise<void>;
  stop(): Promise<void>;
}

export const TELEGRAM_POLLING_OPTIONS = {
  allowed_updates: ['channel_post'],
  limit: 1,
  timeout: 30,
} as const satisfies PollingOptions;

export class GrammyTelegramPolling implements TelegramPolling {
  private readonly bot: Bot;
  private started = false;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  isRunning(): boolean {
    return this.bot.isRunning();
  }

  start(handler: TelegramUpdateHandler): Promise<void> {
    if (this.started) {
      throw new Error('Telegram polling can only be started once');
    }
    this.started = true;

    this.bot.on('channel_post', (context) => handler(context.update));
    this.bot.catch((error) => {
      throw error;
    });

    return this.bot.start(TELEGRAM_POLLING_OPTIONS);
  }

  stop(): Promise<void> {
    return this.bot.stop();
  }
}
