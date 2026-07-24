import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  mediaBlobLocations,
  mediaCacheActions,
  mediaCacheBlobs,
  mediaCacheObjectProtections,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  mediaStorageBackends,
} from '../db/schema.js';
import type { MediaBlobIdentity } from './blob-store.js';
import type { CommandStorageOperationInput, CommandStoragePruneResult } from './command-queue.js';
import { MEDIA_CACHE_ADVISORY_LOCK } from './ledger-lock.js';
import type {
  PersistentBlobBackendRegistry,
  PersistentStorageBackendId,
} from './local-persistent-blob-backend.js';
import { STORAGE_PRUNE_MUTATION_OWNER } from './storage-ledger-repository.js';

const MAX_PRUNE_BATCH = 100;
const PRUNE_LEASE_MS = 5 * 60_000;

type StoragePruneTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

interface StoragePruneCandidate extends MediaBlobIdentity {
  lastAccessedAt: Date;
}

interface ClaimedStoragePrune extends StoragePruneCandidate {
  backendId: PersistentStorageBackendId;
  mutationToken: string;
}

interface StoragePruneClaimResult {
  claim: ClaimedStoragePrune | null;
  readyBytes: bigint;
}

export interface StoragePrunePreview {
  candidates: number;
  hasMore: boolean;
  projectedReadyBytes: string;
  readyBytes: string;
  removableBytes: string;
  targetBackendId: string;
  targetBytes: string;
}

export interface StoragePruneApplyInput {
  command: {
    initiatorId: string;
    initiatorKind: CommandStorageOperationInput<'prune'>['command']['initiatorKind'] | 'worker';
    operation: 'prune';
    reason: string;
    targetBackendId: string;
    targetBytes: bigint;
  };
  renewLease(): Promise<void>;
  signal?: AbortSignal;
}

export class StoragePruneLeaseError extends Error {
  constructor() {
    super('The media storage prune lease is stale');
    this.name = 'StoragePruneLeaseError';
  }
}

export class PostgresStoragePruneService {
  constructor(
    private readonly database: Database,
    private readonly backends: PersistentBlobBackendRegistry,
  ) {}

  /**
   * Plans against the current location ledger without taking a lease or writing audit state.
   * Callers must not bootstrap storage or enqueue a durable command as part of a preview.
   */
  async preview(input: {
    targetBackendId: string;
    targetBytes: bigint;
  }): Promise<StoragePrunePreview> {
    assertTargetBytes(input.targetBytes);
    const now = await readDatabaseClock(this.database);
    const backend = await readPruneBackend(this.database, input.targetBackendId);
    const candidates = await listPruneCandidates(this.database, backend.id, now, MAX_PRUNE_BATCH);
    let projectedReadyBytes = backend.readyBytes;
    let removableBytes = 0n;
    let selected = 0;
    for (const candidate of candidates) {
      if (projectedReadyBytes <= input.targetBytes) break;
      const byteLength = BigInt(candidate.byteLength);
      if (byteLength > projectedReadyBytes) {
        throw new Error('Media storage backend bytes are smaller than its prune candidates');
      }
      projectedReadyBytes -= byteLength;
      removableBytes += byteLength;
      selected += 1;
    }
    return {
      candidates: selected,
      hasMore: projectedReadyBytes > input.targetBytes,
      projectedReadyBytes: projectedReadyBytes.toString(),
      readyBytes: backend.readyBytes.toString(),
      removableBytes: removableBytes.toString(),
      targetBackendId: backend.id,
      targetBytes: input.targetBytes.toString(),
    };
  }

  async apply(input: StoragePruneApplyInput): Promise<CommandStoragePruneResult> {
    assertTargetBytes(input.command.targetBytes);
    const backend = this.backends.get(input.command.targetBackendId);
    let prunedBlobCount = 0;
    let prunedBytes = 0n;
    let initialReadyBytes: bigint | null = null;

    for (let index = 0; index < MAX_PRUNE_BATCH; index += 1) {
      input.signal?.throwIfAborted();
      await input.renewLease();
      const planned = await this.claimNext({
        backendId: backend.id,
        targetBytes: input.command.targetBytes,
      });
      initialReadyBytes ??= planned.readyBytes;
      if (!planned.claim) break;

      await backend.delete(
        toBlobIdentity(planned.claim),
        input.signal ? { signal: input.signal } : {},
      );
      const finalized = await this.finalize(planned.claim, input.command);
      prunedBlobCount += 1;
      prunedBytes += BigInt(planned.claim.byteLength);
      if (finalized.readyBytes <= input.command.targetBytes) break;
    }

    const readyBytes = await this.readBackendReadyBytes(backend.id);
    return {
      alreadyApplied:
        prunedBlobCount === 0 &&
        initialReadyBytes !== null &&
        initialReadyBytes <= input.command.targetBytes,
      hasMore: readyBytes > input.command.targetBytes,
      prunedBlobCount,
      prunedBytes: prunedBytes.toString(),
      readyBytes: readyBytes.toString(),
      targetBackendId: backend.id,
    };
  }

