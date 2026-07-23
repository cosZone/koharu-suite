import { GrammyError } from 'grammy';
import type { TelegramApi } from './api.js';
import type { TelegramChannelService } from './channel-service.js';
export interface TelegramInbox {
  acquirePollerLock(): Promise<void>;
  bindBot(botId: bigint): Promise<bigint | null>;
  checkpointBatch(
    botId: bigint,
    updates: Awaited<ReturnType<TelegramApi['getUpdates']>>,
  ): Promise<bigint | null>;
}

export const TELEGRAM_POLLING_OPTIONS = {
  allowed_updates: ['channel_post', 'edited_channel_post'],
  limit: 100,
  timeout: 30,
} as const;

export interface TelegramPollerOptions {
  api: TelegramApi;
  channels: Pick<TelegramChannelService, 'bootstrapLegacy'>;
  inbox: TelegramInbox;
  legacyChannelId: bigint | undefined;
  retryDelay?: (attempt: number, signal: AbortSignal) => Promise<void>;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function defaultRetryDelay(attempt: number, signal: AbortSignal): Promise<void> {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  const jittered = Math.round(base * (0.8 + Math.random() * 0.4));
  return abortableDelay(jittered, signal);
}

export class TelegramPoller {
  private readonly abortController = new AbortController();
  private lifetime: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly options: TelegramPollerOptions) {}

  get done(): Promise<void> {
    return this.lifetime ?? Promise.resolve();
  }

  start(): Promise<void> {
    if (this.lifetime) {
      throw new Error('Telegram poller can only be started once');
    }
    this.lifetime = this.run();
    return this.lifetime;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async run(): Promise<void> {
    const signal = this.abortController.signal;
    const bot = await this.requestWithRetry(() => this.options.api.getMe(signal), signal);
    if (!bot) {
      return;
    }
    const botId = BigInt(bot.id);
    await this.options.inbox.acquirePollerLock();
    let offset = await this.options.inbox.bindBot(botId);
    await this.options.channels.bootstrapLegacy(this.options.legacyChannelId);

    while (!signal.aborted) {
      const request =
        offset === null
          ? TELEGRAM_POLLING_OPTIONS
          : { ...TELEGRAM_POLLING_OPTIONS, offset: Number(offset) };
      const updates = await this.requestWithRetry(
        () => this.options.api.getUpdates(request, signal),
        signal,
      );
      if (!updates || signal.aborted) {
        return;
      }
      offset = await this.options.inbox.checkpointBatch(botId, updates);
    }
  }

  private async requestWithRetry<Result>(
    operation: () => Promise<Result>,
    signal: AbortSignal,
  ): Promise<Result | null> {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        return await operation();
      } catch (error) {
        if (signal.aborted) {
          return null;
        }
        if (error instanceof GrammyError && error.error_code !== 429 && error.error_code < 500) {
          throw error;
        }
        attempt += 1;
        try {
          await (this.options.retryDelay ?? defaultRetryDelay)(attempt, signal);
        } catch (delayError) {
          if (signal.aborted) {
            return null;
          }
          throw delayError;
        }
      }
    }
    return null;
  }

  private async stopOnce(): Promise<void> {
    this.abortController.abort(new Error('Telegram poller stopped'));
    await this.done;
  }
}
