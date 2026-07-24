import { createHash, randomUUID } from 'node:crypto';
import type {
  MediaBlobIdentity,
  MediaBlobLease,
  PublishedMediaBlob,
  StagedMediaBlob,
} from './blob-store.js';
import { MediaBlobTooLargeError } from './blob-store.js';
import {
  type CacheableMediaKind,
  MediaContentTypeError,
  validateMediaContentType,
} from './content-type.js';
import type { MediaCacheDiscoveryResult } from './discovery-repository.js';
import {
  type ClaimedMediaCachePostPlan,
  type CompleteMediaCacheSettlementInput,
  type ExpiredMediaCachePostPlanSnapshot,
  type FailClaimedMediaCachePostPlanInput,
  MediaCacheLedgerError,
  type PublishedMediaCacheObjectIdentity,
  type RecordPublishedMediaCacheObjectsInput,
  type RecoveredMediaCachePostPlan,
  type SkipClaimedMediaCacheObjectInput,
} from './ledger-repository.js';
import { ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES, PHOTO_ORIGINAL_LIMIT_BYTES } from './policy.js';
import {
  TelegramMediaSourcePermanentError,
  TelegramMediaSourceTooLargeError,
  TelegramMediaSourceTransientError,
} from './telegram-source.js';
import { createThumbnailSource, ThumbnailGenerationError } from './thumbnail.js';
import type {
  ClaimedMediaCacheThumbnail,
  ExpiredMediaCacheThumbnail,
  PostgresMediaCacheThumbnailLedgerRepository,
} from './thumbnail-ledger-repository.js';

const DEFAULT_LEASE_DURATION_MS = 5 * 60_000;
const DEFAULT_PLAN_LIMIT = 2;
const MAX_PLAN_LIMIT = 4;
const POST_ORIGINAL_LIMIT_BYTES = 50 * 1024 * 1024;

export interface ClaimedMediaCacheOriginal {
  kind: CacheableMediaKind;
  objectId: string;
  position: number;
  sources: readonly TelegramMediaCacheSource[];
}

export interface TelegramMediaCacheSource {
  fileId: string;
}

export interface MediaCacheWorkerDiscovery {
  discoverBatch: () => Promise<MediaCacheDiscoveryResult>;
}

export interface MediaCacheWorkerLedger {
  claimPostPlan: (input: {
    allowAwaitingLocalSource?: boolean;
    leaseExpiresAt: Date;
    leaseOwner: string;
    leaseToken: string;
    planId: string;
  }) => Promise<ClaimedMediaCachePostPlan | null>;
  completeSettlement: (input: CompleteMediaCacheSettlementInput) => Promise<unknown>;
  failClaimedPostPlan: (input: FailClaimedMediaCachePostPlanInput) => Promise<unknown>;
  markExpiredRecoveryFailed: (input: {
    leaseExpiresAt: Date;
    leaseOwner: string;
    leaseToken: string;
    planId: string;
  }) => Promise<boolean>;
  recordPublishedObjects: (input: RecordPublishedMediaCacheObjectsInput) => Promise<unknown>;
  recoverExpiredPostPlan: (input: {
    leaseExpiresAt: Date;
    leaseOwner: string;
    leaseToken: string;
    planId: string;
    recover: (snapshot: ExpiredMediaCachePostPlanSnapshot) => Promise<void>;
  }) => Promise<RecoveredMediaCachePostPlan | null>;
  skipClaimedObject: (input: SkipClaimedMediaCacheObjectInput) => Promise<boolean>;
}

export interface MediaCacheWorkerWorkRepository {
  discoverThumbnailObjects?: (limit?: number) => Promise<number>;
  ensureThumbnailObjects: (planId: string) => Promise<number>;
  listExpiredPostPlanIds: (limit: number) => Promise<string[]>;
  listExpiredThumbnailObjectIds?: (limit?: number) => Promise<string[]>;
  listRunnablePostPlanIds: (limit: number) => Promise<string[]>;
  loadClaimedOriginals: (
    planId: string,
    leaseToken: string,
  ) => Promise<ClaimedMediaCacheOriginal[]>;
  listRunnableThumbnailObjectIds?: (limit?: number) => Promise<string[]>;
}

