import { GrammyError } from 'grammy';
import type { TelegramApi } from './api.js';
import type { TelegramChannelService } from './channel-service.js';
export interface TelegramInbox {
  assertPollerLock(): Promise<void>;
  bindBot(botId: bigint): Promise<bigint | null>;
  checkpointBatch(
    botId: bigint,
    requestedOffset: bigint | null,
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
  onTelegramSuccess?: () => Promise<void>;
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
  private botId: bigint | undefined;
  private initialized = false;
  private lifetime: Promise<void> | undefined;
  private offset: bigint | null = null;
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly options: TelegramPollerOptions) {}

  get done(): Promise<void> {
    return this.lifetime ?? Promise.resolve();
  }

  async authenticate(): Promise<void> {
    if (this.botId !== undefined || this.initialized || this.lifetime) {
      throw new Error('Telegram poller can only authenticate once');
    }
    const signal = this.abortController.signal;
    const bot = await this.requestWithRetry(() => this.options.api.getMe(signal), signal);
    if (!bot || signal.aborted) {
      throw new Error('Telegram poller stopped during initialization');
    }
    await this.options.inbox.assertPollerLock();
    this.botId = BigInt(bot.id);
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.lifetime) {
      throw new Error('Telegram poller can only be initialized once');
    }
    if (this.botId === undefined) {
      throw new Error('Telegram poller must authenticate before it is initialized');
    }
    this.offset = await this.options.inbox.bindBot(this.botId);
    await this.options.channels.bootstrapLegacy(this.options.legacyChannelId);
    this.initialized = true;
  }

  start(): Promise<void> {
    if (this.lifetime) {
      throw new Error('Telegram poller can only be started once');
    }
    if (!this.initialized) {
      throw new Error('Telegram poller must be initialized before it is started');
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
    if (this.botId === undefined) {
      throw new Error('Telegram poller does not have an initialized Bot identity');
    }
    const botId = this.botId;

    while (!signal.aborted) {
      await this.options.inbox.assertPollerLock();
      const requestedOffset = this.offset;
      const request =
        requestedOffset === null
          ? TELEGRAM_POLLING_OPTIONS
          : { ...TELEGRAM_POLLING_OPTIONS, offset: Number(requestedOffset) };
      const updates = await this.requestWithRetry(
        () => this.options.api.getUpdates(request, signal),
        signal,
      );
      if (!updates || signal.aborted) {
        return;
      }
      await this.options.onTelegramSuccess?.();
      await this.options.inbox.assertPollerLock();
      this.offset = await this.options.inbox.checkpointBatch(botId, requestedOffset, updates);
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
