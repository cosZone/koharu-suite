import { createApp } from './app.js';
import { createDatabaseConnection } from './db/client.js';
import { PostgresMessageRepository } from './messages/repository.js';
import { closeServer, startServer } from './server.js';
import { TelegramCollector } from './telegram/collector.js';
import { GrammyTelegramPolling } from './telegram/polling.js';

export interface ApplicationRuntimeConfig {
  databaseUrl: string;
  port: number;
  telegramBotToken: string;
  telegramChannelId: bigint;
}

export interface RuntimeCollector {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export class ApplicationRuntime {
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly collector: RuntimeCollector,
    private readonly closeHttp: () => Promise<void>,
    private readonly closeDatabase: () => Promise<void>,
  ) {}

  get done(): Promise<void> {
    return this.collector.done;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    let firstError: unknown;
    const run = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        firstError ??= error;
      }
    };

    await run(() => this.collector.stop());
    await run(this.closeHttp);
    await run(this.closeDatabase);

    if (firstError) {
      throw firstError;
    }
  }
}

export function startApplication(config: ApplicationRuntimeConfig): ApplicationRuntime {
  const connection = createDatabaseConnection(config.databaseUrl);
  const repository = new PostgresMessageRepository(connection.db);
  const app = createApp({ messages: repository });
  const server = startServer(app, config.port);
  const collector = new TelegramCollector({
    allowedChannelId: config.telegramChannelId,
    polling: new GrammyTelegramPolling(config.telegramBotToken),
    writer: repository,
  });

  collector.start();

  return new ApplicationRuntime(collector, () => closeServer(server), connection.close);
}
