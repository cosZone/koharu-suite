import { sql } from 'drizzle-orm';
import type { MediaCacheConfig, MediaS3Config } from '../config.js';
import type { Database } from '../db/client.js';
import { mediaCacheRuntime } from '../db/schema.js';
import type { GrammyTelegramApi } from '../telegram/api.js';
import {
  BackendAwareCommittedBlobReader,
  PostgresCommittedBlobLocationRepository,
} from './backend-aware-reader.js';
import { LocalMediaBlobStore } from './blob-store.js';
import { MediaCacheCommandProcessor, PostgresMediaCacheCommandQueue } from './command-queue.js';
import { PostgresMediaCacheDiscoveryRepository } from './discovery-repository.js';
import { MediaCacheEvictionService } from './eviction-repository.js';
import {
  MEDIA_CACHE_ADVISORY_LOCK,
  PostgresMediaCacheLedgerRepository,
} from './ledger-repository.js';
import {
  LocalPersistentBlobBackend,
  PersistentBlobBackendRegistry,
  S3PersistentBlobBackend,
} from './local-persistent-blob-backend.js';
import { MediaCacheMaintenanceService } from './maintenance-service.js';
import { S3MediaBlobBackend } from './s3-blob-backend.js';
import { StorageLedgerRepository } from './storage-ledger-repository.js';
import {
  PostgresLegacyLocalRestoreFinalizer,
  PostgresStorageOperationService,
} from './storage-operation-service.js';
import { PostgresStoragePruneService } from './storage-prune-service.js';
import { TelegramMediaSource } from './telegram-source.js';
import { PostgresMediaCacheThumbnailLedgerRepository } from './thumbnail-ledger-repository.js';
import { MediaCacheWorker, type MediaCacheWorkerRunResult } from './worker.js';
import { PostgresMediaCacheWorkerRepository } from './worker-repository.js';

const DEFAULT_IDLE_INTERVAL_MS = 1_000;
const MAX_CACHE_BYTES = 5 * 1024 * 1024 * 1024;

interface MediaCacheRunOnce {
  runOnce(signal?: AbortSignal): Promise<MediaCacheWorkerRunResult>;
}

interface MediaCacheCapacity {
  initialize(): Promise<void>;
  pruneConfiguredExcess(signal?: AbortSignal): Promise<void>;
}

interface MediaCacheCapacityBlobStore {
  initialize(): Promise<void>;
}

export interface MediaCacheWorkerRuntimeOptions {
  capacity: MediaCacheCapacity;
  commands?: { runOnce(signal?: AbortSignal): Promise<boolean> };
  idleIntervalMs?: number;
  runner: MediaCacheRunOnce;
}

export interface CreateMediaCacheWorkerRuntimeInput {
  apiRoot?: string;
  botToken: string;
  config: MediaCacheConfig;
  database: Database;
  leaseOwner: string;
  mediaS3: MediaS3Config;
  telegramApi: GrammyTelegramApi;
}

export class MediaCacheWorkerRuntime {
  readonly #abortController = new AbortController();
  readonly #capacity: MediaCacheCapacity;
  readonly #commands: { runOnce(signal?: AbortSignal): Promise<boolean> } | undefined;
  readonly #done: Promise<void>;
  readonly #idleIntervalMs: number;
  readonly #runner: MediaCacheRunOnce;
  #initializePromise: Promise<void> | undefined;
  #rejectDone!: (reason: unknown) => void;
  #resolveDone!: () => void;
  #settled = false;
  #started = false;
  #stopPromise: Promise<void> | undefined;