export interface MediaCacheWorkerBlobStore {
  discardPartialLease: (lease: MediaBlobLease) => Promise<unknown>;
  open: (blob: MediaBlobIdentity) => Promise<import('node:fs/promises').FileHandle>;
  openStaged: (staged: StagedMediaBlob) => Promise<import('node:fs/promises').FileHandle>;
  publish: (staged: StagedMediaBlob) => Promise<PublishedMediaBlob>;
  recoverLease: (lease: MediaBlobLease) => Promise<readonly StagedMediaBlob[]>;
  settle: (staged: StagedMediaBlob, settlement: 'db_committed' | 'db_rolled_back') => Promise<void>;
  stage: (input: {
    lease: MediaBlobLease;
    maxBytes: number;
    objectId: string;
    signal?: AbortSignal;
    source: ReadableStream<Uint8Array>;
  }) => Promise<StagedMediaBlob>;
}

export interface MediaCacheWorkerSource {
  open: (input: { fileId: string; maxBytes: number; signal?: AbortSignal }) => Promise<{
    declaredBytes: bigint | null;
    stream: ReadableStream<Uint8Array>;
  }>;
}

export interface MediaCacheWorkerOptions {
  blobStore: MediaCacheWorkerBlobStore;
  claimAwaitingLocalSource?: boolean;
  discovery: MediaCacheWorkerDiscovery;
  failureRetryDisposition?: 'await_local_source' | 'retry';
  ledger: MediaCacheWorkerLedger;
  leaseDurationMs?: number;
  leaseOwner: string;
  maxPlansPerRun?: number;
  now?: () => Date;
  randomUuid?: () => string;
  source: MediaCacheWorkerSource;
  thumbnailLedger?: Pick<
    PostgresMediaCacheThumbnailLedgerRepository,
    'claim' | 'complete' | 'fail' | 'recordPublished' | 'recoverExpired'
  >;
  work: MediaCacheWorkerWorkRepository;
}

export interface MediaCacheWorkerRunResult {
  completedPlans: number;
  discovered: number;
  failedPlans: number;
  recoveredPlans: number;
  scannedEvidence: number;
  thumbnailsCompleted: number;
  thumbnailsSkipped: number;
}

interface StagedOriginal {
  contentType: Awaited<ReturnType<typeof validateMediaContentType>>;
  staged: StagedMediaBlob;
}

export class MediaCacheWorker {
  private readonly blobStore: MediaCacheWorkerBlobStore;
  private readonly claimAwaitingLocalSource: boolean;
  private readonly discovery: MediaCacheWorkerDiscovery;
  private readonly ledger: MediaCacheWorkerLedger;
  private readonly leaseDurationMs: number;
  private readonly leaseOwner: string;
  private readonly maxPlansPerRun: number;
  private readonly now: () => Date;
  private readonly randomUuid: () => string;
  private readonly failureRetryDisposition: 'await_local_source' | 'retry';
  private readonly source: MediaCacheWorkerSource;
  private readonly thumbnailLedger:
    | Pick<
        PostgresMediaCacheThumbnailLedgerRepository,
        'claim' | 'complete' | 'fail' | 'recordPublished' | 'recoverExpired'
      >
    | undefined;
  private readonly work: MediaCacheWorkerWorkRepository;

  constructor(options: MediaCacheWorkerOptions) {
    this.blobStore = options.blobStore;
    this.claimAwaitingLocalSource = options.claimAwaitingLocalSource ?? false;
    this.discovery = options.discovery;
    this.ledger = options.ledger;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.leaseOwner = options.leaseOwner.trim();
    this.maxPlansPerRun = options.maxPlansPerRun ?? DEFAULT_PLAN_LIMIT;
    this.now = options.now ?? (() => new Date());
    this.randomUuid = options.randomUuid ?? randomUUID;
    this.failureRetryDisposition = options.failureRetryDisposition ?? 'retry';
    this.source = options.source;
    this.thumbnailLedger = options.thumbnailLedger;
    this.work = options.work;
    assertOptions(this.leaseOwner, this.leaseDurationMs, this.maxPlansPerRun);
  }

