import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  mediaCacheActions,
  mediaCacheBlobs,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
} from '../db/schema.js';
import type { MediaCacheAccessWriter, MediaCacheBlobAccess } from './access-coalescer.js';
import { MEDIA_CACHE_ADVISORY_LOCK } from './ledger-repository.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_ACCESS_BATCH = 100;
const WORKER_EVICTION_REASON = 'lru_capacity_pressure';

type MediaCacheTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type MediaCacheEvictionInitiator =
  | {
      initiatorId?: string;
      kind: 'local_operator' | 'owner_session';
      reason: string;
    }
  | {
      initiatorId?: string;
      kind: 'worker';
    };

export type MediaCacheEvictionSelection =
  | { kind: 'least_recently_used' }
  | { kind: 'specific_blob'; sha256: string };

export interface ClaimMediaCacheEvictionInput {
  evictionExpiresAt: Date;
  evictionOwner: string;
  evictionToken: string;
  selection: MediaCacheEvictionSelection;
}

export interface ClaimedMediaCacheEviction {
  byteLength: bigint;
  detectedMime: string;
  evictionExpiresAt: Date;
  evictionToken: string;
  lastAccessedAt: Date;
  relativeKey: string;
  sha256: string;
}

export interface CompleteMediaCacheEvictionInput {
  evictionToken: string;
  initiator: MediaCacheEvictionInitiator;
  sha256: string;
}

export interface CompletedMediaCacheEviction {
  evictedObjectIds: string[];
  physicalBytesRemoved: bigint;
  planLogicalBytesRemoved: ReadonlyArray<{ bytes: bigint; planId: string }>;
  readyBytes: bigint;
}

export interface RestoreMediaCacheEvictionInput {
  evictionToken: string;
  sha256: string;
}

export class MediaCacheEvictionError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'ledger_invariant' | 'stale_lease',
    message: string,
  ) {
    super(message);
    this.name = 'MediaCacheEvictionError';
  }
}

export class PostgresMediaCacheEvictionRepository implements MediaCacheAccessWriter {
  constructor(private readonly database: Database) {}

