import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Database } from '../db/client.js';
import type { LocalMediaBlobStore } from './blob-store.js';
import {
  DesktopImportProvenanceError,
  PostgresDesktopMediaCacheRepository,
} from './desktop-import-repository.js';
import { DesktopMediaSource, DesktopMediaSourceTooLargeError } from './desktop-source.js';
import type { MediaCacheDiscoveryResult } from './discovery-repository.js';
import { PostgresMediaCacheLedgerRepository } from './ledger-repository.js';
import { TelegramMediaSourceTooLargeError } from './telegram-source.js';
import { MediaCacheWorker } from './worker.js';

export interface DesktopImportMediaCacheInput {
  desktopRoot: string;
  importRunId: string;
  inputPath: string;
  initiatorId: string;
  reason: string;
}

export interface DesktopImportMediaCacheResult {
  auditedObjects: number;
  completedPlans: number;
  failedPlans: number;
  hasMore: boolean;
  inputStable: boolean;
  offeredPlans: number;
  scannedEvidence: number;
  status: 'bounded_incomplete' | 'completed' | 'input_changed_after_commit' | 'partial';
  unclaimedPlans: number;
}

const MAX_WORKER_PASSES = 10_000;

export class DesktopImportMediaCacheService {
  constructor(
    private readonly database: Database,
    private readonly blobStore: LocalMediaBlobStore,
    private readonly discover: () => Promise<MediaCacheDiscoveryResult>,
  ) {}

  async run(input: DesktopImportMediaCacheInput): Promise<DesktopImportMediaCacheResult> {
    assertInput(input);
    const before = await hashRegularFile(input.inputPath);
    const repository = new PostgresDesktopMediaCacheRepository(this.database, input.importRunId);
    await repository.verifyCompletedImport(before);

    const desktopSource = new DesktopMediaSource();
    const worker = new MediaCacheWorker({
      blobStore: this.blobStore,
      claimAwaitingLocalSource: true,
      discovery: {
        discoverBatch: async () => ({
          cursor: null,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        }),
      },
      failureRetryDisposition: 'await_local_source',
      ledger: new PostgresMediaCacheLedgerRepository(this.database),
      leaseOwner: input.initiatorId,
      maxPlansPerRun: 4,
      source: {
        open: async ({ fileId, maxBytes, signal }) => {
          try {
            return await desktopSource.open({
              desktopRoot: input.desktopRoot,
              maxBytes,
              ...(signal ? { signal } : {}),
              sourcePath: fileId,
            });
          } catch (error) {
            if (error instanceof DesktopMediaSourceTooLargeError) {
              throw new TelegramMediaSourceTooLargeError(error.maxBytes, error.declaredBytes);
            }
            throw error;
          }
        },
      },
      work: repository,
    });

    let completedPlans = 0;
    let failedPlans = 0;
    let scannedEvidence = 0;
    let hasMore = true;
    let previousCursor: string | null = null;
    for (let pass = 0; pass < MAX_WORKER_PASSES; pass += 1) {
      const discovery = await this.discover();
      scannedEvidence += discovery.scanned;
      const cursor = discovery.cursor
        ? `${discovery.cursor.createdAt.toISOString()}:${discovery.cursor.id}`
        : null;
      if (discovery.scanned > 0 && cursor === previousCursor) {
        break;
      }
      previousCursor = cursor;
      const offeredBefore = repository.offeredPlanCount();
      const result = await worker.runOnce();
      completedPlans += result.completedPlans;
      failedPlans += result.failedPlans;
      const offered = repository.offeredPlanCount() - offeredBefore;
      if (discovery.scanned === 0 && offered === 0) {
        hasMore = false;
        break;
      }
    }
    const inputStable = await hashRegularFile(input.inputPath)
      .then((after) => after === before)
      .catch(() => false);
    const auditedObjects = await repository.recordCompletedActions({
      initiatorId: input.initiatorId,
      reason: input.reason,
    });
    const offeredPlans = repository.offeredPlanCount();
    const unclaimedPlans = Math.max(0, offeredPlans - completedPlans - failedPlans);
    return {
      auditedObjects,
      completedPlans,
      failedPlans,
      hasMore,
      inputStable,
      offeredPlans,
      scannedEvidence,
      status: hasMore
        ? 'bounded_incomplete'
        : !inputStable
          ? 'input_changed_after_commit'
          : failedPlans > 0 || unclaimedPlans > 0
            ? 'partial'
            : 'completed',
      unclaimedPlans,
    };
  }
}

async function hashRegularFile(inputPath: string): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) {
      throw new DesktopImportProvenanceError();
    }
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) {
      hash.update(chunk);
    }
    const after = await file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new DesktopImportProvenanceError();
    }
    return hash.digest('hex');
  } catch (error) {
    if (error instanceof DesktopImportProvenanceError) {
      throw error;
    }
    throw new DesktopImportProvenanceError();
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function assertInput(input: DesktopImportMediaCacheInput): void {
  if (!input.inputPath || !input.desktopRoot) {
    throw new DesktopImportProvenanceError();
  }
  if (!/^desktop-cli:\d+$/u.test(input.initiatorId)) {
    throw new TypeError('Desktop media cache initiator is invalid');
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) {
    throw new TypeError('Desktop media cache reason must contain 1 to 500 characters');
  }
}
