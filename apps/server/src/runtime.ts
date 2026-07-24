import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { PostgresAdminOperations } from './admin/operations.js';
import { PostgresAdminRepository } from './admin/repository.js';
import { createApp } from './app.js';
import { BetterAuthRuntime } from './auth/runtime-auth.js';
import type { AuthConfig, MediaCacheConfig, PublicApiConfig, TelegramConfig } from './config.js';
import { createDatabaseConnection } from './db/client.js';
import { MediaCacheAccessCoalescer } from './media-cache/access-coalescer.js';
import { PostgresMediaCacheAdminRepository } from './media-cache/admin-repository.js';
import { PostgresMediaCacheAdminService } from './media-cache/admin-service.js';
import { LocalMediaBlobStore } from './media-cache/blob-store.js';
import { createPostgresMediaCacheAccessWriter } from './media-cache/eviction-repository.js';
import {
  LocalPublicMediaReader,
  PostgresPublicMediaObjectRepository,
} from './media-cache/public-reader.js';
import { createMediaCacheWorkerRuntime } from './media-cache/runtime.js';
import { PostgresMessageRepository } from './messages/repository.js';
import { PostgresReconciliationPersistenceRepository } from './reconciliation/persistence-repository.js';
import { DeterministicRepairService } from './reconciliation/repair.js';
import { PostgresDeterministicRepairRepository } from './reconciliation/repair-repository.js';
import { PostgresReconciliationScheduleRepository } from './reconciliation/schedule-repository.js';
import { ScheduledReconciliationRunner } from './reconciliation/scheduled-runner.js';
import { MessageTombstoneService } from './reconciliation/tombstone.js';
import { PostgresMessageTombstoneRepository } from './reconciliation/tombstone-repository.js';
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
  mediaCache: MediaCacheConfig;
  port: number;
  publicApi: PublicApiConfig;
}

export interface WorkerRuntimeConfig extends TelegramConfig {
  databaseUrl: string;
  instanceId: string;
  mediaCache: MediaCacheConfig;
}

interface RuntimePoller {
  readonly done: Promise<void>;
  authenticate(): Promise<void>;
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeWorkerPool {
  readonly done: Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface RuntimeMediaCacheWorker extends RuntimeWorkerPool {
  initialize(): Promise<void>;
}

interface RuntimeMediaCacheAccessFlusher {
  flush(): Promise<void>;
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

interface RuntimeReconciliationSchedule {
  initialize(input?: { intervalSeconds?: number }): Promise<unknown>;
}

interface RuntimeReconciliationRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WorkerRuntimeDependencies {
  closeMainDatabase(): Promise<void>;
  heartbeat: RuntimeHeartbeat;
  inbox: RuntimeInbox;
  mediaCacheWorker?: RuntimeMediaCacheWorker;
  poller: RuntimePoller;
  reconciliationRunner: RuntimeReconciliationRunner;
  reconciliationSchedule: RuntimeReconciliationSchedule;
  workers: RuntimeWorkerPool;
}

const defaultAdminAssetsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../admin/dist');
const RECONCILIATION_INTERVAL_SECONDS = 3_600;
const RECONCILIATION_LEASE_DURATION_MS = 120_000;
const RECONCILIATION_POLL_INTERVAL_MS = 30_000;
const RECONCILIATION_RENEWAL_INTERVAL_MS = 40_000;
const MEDIA_CACHE_ACCESS_FLUSH_INTERVAL_MS = 5 * 60_000;

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
    private readonly closeMediaCache: () => Promise<void> = async () => {},
  ) {}

  stop(): Promise<void> {
    this.stopPromise ??= runAll([this.closeHttp, this.closeMediaCache, this.closeDatabase]);
    return this.stopPromise;
  }
}

export class MediaCacheAccessRuntime {
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly flusher: RuntimeMediaCacheAccessFlusher,
    private readonly flushIntervalMs = MEDIA_CACHE_ACCESS_FLUSH_INTERVAL_MS,
  ) {
    if (!Number.isSafeInteger(flushIntervalMs) || flushIntervalMs <= 0) {
      throw new TypeError('Media cache access flush interval must be a positive integer');
    }
    this.schedule();
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flusher.flush();
  }

  private schedule(): void {
    if (this.closed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flusher
        .flush()
        .catch(() => {
          // Access observations are retryable bookkeeping; keep them pending for the next flush.
        })
        .finally(() => this.schedule());
    }, this.flushIntervalMs);
    this.timer.unref();
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
      await this.dependencies.reconciliationSchedule.initialize({
        intervalSeconds: RECONCILIATION_INTERVAL_SECONDS,
      });
      if (this.stopping) {
        throw new Error('Worker stopped during startup');
      }
      await this.dependencies.mediaCacheWorker?.initialize();
      if (this.stopping) {
        throw new Error('Worker stopped during startup');
      }
      const reconciliationLifetime = this.dependencies.reconciliationRunner.start();
      const pollerLifetime = this.dependencies.poller.start();
      const workerLifetime = this.dependencies.workers.start();
      const mediaCacheLifetime = this.dependencies.mediaCacheWorker?.start();
      this.monitorLifetime([
        pollerLifetime,
        workerLifetime,
        reconciliationLifetime,
        ...(mediaCacheLifetime ? [mediaCacheLifetime] : []),
      ]);
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