  async writeAccesses(accesses: readonly MediaCacheBlobAccess[]): Promise<void> {
    assertAccessBatch(accesses);
    const latestByHash = new Map<string, Date>();
    for (const access of accesses) {
      const current = latestByHash.get(access.sha256);
      if (!current || current < access.observedAt) {
        latestByHash.set(access.sha256, new Date(access.observedAt));
      }
    }

    await this.database.transaction(async (transaction) => {
      for (const [sha256, observedAt] of [...latestByHash].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        await transaction
          .update(mediaCacheBlobs)
          .set({
            lastAccessedAt: sql`greatest(${mediaCacheBlobs.lastAccessedAt}, ${observedAt.toISOString()}::timestamptz)`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(eq(mediaCacheBlobs.sha256, sha256), eq(mediaCacheBlobs.state, 'ready')));
      }
    });
  }

  async claimEviction(
    input: ClaimMediaCacheEvictionInput,
  ): Promise<ClaimedMediaCacheEviction | null> {
    assertClaimInput(input);

    return this.database.transaction(async (transaction) => {
      await lockLedger(transaction);
      const now = await readDatabaseClock(transaction);
      if (input.evictionExpiresAt <= now) {
        throw new MediaCacheEvictionError(
          'invalid_input',
          'Media cache eviction expiry must be in the future',
        );
      }

      const pinnedBySettlement = transaction
        .select({ one: sql`1` })
        .from(mediaCacheObjects)
        .innerJoin(mediaCachePostPlans, eq(mediaCachePostPlans.id, mediaCacheObjects.postPlanId))
        .where(
          and(
            eq(mediaCacheObjects.blobSha256, mediaCacheBlobs.sha256),
            inArray(mediaCachePostPlans.state, ['recovering', 'settling']),
          ),
        );
      const selectionCondition =
        input.selection.kind === 'specific_blob'
          ? eq(mediaCacheBlobs.sha256, input.selection.sha256)
          : undefined;
      const [blob] = await transaction
        .select({
          byteLength: mediaCacheBlobs.byteLength,
          detectedMime: mediaCacheBlobs.detectedMime,
          lastAccessedAt: mediaCacheBlobs.lastAccessedAt,
          relativeKey: mediaCacheBlobs.relativeKey,
          sha256: mediaCacheBlobs.sha256,
        })
        .from(mediaCacheBlobs)
        .where(
          and(
            eq(mediaCacheBlobs.state, 'ready'),
            selectionCondition,
            notExists(pinnedBySettlement),
          ),
        )
        .orderBy(asc(mediaCacheBlobs.lastAccessedAt), asc(mediaCacheBlobs.sha256))
        .limit(1)
        .for('update');
      if (!blob) {
        return null;
      }

      const [claimed] = await transaction
        .update(mediaCacheBlobs)
        .set({
          evictionExpiresAt: input.evictionExpiresAt,
          evictionOwner: input.evictionOwner.trim(),
          evictionToken: input.evictionToken,
          state: 'deleting',
          updatedAt: now,
        })
        .where(and(eq(mediaCacheBlobs.sha256, blob.sha256), eq(mediaCacheBlobs.state, 'ready')))
        .returning({ sha256: mediaCacheBlobs.sha256 });
      if (!claimed) {
        throw new MediaCacheEvictionError(
          'ledger_invariant',
          'Media cache eviction candidate changed while it was locked',
        );
      }
      return {
        ...blob,
        evictionExpiresAt: new Date(input.evictionExpiresAt),
        evictionToken: input.evictionToken,
      };
    });
  }

  async completeEviction(
    input: CompleteMediaCacheEvictionInput,
  ): Promise<CompletedMediaCacheEviction> {
    assertEvictionIdentity(input.sha256, input.evictionToken);
    const initiator = normalizeInitiator(input.initiator);

    return this.database.transaction(async (transaction) => {
      await lockLedger(transaction);
      const now = await readDatabaseClock(transaction);
      const runtime = await lockRuntime(transaction);
      const blob = await lockFencedDeletingBlob(
        transaction,
        input.sha256,
        input.evictionToken,
        now,
      );
      const objects = await transaction
        .select({
          actualBytes: mediaCacheObjects.actualBytes,
          id: mediaCacheObjects.id,
          postPlanId: mediaCacheObjects.postPlanId,
          state: mediaCacheObjects.state,
          variant: mediaCacheObjects.variant,
        })
        .from(mediaCacheObjects)
        .where(eq(mediaCacheObjects.blobSha256, blob.sha256))
        .orderBy(asc(mediaCacheObjects.id))
        .for('update');
      const readyObjects = objects.filter((object) => object.state === 'ready');
      const originalBytesByPlan = new Map<string, bigint>();
      for (const object of readyObjects) {
        if (object.variant !== 'original') {
          continue;
        }
        if (object.actualBytes === null || object.actualBytes <= 0n) {
          throw new MediaCacheEvictionError(
            'ledger_invariant',
            `Ready media cache object ${object.id} has no positive byte length`,
          );
        }
        originalBytesByPlan.set(
          object.postPlanId,
          (originalBytesByPlan.get(object.postPlanId) ?? 0n) + object.actualBytes,
        );
      }

      const planIds = [...originalBytesByPlan.keys()].sort();
      const plans =
        planIds.length === 0
          ? []
          : await transaction
              .select({
                id: mediaCachePostPlans.id,
                readyOriginalBytes: mediaCachePostPlans.readyOriginalBytes,
              })
              .from(mediaCachePostPlans)
              .where(inArray(mediaCachePostPlans.id, planIds))
              .orderBy(asc(mediaCachePostPlans.id))
              .for('update');
      if (plans.length !== planIds.length) {
        throw new MediaCacheEvictionError(
          'ledger_invariant',
          'A media cache object references a missing post plan',
        );
      }
      for (const plan of plans) {
        const bytes = originalBytesByPlan.get(plan.id);
        if (bytes === undefined || plan.readyOriginalBytes < bytes) {
          throw new MediaCacheEvictionError(
            'ledger_invariant',
            `Post plan ${plan.id} has fewer logical ready bytes than its evicted originals`,
          );
        }
      }
      if (runtime.readyBytes < blob.byteLength) {
        throw new MediaCacheEvictionError(
          'ledger_invariant',
          'Global physical ready bytes are smaller than the evicted blob',
        );
      }

      if (readyObjects.length > 0) {
        await transaction
          .update(mediaCacheObjects)
          .set({
            state: 'evicted',
            updatedAt: now,
          })
          .where(
            inArray(
              mediaCacheObjects.id,
              readyObjects.map((object) => object.id),
            ),
          );
      }
      for (const plan of plans) {
        const bytes = originalBytesByPlan.get(plan.id);
        if (bytes === undefined) {
          throw new MediaCacheEvictionError(
            'ledger_invariant',
            `Post plan ${plan.id} has no eviction accounting entry`,
          );
        }
        await transaction
          .update(mediaCachePostPlans)
          .set({
            readyOriginalBytes: plan.readyOriginalBytes - bytes,
            updatedAt: now,
          })
          .where(eq(mediaCachePostPlans.id, plan.id));
      }
      await transaction
        .update(mediaCacheBlobs)
        .set({
          evictionExpiresAt: null,
          evictionOwner: null,
          evictionToken: null,
          state: 'evicted',
          updatedAt: now,
        })
        .where(eq(mediaCacheBlobs.sha256, blob.sha256));
      const [updatedRuntime] = await transaction
        .update(mediaCacheRuntime)
        .set({
          readyBytes: runtime.readyBytes - blob.byteLength,
          updatedAt: now,
        })
        .where(eq(mediaCacheRuntime.singletonKey, 'local'))
        .returning({ readyBytes: mediaCacheRuntime.readyBytes });
      if (!updatedRuntime) {
        throw new MediaCacheEvictionError(
          'ledger_invariant',
          'Media cache runtime row disappeared',
        );
      }
      await transaction.insert(mediaCacheActions).values({
        actionKind: 'evict',
        afterState: {
          evictedObjectCount: readyObjects.length,
          physicalBytesRemoved: blob.byteLength.toString(),
          state: 'evicted',
        },
        beforeState: {
          byteLength: blob.byteLength.toString(),
          state: 'deleting',
        },
        blobSha256: blob.sha256,
        initiatorId: initiator.initiatorId,
        initiatorKind: initiator.kind,
        reason: initiator.reason,
      });

      return {
        evictedObjectIds: readyObjects.map((object) => object.id),
        physicalBytesRemoved: blob.byteLength,
        planLogicalBytesRemoved: planIds.map((planId) => ({
          bytes: originalBytesByPlan.get(planId) ?? 0n,
          planId,
        })),
        readyBytes: updatedRuntime.readyBytes,
      };
    });
  }

  async restoreEviction(input: RestoreMediaCacheEvictionInput): Promise<void> {
    assertEvictionIdentity(input.sha256, input.evictionToken);

    await this.database.transaction(async (transaction) => {
      await lockLedger(transaction);
      const [blob] = await transaction
        .select({
          evictionToken: mediaCacheBlobs.evictionToken,
          state: mediaCacheBlobs.state,
        })
        .from(mediaCacheBlobs)
        .where(eq(mediaCacheBlobs.sha256, input.sha256))
        .for('update');
      if (blob?.state !== 'deleting' || blob.evictionToken !== input.evictionToken) {
        throw new MediaCacheEvictionError(
          'stale_lease',
          `Media cache blob ${input.sha256} is not held by the supplied eviction token`,
        );
      }
      await transaction
        .update(mediaCacheBlobs)
        .set({
          evictionExpiresAt: null,
          evictionOwner: null,
          evictionToken: null,
          state: 'ready',
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(mediaCacheBlobs.sha256, input.sha256));
    });
  }
}

async function lockLedger(transaction: MediaCacheTransaction): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(${MEDIA_CACHE_ADVISORY_LOCK})`);
}

async function readDatabaseClock(transaction: MediaCacheTransaction): Promise<Date> {
  const [clock] = await transaction.execute<{ now: Date | string }>(
    sql`select clock_timestamp() as now`,
  );
  const now = clock ? new Date(clock.now) : null;
  if (!now || !Number.isFinite(now.getTime())) {
    throw new MediaCacheEvictionError('ledger_invariant', 'PostgreSQL returned an invalid clock');
  }
  return now;
}

async function lockRuntime(transaction: MediaCacheTransaction) {
  await transaction
    .insert(mediaCacheRuntime)
    .values({ singletonKey: 'local' })
    .onConflictDoNothing();
  const [runtime] = await transaction
    .select({
      readyBytes: mediaCacheRuntime.readyBytes,
    })
    .from(mediaCacheRuntime)
    .where(eq(mediaCacheRuntime.singletonKey, 'local'))
    .for('update');
  if (!runtime) {
    throw new MediaCacheEvictionError('ledger_invariant', 'Media cache runtime row is missing');
  }
  return runtime;
}

async function lockFencedDeletingBlob(
  transaction: MediaCacheTransaction,
  sha256: string,
  evictionToken: string,
  now: Date,
) {
  const [blob] = await transaction
    .select({
      byteLength: mediaCacheBlobs.byteLength,
      evictionExpiresAt: mediaCacheBlobs.evictionExpiresAt,
      evictionToken: mediaCacheBlobs.evictionToken,
      sha256: mediaCacheBlobs.sha256,
      state: mediaCacheBlobs.state,
    })
    .from(mediaCacheBlobs)
    .where(eq(mediaCacheBlobs.sha256, sha256))
    .for('update');
  if (
    blob?.state !== 'deleting' ||
    blob.evictionToken !== evictionToken ||
    !blob.evictionExpiresAt ||
    blob.evictionExpiresAt <= now
  ) {
    throw new MediaCacheEvictionError(
      'stale_lease',
      `Media cache blob ${sha256} is not held by the supplied live eviction token`,
    );
  }
  return blob;
}

function assertAccessBatch(accesses: readonly MediaCacheBlobAccess[]): void {
  if (accesses.length > MAX_ACCESS_BATCH) {
    throw new MediaCacheEvictionError(
      'invalid_input',
      `Media cache access batch cannot exceed ${MAX_ACCESS_BATCH} entries`,
    );
  }
  for (const access of accesses) {
    if (!SHA256.test(access.sha256) || !Number.isFinite(access.observedAt.getTime())) {
      throw new MediaCacheEvictionError(
        'invalid_input',
        'Media cache access entries require a canonical SHA-256 and valid timestamp',
      );
    }
  }
}

function assertClaimInput(input: ClaimMediaCacheEvictionInput): void {
  assertEvictionIdentity(
    input.selection.kind === 'specific_blob' ? input.selection.sha256 : '0'.repeat(64),
    input.evictionToken,
  );
  const owner = input.evictionOwner.trim();
  if (
    owner.length === 0 ||
    owner.length > 255 ||
    !Number.isFinite(input.evictionExpiresAt.getTime())
  ) {
    throw new MediaCacheEvictionError(
      'invalid_input',
      'Media cache eviction requires a bounded owner and expiry',
    );
  }
}

function assertEvictionIdentity(sha256: string, evictionToken: string): void {
  if (!SHA256.test(sha256) || !UUID.test(evictionToken)) {
    throw new MediaCacheEvictionError(
      'invalid_input',
      'Media cache eviction requires a canonical SHA-256 and UUID token',
    );
  }
}

function normalizeInitiator(initiator: MediaCacheEvictionInitiator): {
  initiatorId: string | null;
  kind: 'local_operator' | 'owner_session' | 'worker';
  reason: string;
} {
  const initiatorId = initiator.initiatorId?.trim() || null;
  if (initiatorId && initiatorId.length > 255) {
    throw new MediaCacheEvictionError(
      'invalid_input',
      'Media cache eviction initiator ID is too long',
    );
  }
  if (initiator.kind === 'worker') {
    return {
      initiatorId,
      kind: initiator.kind,
      reason: WORKER_EVICTION_REASON,
    };
  }
  const reason = initiator.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new MediaCacheEvictionError(
      'invalid_input',
      'Owner and local media cache evictions require a 1-500 character reason',
    );
  }
  return {
    initiatorId,
    kind: initiator.kind,
    reason,
  };
}
