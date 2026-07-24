import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { MediaCacheConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { mediaCacheRuntime } from '../db/schema.js';
import type { GrammyTelegramApi } from '../telegram/api.js';
import { LocalMediaBlobStore } from './blob-store.js';
import { MediaCacheCommandProcessor, PostgresMediaCacheCommandQueue } from './command-queue.js';
import { PostgresMediaCacheDiscoveryRepository } from './discovery-repository.js';
import { MediaCacheEvictionService } from './eviction-repository.js';
import {
  MEDIA_CACHE_ADVISORY_LOCK,
  PostgresMediaCacheLedgerRepository,
} from './ledger-repository.js';
import { MediaCacheMaintenanceService } from './maintenance-service.js';
import { TelegramMediaSource } from './telegram-source.js';
import { PostgresMediaCacheThumbnailLedgerRepository } from './thumbnail-ledger-repository.js';
import { MediaCacheWorker, type MediaCacheWorkerRunResult } from './worker.js';
import { PostgresMediaCacheWorkerRepository } from './worker-repository.js';

const DEFAULT_IDLE_INTERVAL_MS = 1_000;
const EVICTION_LEASE_MS = 2 * 60_000;
const MAX_CAPACITY_EVICTIONS_PER_PASS = 100;
const MAX_CACHE_BYTES = 5 * 1024 * 1024 * 1024;

interface MediaCacheRunOnce {
  runOnce(signal?: AbortSignal): Promise<MediaCacheWorkerRunResult>;
}

interface MediaCacheCapacity {
  initialize(): Promise<void>;
  pruneConfiguredExcess(signal?: AbortSignal): Promise<void>;
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
  const ledger = new PostgresMediaCacheLedgerRepository(input.database);
  const work = new PostgresMediaCacheWorkerRepository(input.database);
  const capacity = new PostgresMediaCacheCapacity(
    input.database,
    blobStore,
    input.config.maxBytes,
    input.leaseOwner,
  );
  const commands = new MediaCacheCommandProcessor(
    input.database,
    new PostgresMediaCacheCommandQueue(input.database),
    new MediaCacheEvictionService(input.database, blobStore),
    new MediaCacheMaintenanceService(input.database, blobStore, input.leaseOwner),
    input.leaseOwner,
  );
  const runner = new MediaCacheWorker({
    blobStore,
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

class PostgresMediaCacheCapacity implements MediaCacheCapacity {
  readonly #eviction: MediaCacheEvictionService;
  readonly #ledger: PostgresMediaCacheLedgerRepository;

  constructor(
    private readonly database: Database,
    private readonly blobStore: LocalMediaBlobStore,
    private readonly maxBytes: number,
    private readonly leaseOwner: string,
  ) {
    this.#eviction = new MediaCacheEvictionService(database, blobStore);
    this.#ledger = new PostgresMediaCacheLedgerRepository(database);
  }

  async initialize(): Promise<void> {
    await this.blobStore.initialize();
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
    for (let evictions = 0; evictions < MAX_CAPACITY_EVICTIONS_PER_PASS; evictions += 1) {
      signal?.throwIfAborted();
      const requiredHeadroom = await this.#ledger.requiredHeadroomBytes();
      if (requiredHeadroom <= 0n) {
        return;
      }
      const now = await this.#readDatabaseClock();
      const result = await this.#eviction.evict({
        evictionExpiresAt: new Date(now.getTime() + EVICTION_LEASE_MS),
        evictionOwner: this.leaseOwner,
        evictionToken: randomUUID(),
        initiator: {
          initiatorId: this.leaseOwner,
          kind: 'worker',
        },
        selection: { kind: 'least_recently_used' },
      });
      if (!result) {
        return;
      }
    }
  }

  async #readDatabaseClock(): Promise<Date> {
    const [clock] = await this.database.execute<{ now: Date | string }>(
      sql`select clock_timestamp() as now`,
    );
    const now = clock ? new Date(clock.now) : null;
    if (!now || !Number.isFinite(now.getTime())) {
      throw new Error('PostgreSQL returned an invalid media cache clock');
    }
    return now;
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
