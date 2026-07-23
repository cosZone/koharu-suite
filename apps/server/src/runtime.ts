import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { PostgresAdminOperations } from './admin/operations.js';
import { PostgresAdminRepository } from './admin/repository.js';
import { createApp } from './app.js';
import { BetterAuthRuntime } from './auth/runtime-auth.js';
import type { AuthConfig, PublicApiConfig, TelegramConfig } from './config.js';
import { createDatabaseConnection } from './db/client.js';
import { PostgresMessageRepository } from './messages/repository.js';
import { closeServer, startServer } from './server.js';
import { GrammyTelegramApi } from './telegram/api.js';
import { TelegramChannelService } from './telegram/channel-service.js';
import { ReservedTelegramInboxRepository } from './telegram/inbox-repository.js';
import { TelegramPoller } from './telegram/polling.js';
import { TelegramWorkerPool } from './telegram/worker.js';
import { VERSION } from './version.js';
import {
  PostgresWorkerRuntimeRepository,
  WORKER_HEARTBEAT_INTERVAL_MS,
} from './worker-runtime-repository.js';

export interface StoppableRuntime {
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export interface ServerRuntimeConfig {
  auth: AuthConfig;
  databaseUrl: string;
  port: number;
  publicApi: PublicApiConfig;
}

export interface WorkerRuntimeConfig extends TelegramConfig {
  databaseUrl: string;
  instanceId: string;
}

interface RuntimePoller {
  readonly done: Promise<void>;
  authenticate(): Promise<void>;
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface RuntimeWorkerPool {
  readonly done: Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface RuntimeInbox {
  acquirePollerLock(): Promise<void>;
  close(): Promise<void>;
}

interface RuntimeHeartbeat {
  claim(instanceId: string, version: string): Promise<void>;
  heartbeat(instanceId: string): Promise<void>;
  markRunning(instanceId: string): Promise<void>;
  markStopping(instanceId: string): Promise<boolean>;
}

export interface WorkerRuntimeDependencies {
  closeMainDatabase(): Promise<void>;
  heartbeat: RuntimeHeartbeat;
  inbox: RuntimeInbox;
  poller: RuntimePoller;
  workers: RuntimeWorkerPool;
}

const defaultAdminAssetsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../admin/dist');

function deferred(): {
  promise: Promise<void>;
  reject: (reason: unknown) => void;
  resolve: () => void;
} {
  let rejectPromise!: (reason: unknown) => void;
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  };
}

async function runAll(operations: Array<() => Promise<void>>): Promise<void> {
  let firstError: unknown;
  for (const operation of operations) {
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

export class ServerRuntime implements StoppableRuntime {
  private stopPromise: Promise<void> | undefined;

  constructor(
    readonly done: Promise<void>,
    private readonly closeHttp: () => Promise<void>,
    private readonly closeDatabase: () => Promise<void>,
  ) {}

  stop(): Promise<void> {
    this.stopPromise ??= runAll([this.closeHttp, this.closeDatabase]);
    return this.stopPromise;
  }
}

export class WorkerRuntime implements StoppableRuntime {
  private readonly completion = deferred();
  private heartbeatClaimed = false;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private settled = false;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly instanceId: string,
    private readonly dependencies: WorkerRuntimeDependencies,
    private readonly heartbeatIntervalMs = WORKER_HEARTBEAT_INTERVAL_MS,
  ) {}

  get done(): Promise<void> {
    return this.completion.promise;
  }

  start(): Promise<void> {
    this.startPromise ??= this.startOnce();
    return this.startPromise;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async startOnce(): Promise<void> {
    try {
      await this.dependencies.inbox.acquirePollerLock();
      if (this.stopping) {
        throw new Error('Worker stopped during startup');
      }
      await this.dependencies.poller.authenticate();
      if (this.stopping) {
        throw new Error('Worker stopped during startup');
      }
      await this.dependencies.heartbeat.claim(this.instanceId, VERSION);
      this.heartbeatClaimed = true;
      await this.dependencies.poller.initialize();
      if (this.stopping) {
        throw new Error('Worker stopped during startup');
      }
      const pollerLifetime = this.dependencies.poller.start();
      const workerLifetime = this.dependencies.workers.start();
      this.monitorLifetime(pollerLifetime, workerLifetime);
      await this.dependencies.heartbeat.markRunning(this.instanceId);
      this.scheduleHeartbeat();
    } catch (error) {
      this.rejectDone(error);
      try {
        await this.stop();
      } catch {
        // Preserve the startup failure as the actionable process error.
      }
      throw error;
    }
  }

  private monitorLifetime(pollerLifetime: Promise<void>, workerLifetime: Promise<void>): void {
    void Promise.race([pollerLifetime, workerLifetime]).then(
      () => {
        if (!this.stopping) {
          const error = new Error('Telegram worker runtime stopped unexpectedly');
          this.rejectDone(error);
          void this.stop().catch(() => {});
        }
      },
      (error: unknown) => {
        this.rejectDone(error);
        void this.stop().catch(() => {});
      },
    );
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      void this.dependencies.heartbeat
        .heartbeat(this.instanceId)
        .then(() => {
          if (!this.stopping) {
            this.scheduleHeartbeat();
          }
        })
        .catch((error: unknown) => {
          this.rejectDone(error);
          void this.stop().catch(() => {});
        });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private async stopOnce(): Promise<void> {
    this.stopping = true;
    let heartbeatError: unknown;
    if (this.heartbeatClaimed) {
      try {
        await this.dependencies.heartbeat.markStopping(this.instanceId);
      } catch (error) {
        heartbeatError = error;
      }
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    try {
      await runAll([
        () => this.dependencies.poller.stop(),
        () => this.dependencies.workers.stop(),
        () => this.dependencies.inbox.close(),
        this.dependencies.closeMainDatabase,
      ]);
      if (heartbeatError) {
        throw heartbeatError;
      }
      this.resolveDone();
    } catch (error) {
      this.rejectDone(error);
      throw error;
    }
  }

  private rejectDone(error: unknown): void {
    if (!this.settled) {
      this.settled = true;
      this.completion.reject(error);
    }
  }

  private resolveDone(): void {
    if (!this.settled) {
      this.settled = true;
      this.completion.resolve();
    }
  }
}

export function startServerRuntime(config: ServerRuntimeConfig): ServerRuntime {
  const mainConnection = createDatabaseConnection(config.databaseUrl);
  const repository = new PostgresMessageRepository(mainConnection.db);
  const app = createApp({
    admin: new PostgresAdminRepository(mainConnection.db),
    adminAssetsRoot: process.env.ADMIN_ASSETS_ROOT ?? defaultAdminAssetsRoot,
    auth: new BetterAuthRuntime(mainConnection.db, config.auth),
    messages: repository,
    operations: new PostgresAdminOperations(mainConnection.db),
    publicApi: config.publicApi,
    readiness: async () => {
      await mainConnection.db.execute(sql`select 1`);
    },
  });
  const server = startServer(app, config.port);
  const done = new Promise<void>((resolveDone, rejectDone) => {
    server.once('close', resolveDone);
    server.once('error', rejectDone);
  });
  return new ServerRuntime(done, () => closeServer(server), mainConnection.close);
}

export function createWorkerRuntime(config: WorkerRuntimeConfig): WorkerRuntime {
  const mainConnection = createDatabaseConnection(config.databaseUrl);
  const repository = new PostgresMessageRepository(mainConnection.db);
  const heartbeat = new PostgresWorkerRuntimeRepository(mainConnection.db);
  const api = new GrammyTelegramApi(config.botToken, {
    ...(config.apiRoot ? { apiRoot: config.apiRoot } : {}),
  });
  const inbox = new ReservedTelegramInboxRepository(config.databaseUrl, mainConnection.db);
  const poller = new TelegramPoller({
    api,
    channels: new TelegramChannelService(mainConnection.db, api),
    inbox,
    legacyChannelId: config.legacyChannelId,
    onTelegramSuccess: () => heartbeat.recordTelegramSuccess(config.instanceId),
  });
  const workers = new TelegramWorkerPool(mainConnection.db, repository, config.workerConcurrency);

  return new WorkerRuntime(config.instanceId, {
    closeMainDatabase: mainConnection.close,
    heartbeat,
    inbox,
    poller,
    workers,
  });
}