  async runOnce(signal?: AbortSignal): Promise<MediaCacheWorkerRunResult> {
    signal?.throwIfAborted();
    const discovery = await this.discovery.discoverBatch();
    const expired = await this.work.listExpiredPostPlanIds(this.maxPlansPerRun);
    let recoveredPlans = 0;
    for (const planId of expired) {
      signal?.throwIfAborted();
      try {
        if (await this.recoverPlan(planId)) {
          recoveredPlans += 1;
        }
      } catch {
        // Recovery is isolated so one corrupt lease cannot stop runnable work.
      }
    }

    const runnable = await this.work.listRunnablePostPlanIds(this.maxPlansPerRun);
    const planResults = await Promise.all(
      runnable.map(async (planId) => {
        signal?.throwIfAborted();
        try {
          return (await this.processPlan(planId, signal)) ? 'completed' : 'unclaimed';
        } catch {
          return 'failed';
        }
      }),
    );
    const completedPlans = planResults.filter((result) => result === 'completed').length;
    const failedPlans = planResults.filter((result) => result === 'failed').length;

    await this.recoverNextThumbnail().catch(() => undefined);
    const thumbnail = await this.processNextThumbnail(signal);
    return {
      completedPlans,
      discovered: discovery.plansCreated,
      failedPlans,
      recoveredPlans,
      scannedEvidence: discovery.scanned,
      thumbnailsCompleted: thumbnail === 'completed' ? 1 : 0,
      thumbnailsSkipped: thumbnail === 'skipped' ? 1 : 0,
    };
  }

  private async recoverNextThumbnail(): Promise<void> {
    if (!this.thumbnailLedger || !this.work.listExpiredThumbnailObjectIds) {
      return;
    }
    const [objectId] = await this.work.listExpiredThumbnailObjectIds(1);
    if (!objectId) {
      return;
    }
    const leaseToken = this.randomUuid();
    const result = await this.thumbnailLedger.recoverExpired({
      leaseExpiresAt: new Date(this.now().getTime() + this.leaseDurationMs),
      leaseOwner: this.leaseOwner,
      leaseToken,
      objectId,
      recover: (snapshot) => this.recoverThumbnailFilesystem(snapshot),
    });
    if (result === 'settling') {
      await this.thumbnailLedger.complete({ leaseToken, objectId });
    }
  }

  private async recoverThumbnailFilesystem(snapshot: ExpiredMediaCacheThumbnail): Promise<void> {
    const oldLease = {
      leaseToken: snapshot.previousLeaseToken,
      planId: snapshot.planId,
    };
    await this.blobStore.discardPartialLease(oldLease);
    const recovered = await this.blobStore.recoverLease(oldLease);
    if (recovered.some((item) => item.objectId !== snapshot.objectId)) {
      throw new Error('Thumbnail recovery found unrelated staging provenance');
    }
    const [staged] = recovered;
    if (snapshot.phase === 'precommit') {
      if (staged) {
        await this.blobStore.settle(staged, 'db_rolled_back');
      }
      return;
    }
    if (snapshot.actualBytes === null || snapshot.blobSha256 === null) {
      throw new Error('Committed thumbnail recovery has no blob identity');
    }
    if (staged) {
      if (
        BigInt(staged.byteLength) !== snapshot.actualBytes ||
        staged.sha256 !== snapshot.blobSha256
      ) {
        throw new Error('Thumbnail recovery staging conflicts with the ledger');
      }
      await this.blobStore.settle(staged, 'db_committed');
      return;
    }
    const file = await this.blobStore.open({
      byteLength: Number(snapshot.actualBytes),
      relativeKey: relativeKey(snapshot.blobSha256),
      sha256: snapshot.blobSha256,
    });
    await verifyOpenBlob(file, snapshot.blobSha256);
  }

