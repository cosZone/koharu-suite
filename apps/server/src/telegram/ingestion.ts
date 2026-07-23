import type { TelegramPoller } from './polling.js';
import type { TelegramWorkerPool } from './worker.js';

export interface RuntimeIngestion {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export class TelegramIngestionRuntime implements RuntimeIngestion {
  private readonly lifetime: Promise<void>;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly poller: TelegramPoller,
    private readonly workers: TelegramWorkerPool,
  ) {
    this.workers.start();
    this.poller.start();
    this.lifetime = Promise.race([this.poller.done, this.workers.done]);
  }

  get done(): Promise<void> {
    return this.lifetime;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    let firstError: unknown;
    for (const operation of [() => this.poller.stop(), () => this.workers.stop()]) {
      try {
        await operation();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) {
      throw firstError;
    }
  }
}