  private async claimNext(input: {
    backendId: PersistentStorageBackendId;
    targetBytes: bigint;
  }): Promise<StoragePruneClaimResult> {
    return this.database.transaction(async (transaction) => {
      await lockStorageLedger(transaction);
      const now = await readDatabaseClock(transaction);
      const backend = await lockPruneBackend(transaction, input.backendId);
      if (backend.readyBytes <= input.targetBytes) {
        return { claim: null, readyBytes: backend.readyBytes };
      }

      const [candidate] = await listPruneCandidates(transaction, backend.id, now, 1, true);
      if (!candidate) {
        return { claim: null, readyBytes: backend.readyBytes };
      }
      const mutationToken = randomUUID();
      const [claimed] = await transaction
        .update(mediaBlobLocations)
        .set({
          mutationExpiresAt: new Date(now.getTime() + PRUNE_LEASE_MS),
          mutationOwner: STORAGE_PRUNE_MUTATION_OWNER,
          mutationToken,
          state: 'deleting',
          updatedAt: now,
        })
        .where(
          and(
            eq(mediaBlobLocations.backendId, backend.id),
            eq(mediaBlobLocations.blobSha256, candidate.sha256),
            or(
              eq(mediaBlobLocations.state, 'ready'),
              and(
                eq(mediaBlobLocations.state, 'deleting'),
                lte(mediaBlobLocations.mutationExpiresAt, now),
              ),
            ),
          ),
        )
        .returning({ blobSha256: mediaBlobLocations.blobSha256 });
      if (!claimed) {
        throw new StoragePruneLeaseError();
      }
      return {
        claim: {
          ...candidate,
          backendId: backend.id,
          mutationToken,
        },
        readyBytes: backend.readyBytes,
      };
    });
  }