  private async processNextThumbnail(
    signal?: AbortSignal,
  ): Promise<'completed' | 'none' | 'skipped'> {
    if (!this.thumbnailLedger || !this.work.listRunnableThumbnailObjectIds) {
      return 'none';
    }
    await this.work.discoverThumbnailObjects?.();
    const [objectId] = await this.work.listRunnableThumbnailObjectIds(1);
    if (!objectId) {
      return 'none';
    }
    const leaseToken = this.randomUuid();
    const claimed = await this.thumbnailLedger.claim({
      leaseExpiresAt: new Date(this.now().getTime() + this.leaseDurationMs),
      leaseOwner: this.leaseOwner,
      leaseToken,
      objectId,
    });
    if (!claimed) {
      return 'none';
    }
    return this.generateThumbnail(claimed, leaseToken, signal);
  }

  private async generateThumbnail(
    claimed: ClaimedMediaCacheThumbnail,
    leaseToken: string,
    signal?: AbortSignal,
  ): Promise<'completed' | 'skipped'> {
    const lease = { leaseToken, planId: claimed.planId };
    let staged: StagedMediaBlob | undefined;
    try {
      const original = await this.blobStore.open({
        byteLength: Number(claimed.original.byteLength),
        relativeKey: claimed.original.relativeKey,
        sha256: claimed.original.sha256,
      });
      const thumbnail = createThumbnailSource(original, {
        mimeType: claimed.original.detectedMime,
        ...(signal ? { signal } : {}),
      });
      const [stageResult, recipeResult] = await Promise.allSettled([
        this.blobStore.stage({
          lease,
          maxBytes: 1024 * 1024,
          objectId: claimed.objectId,
          ...(signal ? { signal } : {}),
          source: thumbnail.stream,
        }),
        thumbnail.result,
      ]);
      if (stageResult.status === 'fulfilled') {
        staged = stageResult.value;
      }
      if (stageResult.status === 'rejected') {
        throw stageResult.reason;
      }
      const completedStage = stageResult.value;
      staged = completedStage;
      if (recipeResult.status === 'rejected') {
        throw recipeResult.reason;
      }
      await this.thumbnailLedger?.recordPublished({
        leaseToken,
        object: {
          byteLength: BigInt(completedStage.byteLength),
          detectedMime: 'image/webp',
          objectId: claimed.objectId,
          relativeKey: relativeKey(completedStage.sha256),
          sha256: completedStage.sha256,
        },
        publish: () => this.blobStore.publish(completedStage).then(() => undefined),
      });
    } catch (error) {
      await this.thumbnailLedger?.fail({
        cleanup: async () => {
          if (staged) {
            await this.blobStore.settle(staged, 'db_rolled_back');
          }
        },
        errorCode: thumbnailErrorCode(error),
        leaseToken,
        objectId: claimed.objectId,
      });
      return 'skipped';
    }
    if (!staged) {
      throw new Error('Thumbnail publication completed without staging provenance');
    }
    await this.blobStore.settle(staged, 'db_committed');
    await this.thumbnailLedger?.complete({ leaseToken, objectId: claimed.objectId });
    return 'completed';
  }