  private monitorLifetime(lifetimes: Promise<void>[]): void {
    void Promise.race(lifetimes).then(
      () => {
        if (!this.stopping) {
          const error = new Error('Worker runtime stopped unexpectedly');
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
        () => this.dependencies.reconciliationRunner.stop(),
        () => this.dependencies.poller.stop(),
        () => this.dependencies.workers.stop(),
        ...(this.dependencies.mediaCacheWorker
          ? [() => this.dependencies.mediaCacheWorker?.stop() ?? Promise.resolve()]
          : []),
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

export async function startServerRuntime(config: ServerRuntimeConfig): Promise<ServerRuntime> {
  const blobStore = config.mediaCache.enabled
    ? new LocalMediaBlobStore(config.mediaCache.root)
    : undefined;
  await blobStore?.initializeReadOnly();

  const mainConnection = createDatabaseConnection(config.databaseUrl);
  const repository = new PostgresMessageRepository(mainConnection.db, {
    mediaCacheEnabled: config.mediaCache.enabled,
  });
  const accessCoalescer = blobStore
    ? new MediaCacheAccessCoalescer(createPostgresMediaCacheAccessWriter(mainConnection.db))
    : undefined;
  const accessRuntime = accessCoalescer ? new MediaCacheAccessRuntime(accessCoalescer) : undefined;
  const mediaCacheAdmin = new PostgresMediaCacheAdminRepository(mainConnection.db, {
    enabled: config.mediaCache.enabled,
    maxBytes: config.mediaCache.maxBytes,
  });
  const mediaCacheMutations = blobStore
    ? new PostgresMediaCacheAdminService(mainConnection.db)
    : undefined;

  try {
    const app = createApp({
      admin: new PostgresAdminRepository(mainConnection.db),
      adminAssetsRoot: process.env.ADMIN_ASSETS_ROOT ?? defaultAdminAssetsRoot,
      auth: new BetterAuthRuntime(mainConnection.db, config.auth),
      ...(blobStore && accessCoalescer
        ? {
            media: new LocalPublicMediaReader(
              new PostgresPublicMediaObjectRepository(mainConnection.db),
              blobStore,
              accessCoalescer,
            ),
          }
        : {}),
      mediaCacheAdmin,
      ...(mediaCacheMutations ? { mediaCacheMutations } : {}),
      messages: repository,
      operations: new PostgresAdminOperations(mainConnection.db),
      publicApi: config.publicApi,
      reconciliation: new PostgresReconciliationPersistenceRepository(mainConnection.db),
      repair: new DeterministicRepairService(
        new PostgresDeterministicRepairRepository(mainConnection.db),
      ),
      tombstone: new MessageTombstoneService(
        new PostgresMessageTombstoneRepository(mainConnection.db),
      ),
      readiness: async () => {
        await mainConnection.db.execute(sql`select 1`);
      },
    });
    const server = startServer(app, config.port);
    const done = new Promise<void>((resolveDone, rejectDone) => {
      server.once('close', resolveDone);
      server.once('error', rejectDone);
    });
    return new ServerRuntime(
      done,
      () => closeServer(server),
      mainConnection.close,
      () => accessRuntime?.close() ?? Promise.resolve(),
    );
  } catch (error) {
    await runAll([() => accessRuntime?.close() ?? Promise.resolve(), mainConnection.close]).catch(
      () => {},
    );
    throw error;
  }
}

export function createWorkerRuntime(config: WorkerRuntimeConfig): WorkerRuntime {
  const mainConnection = createDatabaseConnection(config.databaseUrl);
  const repository = new PostgresMessageRepository(mainConnection.db);
  const heartbeat = new PostgresWorkerRuntimeRepository(mainConnection.db);
  const reconciliationSchedule = new PostgresReconciliationScheduleRepository(mainConnection.db);
  const reconciliationRunner = new ScheduledReconciliationRunner(
    reconciliationSchedule,
    new PostgresReconciliationPersistenceRepository(mainConnection.db),
    {
      getTelegramChannelIds: () => reconciliationSchedule.listConfiguredChannelScope(),
      instanceId: config.instanceId,
      leaseDurationMs: RECONCILIATION_LEASE_DURATION_MS,
      pollIntervalMs: RECONCILIATION_POLL_INTERVAL_MS,
      renewalIntervalMs: RECONCILIATION_RENEWAL_INTERVAL_MS,
    },
  );
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
  const mediaCacheWorker = config.mediaCache.enabled
    ? createMediaCacheWorkerRuntime({
        ...(config.apiRoot ? { apiRoot: config.apiRoot } : {}),
        botToken: config.botToken,
        config: config.mediaCache,
        database: mainConnection.db,
        leaseOwner: config.instanceId,
        telegramApi: api,
      })
    : undefined;

  return new WorkerRuntime(config.instanceId, {
    closeMainDatabase: mainConnection.close,
    heartbeat,
    inbox,
    ...(mediaCacheWorker ? { mediaCacheWorker } : {}),
    poller,
    reconciliationRunner,
    reconciliationSchedule,
    workers,
  });
}