  private async finalize(
    claim: ClaimedStoragePrune,
    command: StoragePruneApplyInput['command'],
  ): Promise<{ readyBytes: bigint }> {
    return this.database.transaction(async (transaction) => {
      await lockStorageLedger(transaction);
      const now = await readDatabaseClock(transaction);
      const [location] = await transaction
        .select({
          mutationExpiresAt: mediaBlobLocations.mutationExpiresAt,
          mutationToken: mediaBlobLocations.mutationToken,
          state: mediaBlobLocations.state,
          verifiedByteLength: mediaBlobLocations.verifiedByteLength,
          verifiedSha256: mediaBlobLocations.verifiedSha256,
        })
        .from(mediaBlobLocations)
        .where(
          and(
            eq(mediaBlobLocations.backendId, claim.backendId),
            eq(mediaBlobLocations.blobSha256, claim.sha256),
          ),
        )
        .for('update');
      if (
        location?.state !== 'deleting' ||
        location.mutationToken !== claim.mutationToken ||
        !location.mutationExpiresAt ||
        location.mutationExpiresAt <= now ||
        location.verifiedByteLength !== BigInt(claim.byteLength) ||
        location.verifiedSha256 !== claim.sha256
      ) {
        throw new StoragePruneLeaseError();
      }
      const backend = await lockPruneBackend(transaction, claim.backendId);
      const byteLength = BigInt(claim.byteLength);
      if (backend.readyBytes < byteLength) {
        throw new Error('Media storage backend bytes are smaller than the pruned blob');
      }

      const hasOtherHealthyLocation = await readHasOtherHealthyLocation(transaction, claim);
      const settlementPinned = await readSettlementPinned(transaction, claim.sha256);
      let evictedObjectCount = 0;
      if (!hasOtherHealthyLocation && !settlementPinned) {
        evictedObjectCount = await finalizeLogicalEviction(transaction, claim.sha256, now);
      }
      if (claim.backendId === 'local') {
        await decrementLegacyLocalReadyBytes(transaction, byteLength, now);
      }

      const [evicted] = await transaction
        .update(mediaBlobLocations)
        .set({
          mutationExpiresAt: null,
          mutationOwner: null,
          mutationToken: null,
          providerChecksumSha256: null,
          providerEtag: null,
          providerVersionId: null,
          state: 'evicted',
          updatedAt: now,
          verifiedAt: null,
          verifiedByteLength: null,
          verifiedSha256: null,
        })
        .where(
          and(
            eq(mediaBlobLocations.backendId, claim.backendId),
            eq(mediaBlobLocations.blobSha256, claim.sha256),
            eq(mediaBlobLocations.state, 'deleting'),
            eq(mediaBlobLocations.mutationToken, claim.mutationToken),
          ),
        )
        .returning({ blobSha256: mediaBlobLocations.blobSha256 });
      if (!evicted) throw new StoragePruneLeaseError();

      const [updatedBackend] = await transaction
        .update(mediaStorageBackends)
        .set({
          readyBytes: backend.readyBytes - byteLength,
          updatedAt: now,
        })
        .where(eq(mediaStorageBackends.id, claim.backendId))
        .returning({ readyBytes: mediaStorageBackends.readyBytes });
      if (!updatedBackend) {
        throw new Error('Media storage backend disappeared during prune finalization');
      }
      await transaction.insert(mediaCacheActions).values({
        actionKind: 'prune',
        afterState: {
          backendId: claim.backendId,
          evictedObjectCount,
          lastHealthyLocation: !hasOtherHealthyLocation,
          logicalEvictionDeferred: settlementPinned && !hasOtherHealthyLocation,
          physicalBytesRemoved: byteLength.toString(),
          state: 'evicted',
        },
        beforeState: {
          backendId: claim.backendId,
          byteLength: byteLength.toString(),
          state: 'deleting',
        },
        blobSha256: claim.sha256,
        initiatorId: command.initiatorId,
        initiatorKind: command.initiatorKind,
        reason: command.reason,
      });
      return { readyBytes: updatedBackend.readyBytes };
    });
  }

  private async readBackendReadyBytes(backendId: string): Promise<bigint> {
    const backend = await readPruneBackend(this.database, backendId);
    return backend.readyBytes;
  }
}

async function listPruneCandidates(
  database: Database | StoragePruneTransaction,
  backendId: PersistentStorageBackendId,
  now: Date,
  limit: number,
  lock = false,
): Promise<StoragePruneCandidate[]> {
  const activeProtection = database
    .select({ one: sql`1` })
    .from(mediaCacheObjects)
    .innerJoin(
      mediaCacheObjectProtections,
      eq(mediaCacheObjectProtections.objectId, mediaCacheObjects.id),
    )
    .where(
      and(
        eq(mediaCacheObjects.blobSha256, mediaBlobLocations.blobSha256),
        or(
          isNull(mediaCacheObjectProtections.expiresAt),
          gt(mediaCacheObjectProtections.expiresAt, now),
        ),
      ),
    );
  const pinnedBySettlement = database
    .select({ one: sql`1` })
    .from(mediaCacheObjects)
    .innerJoin(mediaCachePostPlans, eq(mediaCachePostPlans.id, mediaCacheObjects.postPlanId))
    .where(
      and(
        eq(mediaCacheObjects.blobSha256, mediaBlobLocations.blobSha256),
        inArray(mediaCachePostPlans.state, ['recovering', 'settling']),
      ),
    );
  const query = database
    .select({
      byteLength: mediaCacheBlobs.byteLength,
      lastAccessedAt: mediaBlobLocations.lastAccessedAt,
      relativeKey: mediaCacheBlobs.relativeKey,
      sha256: mediaCacheBlobs.sha256,
    })
    .from(mediaBlobLocations)
    .innerJoin(mediaCacheBlobs, eq(mediaCacheBlobs.sha256, mediaBlobLocations.blobSha256))
    .where(
      and(
        eq(mediaBlobLocations.backendId, backendId),
        or(
          eq(mediaBlobLocations.state, 'ready'),
          and(
            eq(mediaBlobLocations.state, 'deleting'),
            lte(mediaBlobLocations.mutationExpiresAt, now),
          ),
        ),
        eq(mediaBlobLocations.verifiedByteLength, mediaCacheBlobs.byteLength),
        eq(mediaBlobLocations.verifiedSha256, mediaCacheBlobs.sha256),
        notExists(activeProtection),
        notExists(pinnedBySettlement),
        sql`not exists (
          select 1
          from ${mediaBlobLocations} other_location
          where other_location.blob_sha256 = ${mediaBlobLocations.blobSha256}
            and other_location.backend_id <> ${backendId}
            and other_location.state = 'copying'
            and other_location.mutation_expires_at > ${now.toISOString()}::timestamptz
        )`,
      ),
    )
    .orderBy(
      sql`case when ${mediaBlobLocations.state} = 'deleting' then 0 else 1 end`,
      asc(mediaBlobLocations.lastAccessedAt),
      asc(mediaBlobLocations.blobSha256),
    )
    .limit(limit);
  const rows = lock ? await query.for('update') : await query;
  return rows.map(toPruneCandidate);
}