  private async processPlan(planId: string, signal?: AbortSignal): Promise<boolean> {
    const leaseToken = this.randomUuid();
    const leaseExpiresAt = new Date(this.now().getTime() + this.leaseDurationMs);
    const claimed = await this.ledger.claimPostPlan({
      ...(this.claimAwaitingLocalSource ? { allowAwaitingLocalSource: true } : {}),
      leaseExpiresAt,
      leaseOwner: this.leaseOwner,
      leaseToken,
      planId,
    });
    if (!claimed) {
      return false;
    }

    const lease = { leaseToken, planId };
    const staged: StagedOriginal[] = [];

    try {
      const originals = await this.work.loadClaimedOriginals(planId, leaseToken);
      assertClaimedOriginalSet(claimed, originals);
      let aggregateBytes = 0;
      const skipped: Array<{
        objectId: string;
        reasonCode: PermanentPlanFailure['reasonCode'];
      }> = [];
      for (const original of originals) {
        signal?.throwIfAborted();
        const maxBytes = originalLimit(original.kind);
        const remainingPostBytes = POST_ORIGINAL_LIMIT_BYTES - aggregateBytes;
        if (remainingPostBytes <= 0) {
          throw new PermanentPlanFailure('skipped_post_limit');
        }
        let stagedOriginal: StagedOriginal;
        try {
          stagedOriginal = await this.stageFromFirstAvailableSource(
            original,
            lease,
            maxBytes,
            Math.min(maxBytes, remainingPostBytes),
            signal,
          );
        } catch (error) {
          if (!(error instanceof PermanentPlanFailure)) {
            throw error;
          }
          if (error.reasonCode === 'skipped_post_limit') {
            throw error;
          }
          skipped.push({ objectId: original.objectId, reasonCode: error.reasonCode });
          continue;
        }
        const stagedBlob = stagedOriginal.staged;
        aggregateBytes += stagedBlob.byteLength;
        if (aggregateBytes > POST_ORIGINAL_LIMIT_BYTES) {
          await this.blobStore.settle(stagedBlob, 'db_rolled_back');
          throw new PermanentPlanFailure('skipped_post_limit');
        }
        staged.push(stagedOriginal);
      }
      if (staged.length === 0) {
        throw new PermanentPlanFailure(skipped[0]?.reasonCode ?? 'source_unavailable');
      }
      for (const object of skipped) {
        await this.ledger.skipClaimedObject({
          cleanup: async () => undefined,
          leaseToken,
          objectId: object.objectId,
          planId,
          reasonCode: object.reasonCode,
        });
      }

      const identities = staged.map<PublishedMediaCacheObjectIdentity>(
        ({ contentType, staged: stagedBlob }) => ({
          byteLength: BigInt(stagedBlob.byteLength),
          detectedMime: contentType.mimeType,
          objectId: stagedBlob.objectId,
          relativeKey: relativeKey(stagedBlob.sha256),
          sha256: stagedBlob.sha256,
        }),
      );
      await this.ledger.recordPublishedObjects({
        leaseToken,
        objects: identities,
        planId,
        publish: async () => {
          for (const item of staged) {
            await this.blobStore.publish(item.staged);
          }
        },
      });
    } catch (error) {
      const failure = classifyPlanFailure(error);
      await this.ledger.failClaimedPostPlan({
        cleanup: () => settleAll(this.blobStore, staged, 'db_rolled_back'),
        disposition:
          failure.disposition === 'retry' ? this.failureRetryDisposition : failure.disposition,
        errorClass: failure.errorClass,
        errorCode: failure.errorCode,
        leaseToken,
        planId,
        ...(failure.conflictingObjectId
          ? { conflictingObjectId: failure.conflictingObjectId }
          : {}),
        ...(failure.reasonCode ? { reasonCode: failure.reasonCode } : {}),
      });
      throw error;
    }

    await settleAll(this.blobStore, staged, 'db_committed');
    await this.ledger.completeSettlement({ leaseToken, planId });
    await this.work.ensureThumbnailObjects(planId);
    return true;
  }

