import type { MessageWriter } from '../messages/repository.js';
import { normalizeChannelPost } from './normalize.js';
import type { TelegramPolling } from './polling.js';

export interface TelegramCollectorOptions {
  allowedChannelId: bigint;
  polling: TelegramPolling;
  writer: MessageWriter;
}

export class TelegramCollector {
  private handling = false;
  private lifetime: Promise<void> | undefined;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly options: TelegramCollectorOptions) {}

  get done(): Promise<void> {
    return this.lifetime ?? Promise.resolve();
  }

  start(): Promise<void> {
    if (this.lifetime) {
      throw new Error('Telegram collector can only be started once');
    }

    this.lifetime = this.options.polling.start(async (update) => {
      this.handling = true;
      try {
        const post = normalizeChannelPost(update, this.options.allowedChannelId);
        if (post) {
          await this.options.writer.ingest(post);
        }

        if (this.stopping && this.options.polling.isRunning()) {
          await this.options.polling.stop();
        }
      } finally {
        this.handling = false;
      }
    });

    return this.lifetime;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.stopping = true;

    if (!this.handling && this.options.polling.isRunning()) {
      await this.options.polling.stop();
    }

    await this.done;
  }
}