async function readHasOtherHealthyLocation(
  transaction: StoragePruneTransaction,
  claim: ClaimedStoragePrune,
): Promise<boolean> {
  const [location] = await transaction.execute<{ one: number }>(sql`
    select 1 as one
    from ${mediaBlobLocations} other_location
    inner join ${mediaStorageBackends} other_backend
      on other_backend.id = other_location.backend_id
    where other_location.blob_sha256 = ${claim.sha256}
      and other_location.backend_id <> ${claim.backendId}
      and other_location.state = 'ready'
      and other_location.verified_byte_length = ${BigInt(claim.byteLength)}
      and other_location.verified_sha256 = ${claim.sha256}
      and other_backend.enabled
      and other_backend.readable
    limit 1
  `);
  return Boolean(location);
}

async function readSettlementPinned(
  transaction: StoragePruneTransaction,
  sha256: string,
): Promise<boolean> {
  const [pinned] = await transaction
    .select({ id: mediaCachePostPlans.id })
    .from(mediaCacheObjects)
    .innerJoin(mediaCachePostPlans, eq(mediaCachePostPlans.id, mediaCacheObjects.postPlanId))
    .where(
      and(
        eq(mediaCacheObjects.blobSha256, sha256),
        inArray(mediaCachePostPlans.state, ['recovering', 'settling']),
      ),
    )
    .limit(1)
    .for('update');
  return Boolean(pinned);
}