  constructor(options: MediaCacheWorkerRuntimeOptions) {
    const idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
    if (!Number.isSafeInteger(idleIntervalMs) || idleIntervalMs <= 0) {
      throw new TypeError('Media cache worker idle interval must be a positive integer');
    }
    this.#capacity = options.capacity;
    this.#commands = options.commands;
    this.#idleIntervalMs = idleIntervalMs;
    this.#runner = options.runner;
    this.#done = new Promise<void>((resolve, reject) => {
      this.#resolveDone = resolve;
      this.#rejectDone = reject;
    });
  }

  get done(): Promise<void> {
    return this.#done;
  }

  initialize(): Promise<void> {
    this.#initializePromise ??= this.#capacity.initialize();
    return this.#initializePromise;
  }

  start(): Promise<void> {
    if (!this.#started) {
      this.#started = true;
      void this.#run().then(
        () => this.#resolve(),
        (error: unknown) => this.#reject(error),
      );
    }
    return this.#done;
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stopOnce();
    return this.#stopPromise;
  }

  async #run(): Promise<void> {
    await this.initialize();
    while (!this.#abortController.signal.aborted) {
      const signal = this.#abortController.signal;
      await isolateSteadyStateTask(() => this.#capacity.pruneConfiguredExcess(signal), signal);
      await isolateSteadyStateTask(() => this.#commands?.runOnce(signal), signal);
      await isolateSteadyStateTask(() => this.#runner.runOnce(signal), signal);
      if (signal.aborted) {
        break;
      }
      await abortableDelay(this.#idleIntervalMs, signal);
    }
  }

  async #stopOnce(): Promise<void> {
    this.#abortController.abort(new DOMException('Media cache worker stopped', 'AbortError'));
    if (!this.#started) {
      await this.#initializePromise?.catch(() => undefined);
      this.#resolve();
    }
    try {
      await this.#done;
    } catch (error) {
      if (!this.#abortController.signal.aborted) {
        throw error;
      }
    }
  }

  #reject(error: unknown): void {
    if (this.#abortController.signal.aborted) {
      this.#resolve();
      return;
    }
    if (!this.#settled) {
      this.#settled = true;
      this.#rejectDone(error);
    }
  }

  #resolve(): void {
    if (!this.#settled) {
      this.#settled = true;
      this.#resolveDone();
    }
  }
}

async function isolateSteadyStateTask(
  task: () => Promise<unknown> | undefined,
  signal: AbortSignal,
): Promise<void> {
  try {
    await task();
  } catch {
    if (signal.aborted) {
      return;
    }
    // The cache is optional. One failed bounded task must not starve its siblings.
  }
}

export function createMediaCacheWorkerRuntime(
  input: CreateMediaCacheWorkerRuntimeInput,
): MediaCacheWorkerRuntime {
  assertRuntimeInput(input);
  const blobStore = new LocalMediaBlobStore(input.config.root);
  const persistentBackends = createPersistentBlobBackendRegistry(blobStore, input.mediaS3);
  const committedBlobReader = new BackendAwareCommittedBlobReader(
    new PostgresCommittedBlobLocationRepository(input.database),
    persistentBackends,
  );
  const storagePrune = new PostgresStoragePruneService(input.database, persistentBackends);
  const ledger = new PostgresMediaCacheLedgerRepository(input.database);
  const work = new PostgresMediaCacheWorkerRepository(input.database);
  const capacity = new PostgresMediaCacheCapacity(
    input.database,
    blobStore,
    input.config.maxBytes,
    input.config.root,
    input.leaseOwner,
    input.mediaS3,
    storagePrune,
  );
  const commands = new MediaCacheCommandProcessor(
    input.database,
    new PostgresMediaCacheCommandQueue(input.database),
    new MediaCacheEvictionService(input.database, blobStore),
    new MediaCacheMaintenanceService(input.database, blobStore, input.leaseOwner),
    input.leaseOwner,
    new PostgresStorageOperationService(
      input.database,
      persistentBackends,
      new PostgresLegacyLocalRestoreFinalizer(),
      storagePrune,
    ),
  );
  const runner = new MediaCacheWorker({
    blobStore,
    committedBlobReader,
    discovery: new PostgresMediaCacheDiscoveryRepository(input.database),
    ledger,
    leaseOwner: input.leaseOwner,
    maxPlansPerRun: input.config.downloadConcurrency,
    source: new TelegramMediaSource({
      api: input.telegramApi,
      botToken: input.botToken,
      ...(input.apiRoot ? { apiRoot: input.apiRoot } : {}),
    }),
    thumbnailLedger: new PostgresMediaCacheThumbnailLedgerRepository(input.database),
    work,
  });
  return new MediaCacheWorkerRuntime({ capacity, commands, runner });
}