  private async stageFromFirstAvailableSource(
    original: ClaimedMediaCacheOriginal,
    lease: MediaBlobLease,
    sourceMaxBytes: number,
    stageMaxBytes: number,
    signal?: AbortSignal,
  ): Promise<StagedOriginal> {
    if (original.sources.length === 0) {
      throw new PermanentPlanFailure('source_unavailable');
    }
    let finalPermanentError: unknown;
    for (const source of original.sources) {
      signal?.throwIfAborted();
      let staged: StagedMediaBlob | undefined;
      try {
        const opened = await this.source.open({
          fileId: source.fileId,
          maxBytes: sourceMaxBytes,
          ...(signal ? { signal } : {}),
        });
        staged = await this.blobStore.stage({
          lease,
          maxBytes: stageMaxBytes,
          objectId: original.objectId,
          ...(signal ? { signal } : {}),
          source: opened.stream,
        });
        const file = await this.blobStore.openStaged(staged);
        try {
          return {
            contentType: await validateMediaContentType(file, original.kind),
            staged,
          };
        } finally {
          await file.close();
        }
      } catch (error) {
        if (staged) {
          await this.blobStore.settle(staged, 'db_rolled_back');
        }
        if (error instanceof TelegramMediaSourceTooLargeError) {
          throw new PermanentPlanFailure('skipped_kind_limit');
        }
        if (error instanceof MediaBlobTooLargeError) {
          throw new PermanentPlanFailure(
            stageMaxBytes < sourceMaxBytes ? 'skipped_post_limit' : 'skipped_kind_limit',
          );
        }
        if (!isFallbackEligibleSourceFailure(error)) {
          throw error;
        }
        finalPermanentError = error;
      }
    }
    throw new PermanentPlanFailure(permanentSourceReason(finalPermanentError));
  }

  private async recoverPlan(planId: string): Promise<boolean> {
    const leaseToken = this.randomUuid();
    const leaseExpiresAt = new Date(this.now().getTime() + this.leaseDurationMs);
    let recovered: RecoveredMediaCachePostPlan | null;
    try {
      recovered = await this.ledger.recoverExpiredPostPlan({
        leaseExpiresAt,
        leaseOwner: this.leaseOwner,
        leaseToken,
        planId,
        recover: (snapshot) => this.recoverFilesystem(snapshot),
      });
    } catch (error) {
      await this.ledger.markExpiredRecoveryFailed({
        leaseExpiresAt,
        leaseOwner: this.leaseOwner,
        leaseToken,
        planId,
      });
      throw error;
    }
    if (!recovered) {
      return false;
    }
    if (recovered.nextState === 'settling') {
      await this.ledger.completeSettlement({ leaseToken, planId });
      await this.work.ensureThumbnailObjects(planId);
    }
    return true;
  }

  private async recoverFilesystem(snapshot: ExpiredMediaCachePostPlanSnapshot): Promise<void> {
    const previousLease = {
      leaseToken: snapshot.previousLeaseToken,
      planId: snapshot.planId,
    };
    await this.blobStore.discardPartialLease(previousLease);
    const staged = await this.blobStore.recoverLease(previousLease);
    const snapshotByObject = new Map(snapshot.objects.map((object) => [object.objectId, object]));
    if (staged.some((item) => !snapshotByObject.has(item.objectId))) {
      throw new Error('Recovered staging contains an object outside the expired plan');
    }
    if (snapshot.phase === 'precommit') {
      for (const item of staged) {
        await this.blobStore.settle(item, 'db_rolled_back');
      }
      return;
    }

    const stagedByObject = new Map(staged.map((item) => [item.objectId, item]));
    for (const object of snapshot.objects) {
      if (object.actualBytes === null || object.blobSha256 === null) {
        throw new Error('Postcommit recovery is missing a committed blob identity');
      }
      const item = stagedByObject.get(object.objectId);
      if (item) {
        if (BigInt(item.byteLength) !== object.actualBytes || item.sha256 !== object.blobSha256) {
          throw new Error('Recovered staging conflicts with the committed blob identity');
        }
        await this.blobStore.settle(item, 'db_committed');
        continue;
      }
      const file = await this.blobStore.open({
        byteLength: Number(object.actualBytes),
        relativeKey: relativeKey(object.blobSha256),
        sha256: object.blobSha256,
      });
      await verifyOpenBlob(file, object.blobSha256);
    }
  }
}

class PermanentPlanFailure extends Error {
  constructor(
    readonly reasonCode:
      | 'skipped_post_limit'
      | 'skipped_kind_limit'
      | 'source_unavailable'
      | 'unsupported_content'
      | 'upstream_size_limit',
  ) {
    super('Media cache plan cannot be cached from its current source evidence');
    this.name = 'PermanentPlanFailure';
  }
}