async function finalizeLogicalEviction(
  transaction: StoragePruneTransaction,
  sha256: string,
  now: Date,
): Promise<number> {
  const [blob] = await transaction
    .select({ state: mediaCacheBlobs.state })
    .from(mediaCacheBlobs)
    .where(eq(mediaCacheBlobs.sha256, sha256))
    .for('update');
  if (!blob) throw new Error('Pruned media storage location references a missing blob');

  const objects = await transaction
    .select({
      actualBytes: mediaCacheObjects.actualBytes,
      id: mediaCacheObjects.id,
      postPlanId: mediaCacheObjects.postPlanId,
      state: mediaCacheObjects.state,
      variant: mediaCacheObjects.variant,
    })
    .from(mediaCacheObjects)
    .where(eq(mediaCacheObjects.blobSha256, sha256))
    .orderBy(asc(mediaCacheObjects.id))
    .for('update');
  const readyObjects = objects.filter((object) => object.state === 'ready');
  const originalBytesByPlan = new Map<string, bigint>();
  for (const object of readyObjects) {
    if (object.variant !== 'original') continue;
    if (object.actualBytes === null || object.actualBytes <= 0n) {
      throw new Error(`Ready media cache object ${object.id} has no positive byte length`);
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
    throw new Error('A pruned media cache object references a missing post plan');
  }
  for (const plan of plans) {
    const bytes = originalBytesByPlan.get(plan.id);
    if (bytes === undefined || plan.readyOriginalBytes < bytes) {
      throw new Error(
        `Post plan ${plan.id} has fewer logical ready bytes than its pruned originals`,
      );
    }
  }

  if (readyObjects.length > 0) {
    await transaction
      .update(mediaCacheObjects)
      .set({ state: 'evicted', updatedAt: now })
      .where(
        inArray(
          mediaCacheObjects.id,
          readyObjects.map((object) => object.id),
        ),
      );
  }
  for (const plan of plans) {
    const bytes = originalBytesByPlan.get(plan.id);
    if (bytes === undefined) throw new Error('Prune plan accounting disappeared');
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
    .where(eq(mediaCacheBlobs.sha256, sha256));
  return readyObjects.length;
}

async function decrementLegacyLocalReadyBytes(
  transaction: StoragePruneTransaction,
  byteLength: bigint,
  now: Date,
): Promise<void> {
  await transaction
    .insert(mediaCacheRuntime)
    .values({ singletonKey: 'local' })
    .onConflictDoNothing();
  const [runtime] = await transaction
    .select({ readyBytes: mediaCacheRuntime.readyBytes })
    .from(mediaCacheRuntime)
    .where(eq(mediaCacheRuntime.singletonKey, 'local'))
    .for('update');
  if (!runtime || runtime.readyBytes < byteLength) {
    throw new Error('Local media cache bytes are smaller than the pruned blob');
  }
  const [updated] = await transaction
    .update(mediaCacheRuntime)
    .set({ readyBytes: runtime.readyBytes - byteLength, updatedAt: now })
    .where(eq(mediaCacheRuntime.singletonKey, 'local'))
    .returning({ singletonKey: mediaCacheRuntime.singletonKey });
  if (!updated) throw new Error('Local media cache runtime disappeared during prune');
}

async function lockPruneBackend(
  transaction: StoragePruneTransaction,
  backendId: string,
): Promise<{
  id: PersistentStorageBackendId;
  readyBytes: bigint;
}> {
  const [backend] = await transaction
    .select({
      enabled: mediaStorageBackends.enabled,
      id: mediaStorageBackends.id,
      readyBytes: mediaStorageBackends.readyBytes,
      writable: mediaStorageBackends.writable,
    })
    .from(mediaStorageBackends)
    .where(eq(mediaStorageBackends.id, backendId))
    .for('update');
  return normalizePruneBackend(backend);
}

async function readPruneBackend(
  database: Database | StoragePruneTransaction,
  backendId: string,
): Promise<{
  id: PersistentStorageBackendId;
  readyBytes: bigint;
}> {
  const [backend] = await database
    .select({
      enabled: mediaStorageBackends.enabled,
      id: mediaStorageBackends.id,
      readyBytes: mediaStorageBackends.readyBytes,
      writable: mediaStorageBackends.writable,
    })
    .from(mediaStorageBackends)
    .where(eq(mediaStorageBackends.id, backendId))
    .limit(1);
  return normalizePruneBackend(backend);
}

function normalizePruneBackend(
  backend:
    | {
        enabled: boolean;
        id: string;
        readyBytes: bigint;
        writable: boolean;
      }
    | undefined,
): {
  id: PersistentStorageBackendId;
  readyBytes: bigint;
} {
  if (!backend || (backend.id !== 'local' && backend.id !== 's3-default')) {
    throw new Error('Media storage prune backend is unavailable');
  }
  if (!backend.enabled || !backend.writable) {
    throw new Error('Media storage prune backend is not writable');
  }
  return { id: backend.id, readyBytes: backend.readyBytes };
}

async function lockStorageLedger(transaction: StoragePruneTransaction): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(${MEDIA_CACHE_ADVISORY_LOCK})`);
}

async function readDatabaseClock(
  database: Pick<Database, 'execute'> | StoragePruneTransaction,
): Promise<Date> {
  const [clock] = await database.execute<{ now: Date | string }>(
    sql`select clock_timestamp() as now`,
  );
  const now = clock ? new Date(clock.now) : null;
  if (!now || !Number.isFinite(now.getTime())) {
    throw new Error('PostgreSQL returned an invalid storage prune clock');
  }
  return now;
}

function toPruneCandidate(row: {
  byteLength: bigint;
  lastAccessedAt: Date;
  relativeKey: string;
  sha256: string;
}): StoragePruneCandidate {
  const byteLength = Number(row.byteLength);
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new Error('Media storage prune byte length is not safely representable');
  }
  return {
    byteLength,
    lastAccessedAt: row.lastAccessedAt,
    relativeKey: row.relativeKey,
    sha256: row.sha256,
  };
}

function toBlobIdentity(candidate: StoragePruneCandidate): MediaBlobIdentity {
  return {
    byteLength: candidate.byteLength,
    relativeKey: candidate.relativeKey,
    sha256: candidate.sha256,
  };
}

function assertTargetBytes(targetBytes: bigint): void {
  if (targetBytes < 0n) {
    throw new RangeError('Media storage prune target bytes must not be negative');
  }
}