export function createPersistentBlobBackendRegistry(
  blobStore: LocalMediaBlobStore,
  mediaS3: MediaS3Config,
): PersistentBlobBackendRegistry {
  const local = new LocalPersistentBlobBackend(blobStore);
  if (!mediaS3.enabled) {
    return new PersistentBlobBackendRegistry([local]);
  }
  const s3 = new S3PersistentBlobBackend(
    new S3MediaBlobBackend({
      bucket: mediaS3.bucket,
      connectTimeoutMs: mediaS3.connectTimeoutMs,
      credentials: {
        accessKeyId: mediaS3.accessKeyId,
        secretAccessKey: mediaS3.secretAccessKey,
      },
      endpoint: mediaS3.endpoint,
      forcePathStyle: mediaS3.forcePathStyle,
      prefix: mediaS3.prefix,
      region: mediaS3.region,
      requestTimeoutMs: mediaS3.requestTimeoutMs,
    }),
  );
  return new PersistentBlobBackendRegistry([local, s3]);
}

class PostgresMediaCacheCapacity implements MediaCacheCapacity {
  constructor(
    private readonly database: Database,
    private readonly blobStore: MediaCacheCapacityBlobStore,
    private readonly maxBytes: number,
    private readonly configRoot: string,
    private readonly leaseOwner: string,
    private readonly mediaS3: MediaS3Config,
    private readonly storagePrune: PostgresStoragePruneService,
  ) {}

  async initialize(): Promise<void> {
    await this.blobStore.initialize();
    await new StorageLedgerRepository(this.database).bootstrap({
      local: {
        maxBytes: BigInt(this.maxBytes),
        root: this.configRoot,
      },
      ...(this.mediaS3.enabled
        ? {
            s3: {
              bucket: this.mediaS3.bucket,
              endpointOrigin: this.mediaS3.endpoint,
              forcePathStyle: this.mediaS3.forcePathStyle,
              maxBytes: BigInt(this.mediaS3.maxBytes),
              prefix: this.mediaS3.prefix,
              region: this.mediaS3.region,
            },
          }
        : {}),
    });
    const configuredMax = BigInt(this.maxBytes);
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${MEDIA_CACHE_ADVISORY_LOCK})`);
      const [runtime] = await transaction
        .insert(mediaCacheRuntime)
        .values({
          maxBytes: configuredMax,
          singletonKey: 'local',
          updatedAt: sql`clock_timestamp()`,
        })
        .onConflictDoUpdate({
          set: {
            maxBytes: configuredMax,
            updatedAt: sql`clock_timestamp()`,
          },
          target: mediaCacheRuntime.singletonKey,
        })
        .returning({ maxBytes: mediaCacheRuntime.maxBytes });
      if (!runtime || runtime.maxBytes !== configuredMax) {
        throw new Error('Media cache runtime did not accept the configured byte limit');
      }
    });
  }

  async pruneConfiguredExcess(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.storagePrune.apply({
      command: {
        initiatorId: this.leaseOwner,
        initiatorKind: 'worker',
        operation: 'prune',
        reason: 'configured local storage capacity',
        targetBackendId: 'local',
        targetBytes: BigInt(this.maxBytes),
      },
      renewLease: async () => signal?.throwIfAborted(),
      ...(signal ? { signal } : {}),
    });
  }
}

function assertRuntimeInput(input: CreateMediaCacheWorkerRuntimeInput): void {
  if (
    !input.leaseOwner.trim() ||
    input.leaseOwner.trim().length > 255 ||
    !Number.isSafeInteger(input.config.downloadConcurrency) ||
    input.config.downloadConcurrency < 1 ||
    input.config.downloadConcurrency > 4 ||
    !Number.isSafeInteger(input.config.maxBytes) ||
    input.config.maxBytes < 1 ||
    input.config.maxBytes > MAX_CACHE_BYTES
  ) {
    throw new TypeError('Invalid media cache worker runtime configuration');
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    timer.unref();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
