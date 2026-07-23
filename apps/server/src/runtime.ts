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
import { GrammyTelegramApi } from './telegram/api.js';
import { TelegramChannelService } from './telegram/channel-service.js';
import { TelegramInboxRepository } from './telegram/inbox-repository.js';
import { type RuntimeIngestion, TelegramIngestionRuntime } from './telegram/ingestion.js';
import { TelegramPoller } from './telegram/polling.js';
import { TelegramWorkerPool } from './telegram/worker.js';

export interface ApplicationRuntimeConfig {
  auth: AuthConfig;
  databaseUrl: string;
  port: number;
  telegramBotToken: string;
  telegramLegacyChannelId: bigint | undefined;
  telegramWorkerConcurrency: number;
}

const defaultAdminAssetsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../admin/dist');

export class ApplicationRuntime {
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly ingestion: RuntimeIngestion,
    private readonly closeHttp: () => Promise<void>,
    private readonly closePollingDatabase: () => Promise<void>,
    private readonly closeMainDatabase: () => Promise<void>,
  ) {}

  get done(): Promise<void> {
    return this.ingestion.done;
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

    await run(() => this.ingestion.stop());
    await run(this.closeHttp);
    await run(this.closePollingDatabase);
    await run(this.closeMainDatabase);

    if (firstError) {
      throw firstError;
    }
  }
}

export function startApplication(config: ApplicationRuntimeConfig): ApplicationRuntime {
  const mainConnection = createDatabaseConnection(config.databaseUrl);
  const pollingConnection = createDatabaseConnection(config.databaseUrl, { max: 1 });
  const repository = new PostgresMessageRepository(mainConnection.db);
  const api = new GrammyTelegramApi(config.telegramBotToken);
  const poller = new TelegramPoller({
    api,
    channels: new TelegramChannelService(mainConnection.db, api),
    inbox: new TelegramInboxRepository(pollingConnection.db),
    legacyChannelId: config.telegramLegacyChannelId,
  });
  const workers = new TelegramWorkerPool(
    mainConnection.db,
    repository,
    config.telegramWorkerConcurrency,
  );
  const app = createApp({
    admin: new PostgresAdminRepository(mainConnection.db),
    adminAssetsRoot: process.env.ADMIN_ASSETS_ROOT ?? defaultAdminAssetsRoot,
    auth: new BetterAuthRuntime(mainConnection.db, config.auth),
    collectorState: () => 'running',
    messages: repository,
    owners: new PostgresOwnerRepository(mainConnection.db),
  });
  const server = startServer(app, config.port);
  const ingestion = new TelegramIngestionRuntime(poller, workers);

  return new ApplicationRuntime(
    ingestion,
    () => closeServer(server),
    pollingConnection.close,
    mainConnection.close,
  );
}