function classifyPlanFailure(error: unknown): {
  conflictingObjectId?: string;
  disposition: 'integrity_conflict' | 'retry' | 'skip';
  errorClass: string;
  errorCode: string;
  reasonCode?: string;
} {
  if (error instanceof PermanentPlanFailure) {
    return {
      disposition: 'skip',
      errorClass: 'source',
      errorCode: error.reasonCode,
      reasonCode: error.reasonCode,
    };
  }
  if (error instanceof MediaCacheLedgerError && error.code === 'sticky_hash_conflict') {
    return {
      ...(error.objectId ? { conflictingObjectId: error.objectId } : {}),
      disposition: 'integrity_conflict',
      errorClass: 'integrity',
      errorCode: 'sticky_hash_conflict',
      reasonCode: 'integrity_conflict',
    };
  }
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return {
      disposition: 'retry',
      errorClass: error instanceof TelegramMediaSourceTransientError ? 'source' : 'worker',
      errorCode: stableErrorCode(error.code),
    };
  }
  return {
    disposition: 'retry',
    errorClass: 'worker',
    errorCode: 'unexpected',
  };
}

function permanentSourceReason(
  error: unknown,
): 'source_unavailable' | 'unsupported_content' | 'upstream_size_limit' {
  if (
    error instanceof TelegramMediaSourceTooLargeError ||
    error instanceof MediaBlobTooLargeError
  ) {
    return 'upstream_size_limit';
  }
  if (error instanceof MediaContentTypeError) {
    return 'unsupported_content';
  }
  return 'source_unavailable';
}

function stableErrorCode(value: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : 'unexpected';
}

function thumbnailErrorCode(error: unknown): string {
  if (error instanceof ThumbnailGenerationError) {
    return error.code;
  }
  if (error instanceof MediaBlobTooLargeError) {
    return 'thumbnail_unavailable';
  }
  return 'thumbnail_unavailable';
}

async function verifyOpenBlob(
  file: import('node:fs/promises').FileHandle,
  expectedSha256: string,
): Promise<void> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) {
      hash.update(chunk);
    }
  } finally {
    await file.close();
  }
  if (hash.digest('hex') !== expectedSha256) {
    throw new Error('Recovered media blob checksum does not match the ledger');
  }
}

function isFallbackEligibleSourceFailure(error: unknown): boolean {
  return (
    error instanceof TelegramMediaSourcePermanentError || error instanceof MediaContentTypeError
  );
}

async function settleAll(
  blobStore: MediaCacheWorkerBlobStore,
  staged: readonly StagedOriginal[],
  settlement: 'db_committed' | 'db_rolled_back',
): Promise<void> {
  for (const item of staged) {
    await blobStore.settle(item.staged, settlement);
  }
}

function relativeKey(sha256: string): string {
  return `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

function originalLimit(kind: CacheableMediaKind): number {
  const limit =
    kind === 'photo' ? PHOTO_ORIGINAL_LIMIT_BYTES : ANIMATION_OR_VIDEO_ORIGINAL_LIMIT_BYTES;
  return Number(limit);
}

function assertClaimedOriginalSet(
  claimed: ClaimedMediaCachePostPlan,
  originals: readonly ClaimedMediaCacheOriginal[],
): void {
  if (
    originals.length !== claimed.objectIds.length ||
    originals.some((original, index) => original.objectId !== claimed.objectIds[index])
  ) {
    throw new Error('Claimed media objects changed before source resolution');
  }
}

function assertOptions(leaseOwner: string, leaseDurationMs: number, maxPlansPerRun: number): void {
  if (leaseOwner.length === 0 || leaseOwner.length > 255) {
    throw new TypeError('Media cache worker lease owner must contain 1 to 255 characters');
  }
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new RangeError('Media cache worker lease duration must be a positive safe integer');
  }
  if (
    !Number.isSafeInteger(maxPlansPerRun) ||
    maxPlansPerRun < 1 ||
    maxPlansPerRun > MAX_PLAN_LIMIT
  ) {
    throw new RangeError(`Media cache worker plan limit must be between 1 and ${MAX_PLAN_LIMIT}`);
  }
}
