import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresAdminRepository } from './admin/repository.js';
import { createApp } from './app.js';
import { PostgresOwnerRepository } from './auth/owner-service.js';
import { BetterAuthRuntime } from './auth/runtime-auth.js';
import type { AuthConfig } from './config.js';
import { createDatabaseConnection } from './db/client.js';
import { PostgresMessageRepository } from './messages/repository.js';
import { closeServer, startServer } from './server.js';
import { TelegramCollector } from './telegram/collector.js';
import { GrammyTelegramPolling } from './telegram/polling.js';

export interface ApplicationRuntimeConfig {
  auth: AuthConfig;
  databaseUrl: string;
  port: number;
  telegramBotToken: string;
  telegramChannelId: bigint;
}

const defaultAdminAssetsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../admin/dist');

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
  const collector = new TelegramCollector({
    allowedChannelId: config.telegramChannelId,
    polling: new GrammyTelegramPolling(config.telegramBotToken),
    writer: repository,
  });
  const app = createApp({
    admin: new PostgresAdminRepository(connection.db),
    adminAssetsRoot: process.env.ADMIN_ASSETS_ROOT ?? defaultAdminAssetsRoot,
    auth: new BetterAuthRuntime(connection.db, config.auth),
    collectorState: () => 'running',
    messages: repository,
    owners: new PostgresOwnerRepository(connection.db),
  });
  const server = startServer(app, config.port);

  collector.start();

  return new ApplicationRuntime(collector, () => closeServer(server), connection.close);
}
