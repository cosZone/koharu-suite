import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  mediaCacheBlobs,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  messageMedia,
} from '../db/schema.js';

export const MEDIA_CACHE_ADVISORY_LOCK = 6_309_648_946_926_691;
const MIB = 1024n * 1024n;
const POST_MAX_BYTES = 50n * MIB;
const ORIGINAL_LIMITS = {
  animation: 20n * MIB,
  photo: 10n * MIB,
  video: 20n * MIB,
} as const;
const DETECTED_MEDIA_MIMES = new Set<DetectedMediaMime>([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type MediaCacheTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type DetectedMediaMime =
  | 'image/avif'
  | 'image/gif'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'video/mp4'
  | 'video/webm';

export interface ClaimMediaCachePostPlanInput {
  leaseExpiresAt: Date;
  leaseOwner: string;
  leaseToken: string;
  planId: string;
}

export interface ClaimedMediaCachePostPlan {
  objectIds: string[];
  planId: string;
  requestedBytes: bigint;
}

export interface PublishedMediaCacheObjectIdentity {
  byteLength: bigint;
  detectedMime: DetectedMediaMime;
  objectId: string;
  relativeKey: string;
  sha256: string;
}

export interface RecordPublishedMediaCacheObjectsInput {
  leaseToken: string;
  objects: readonly PublishedMediaCacheObjectIdentity[];
  planId: string;
  publish: () => Promise<void>;
}

export interface CompleteMediaCacheSettlementInput {
  leaseToken: string;
  planId: string;
}

export interface RecoverExpiredMediaCachePostPlanInput {
  leaseExpiresAt: Date;
  leaseOwner: string;
  leaseToken: string;
  planId: string;
  recover: (snapshot: ExpiredMediaCachePostPlanSnapshot) => Promise<void>;
}

export interface ExpiredMediaCachePostPlanSnapshot {
  objects: Array<{
    actualBytes: bigint | null;
    blobSha256: string | null;
    objectId: string;
  }>;
  phase: 'postcommit' | 'precommit';
  planId: string;
  previousLeaseToken: string;
}

export type RecoveredMediaCachePostPlan =
  | {
      nextState: 'retry_wait';
      planId: string;
      releasedReservationBytes: bigint;
    }
  | {
      leaseToken: string;
      nextState: 'settling';
      planId: string;
      releasedReservationBytes: 0n;
    };

export class MediaCacheLedgerError extends Error {
  constructor(
    readonly code:
      | 'blob_deleting'
      | 'blob_identity_conflict'
      | 'invalid_input'
      | 'invalid_transition'
      | 'ledger_invariant'
      | 'stale_lease'
      | 'sticky_hash_conflict',
    message: string,
  ) {
    super(message);
    this.name = 'MediaCacheLedgerError';
  }
}

export class PostgresMediaCacheLedgerRepository {
  constructor(private readonly database: Database) {}

  async claimPostPlan(
    input: ClaimMediaCachePostPlanInput,
  ): Promise<ClaimedMediaCachePostPlan | null> {
    assertLeaseInput(input);

    return this.database.transaction(async (transaction) => {
      await lockLedger(transaction);
      const now = await readDatabaseClock(transaction);
      assertLiveLeaseExpiry(input.leaseExpiresAt, now);
      const runtime = await lockRuntime(transaction);
      const [plan] = await transaction
        .select({
          id: mediaCachePostPlans.id,
        })
        .from(mediaCachePostPlans)
        .where(
          and(
            eq(mediaCachePostPlans.id, input.planId),
            inArray(mediaCachePostPlans.state, ['discovered', 'retry_wait']),
            eq(mediaCachePostPlans.reservedOriginalBytes, 0n),
          ),
        )
        .for('update');
      if (!plan) {
        return null;
      }

      const objects = await transaction
        .select({
          id: mediaCacheObjects.id,
          kind: messageMedia.kind,
          position: messageMedia.position,
          availableAt: mediaCacheObjects.availableAt,
          state: mediaCacheObjects.state,
        })
        .from(mediaCacheObjects)
        .innerJoin(messageMedia, eq(mediaCacheObjects.canonicalMediaId, messageMedia.id))
        .where(
          and(eq(mediaCacheObjects.postPlanId, plan.id), eq(mediaCacheObjects.variant, 'original')),
        )
        .orderBy(asc(messageMedia.position), asc(mediaCacheObjects.id))
        .for('update', { of: mediaCacheObjects });
      const reservable = objects.flatMap((object) => {
        if (object.state === 'skipped') {
          return [];
        }
        const limit = ORIGINAL_LIMITS[object.kind as keyof typeof ORIGINAL_LIMITS];
        return limit ? [{ ...object, limit }] : [];
      });
      if (
        reservable.length === 0 ||
        reservable.length !== objects.filter((object) => object.state !== 'skipped').length ||
        reservable.some(
          (object) =>
            (object.state !== 'discovered' && object.state !== 'retry_wait') ||
            object.availableAt > now,
        )
      ) {
        return null;
      }

      const requestedBytes = reservable.reduce((total, object) => total + object.limit, 0n);
      const cappedRequestedBytes =
        requestedBytes > POST_MAX_BYTES ? POST_MAX_BYTES : requestedBytes;
      if (runtime.readyBytes + runtime.reservedBytes + cappedRequestedBytes > runtime.maxBytes) {
        return null;
      }

      const [updatedRuntime] = await transaction
        .update(mediaCacheRuntime)
        .set({
          reservedBytes: runtime.reservedBytes + cappedRequestedBytes,
          updatedAt: now,
        })
        .where(eq(mediaCacheRuntime.singletonKey, 'local'))
        .returning({
          singletonKey: mediaCacheRuntime.singletonKey,
        });
      if (!updatedRuntime) {
        throw new MediaCacheLedgerError('ledger_invariant', 'Media cache runtime row disappeared');
      }

      await transaction
        .update(mediaCachePostPlans)
        .set({
          leaseExpiresAt: input.leaseExpiresAt,
          leaseOwner: input.leaseOwner.trim(),
          leaseToken: input.leaseToken,
          reservedOriginalBytes: cappedRequestedBytes,
          state: 'staging',
          updatedAt: now,
        })
        .where(eq(mediaCachePostPlans.id, plan.id));

      for (const object of reservable) {
        await transaction
          .update(mediaCacheObjects)
          .set({
            leaseExpiresAt: input.leaseExpiresAt,
            leaseOwner: input.leaseOwner.trim(),
            leaseToken: input.leaseToken,
            reservedBytes: object.limit,
            state: 'downloading',
            updatedAt: now,
          })
          .where(eq(mediaCacheObjects.id, object.id));
      }

      return {
        objectIds: reservable.map((object) => object.id),
        planId: plan.id,
        requestedBytes: cappedRequestedBytes,
      };
    });
  }

  async recordPublishedObjects(input: RecordPublishedMediaCacheObjectsInput): Promise<{
    physicalBytesAdded: bigint;
    readyBytes: bigint;
    reservedBytes: bigint;
  }> {
    assertPlanAndToken(input.planId, input.leaseToken);
    assertPublishedObjects(input.objects);
    const publishedObjects = input.objects.map((object) => ({ ...object }));

    return this.database.transaction(async (transaction) => {
      await lockLedger(transaction);
      const now = await readDatabaseClock(transaction);
      const runtime = await lockRuntime(transaction);
      const plan = await lockFencedPlan(
        transaction,
        input.planId,
        input.leaseToken,
        now,
        'staging',
      );
      const objects = await transaction
        .select({
          blobSha256: mediaCacheObjects.blobSha256,
          id: mediaCacheObjects.id,
          kind: messageMedia.kind,
          leaseExpiresAt: mediaCacheObjects.leaseExpiresAt,
          leaseToken: mediaCacheObjects.leaseToken,
          reservedBytes: mediaCacheObjects.reservedBytes,
          state: mediaCacheObjects.state,
        })
        .from(mediaCacheObjects)
        .innerJoin(messageMedia, eq(mediaCacheObjects.canonicalMediaId, messageMedia.id))
        .where(
          and(eq(mediaCacheObjects.postPlanId, plan.id), eq(mediaCacheObjects.variant, 'original')),
        )
        .orderBy(asc(mediaCacheObjects.id))
        .for('update', { of: mediaCacheObjects });
      const claimedObjects = objects.filter((object) => object.state !== 'skipped');
      if (
        claimedObjects.length === 0 ||
        objects.some(
          (object) =>
            object.state !== 'skipped' &&
            (object.state !== 'downloading' ||
              object.leaseToken !== input.leaseToken ||
              !object.leaseExpiresAt ||
              object.leaseExpiresAt <= now),
        )
      ) {
        throw new MediaCacheLedgerError(
          'invalid_transition',
          'The plan does not have a complete fenced original object set',
        );
      }

      const inputByObjectId = new Map(publishedObjects.map((object) => [object.objectId, object]));
      if (
        claimedObjects.length !== publishedObjects.length ||
        claimedObjects.some((object) => !inputByObjectId.has(object.id))
      ) {
        throw new MediaCacheLedgerError(
          'invalid_transition',
          'Published objects must exactly match the claimed original objects',
        );
      }

      for (const object of claimedObjects) {
        const published = inputByObjectId.get(object.id);
        if (!published) {
          throw new MediaCacheLedgerError('invalid_transition', 'Published object is missing');
        }
        const kindLimit = ORIGINAL_LIMITS[object.kind as keyof typeof ORIGINAL_LIMITS];
        if (
          !kindLimit ||
          published.byteLength > object.reservedBytes ||
          published.byteLength > kindLimit
        ) {
          throw new MediaCacheLedgerError(
            'invalid_transition',
            `Published object ${object.id} exceeds its reserved or kind byte limit`,
          );
        }
        if (object.blobSha256 && object.blobSha256 !== published.sha256) {
          throw new MediaCacheLedgerError(
            'sticky_hash_conflict',
            `Media cache object ${object.id} is already bound to another blob`,
          );
        }
      }

      const uniqueBlobs = collapsePublishedBlobs(publishedObjects);
      let physicalBytesAdded = 0n;
      const existingBlobs = new Map<
        string,
        {
          byteLength: bigint;
          detectedMime: string;
          relativeKey: string;
          state: 'deleting' | 'evicted' | 'missing' | 'ready';
        }
      >();
      for (const blob of uniqueBlobs) {
        const [existing] = await transaction
          .select({
            byteLength: mediaCacheBlobs.byteLength,
            detectedMime: mediaCacheBlobs.detectedMime,
            relativeKey: mediaCacheBlobs.relativeKey,
            sha256: mediaCacheBlobs.sha256,
            state: mediaCacheBlobs.state,
          })
          .from(mediaCacheBlobs)
          .where(eq(mediaCacheBlobs.sha256, blob.sha256))
          .for('update');
        if (!existing) {
          physicalBytesAdded += blob.byteLength;
          continue;
        }
        existingBlobs.set(blob.sha256, existing);
        if (
          existing.byteLength !== blob.byteLength ||
          existing.detectedMime !== blob.detectedMime ||
          existing.relativeKey !== blob.relativeKey
        ) {
          throw new MediaCacheLedgerError(
            'blob_identity_conflict',
            `Blob ${blob.sha256} has conflicting immutable metadata`,
          );
        }
        if (existing.state === 'deleting') {
          throw new MediaCacheLedgerError(
            'blob_deleting',
            `Blob ${blob.sha256} is being evicted and must be retried`,
          );
        }
        if (existing.state !== 'ready') {
          physicalBytesAdded += blob.byteLength;
        }
      }

      if (runtime.readyBytes + physicalBytesAdded > runtime.maxBytes) {
        throw new MediaCacheLedgerError(
          'ledger_invariant',
          'Publishing would exceed the configured physical media cache limit',
        );
      }

      await input.publish();
      const postPublishNow = await readDatabaseClock(transaction);
      assertFencedRowsRemainLive(plan, claimedObjects, input.leaseToken, postPublishNow);
      for (const object of claimedObjects) {
        const published = inputByObjectId.get(object.id);
        const kindLimit = ORIGINAL_LIMITS[object.kind as keyof typeof ORIGINAL_LIMITS];
        if (
          !published ||
          !kindLimit ||
          published.byteLength > object.reservedBytes ||
          published.byteLength > kindLimit
        ) {
          throw new MediaCacheLedgerError(
            'invalid_transition',
            `Published object ${object.id} exceeds its reserved or kind byte limit`,
          );
        }
      }

      for (const blob of uniqueBlobs) {
        const existing = existingBlobs.get(blob.sha256);
        if (!existing) {
          await transaction.insert(mediaCacheBlobs).values({
            byteLength: blob.byteLength,
            detectedMime: blob.detectedMime,
            relativeKey: blob.relativeKey,
            sha256: blob.sha256,
            state: 'ready',
          });
          continue;
        }
        if (existing.state !== 'ready') {
          await transaction
            .update(mediaCacheBlobs)
            .set({
              evictionExpiresAt: null,
              evictionOwner: null,
              evictionToken: null,
              state: 'ready',
              updatedAt: postPublishNow,
            })
            .where(eq(mediaCacheBlobs.sha256, blob.sha256));
        }
      }

      for (const object of claimedObjects) {
        const published = inputByObjectId.get(object.id);
        if (!published) {
          throw new MediaCacheLedgerError('invalid_transition', 'Published object is missing');
        }
        await transaction
          .update(mediaCacheObjects)
          .set({
            actualBytes: published.byteLength,
            blobSha256: published.sha256,
            state: 'staging',
            updatedAt: postPublishNow,
          })
          .where(eq(mediaCacheObjects.id, object.id));
      }
      await transaction
        .update(mediaCachePostPlans)
        .set({
          state: 'settling',
          updatedAt: postPublishNow,
        })
        .where(eq(mediaCachePostPlans.id, plan.id));

      const [updatedRuntime] = await transaction
        .update(mediaCacheRuntime)
        .set({
          readyBytes: runtime.readyBytes + physicalBytesAdded,
          updatedAt: postPublishNow,
        })
        .where(eq(mediaCacheRuntime.singletonKey, 'local'))
        .returning({
          readyBytes: mediaCacheRuntime.readyBytes,
          reservedBytes: mediaCacheRuntime.reservedBytes,
        });
      if (!updatedRuntime) {
        throw new MediaCacheLedgerError('ledger_invariant', 'Media cache runtime row disappeared');
      }
      return {
        physicalBytesAdded,
        readyBytes: updatedRuntime.readyBytes,
        reservedBytes: updatedRuntime.reservedBytes,
      };
    });
  }

  async completeSettlement(input: CompleteMediaCacheSettlementInput): Promise<{
    logicalReadyBytes: bigint;
    readyBytes: bigint;
    releasedReservationBytes: bigint;
    reservedBytes: bigint;
  }> {
    assertPlanAndToken(input.planId, input.leaseToken);

    return this.database.transaction(async (transaction) => {
      await lockLedger(transaction);
      const now = await readDatabaseClock(transaction);
      const runtime = await lockRuntime(transaction);
      const plan = await lockFencedPlan(
        transaction,
        input.planId,
        input.leaseToken,
        now,
        'settling',
      );
      const objects = await transaction
        .select({
          actualBytes: mediaCacheObjects.actualBytes,
          blobSha256: mediaCacheObjects.blobSha256,
          id: mediaCacheObjects.id,
          leaseExpiresAt: mediaCacheObjects.leaseExpiresAt,
          leaseToken: mediaCacheObjects.leaseToken,
          state: mediaCacheObjects.state,
        })
        .from(mediaCacheObjects)
        .where(
          and(eq(mediaCacheObjects.postPlanId, plan.id), eq(mediaCacheObjects.variant, 'original')),
        )
        .orderBy(asc(mediaCacheObjects.id))
        .for('update');
      const settlingObjects = objects.filter((object) => object.state !== 'skipped');
      if (
        settlingObjects.length === 0 ||
        objects.some(
          (object) =>
            object.state !== 'skipped' &&
            (object.state !== 'staging' ||
              object.leaseToken !== input.leaseToken ||
              !object.leaseExpiresAt ||
              object.leaseExpiresAt <= now ||
              object.actualBytes === null ||
              object.blobSha256 === null),
        )
      ) {
        throw new MediaCacheLedgerError(
          'invalid_transition',
          'Settling plan does not have a complete fenced object set',
        );
      }

      const blobHashes = [
        ...new Set(settlingObjects.map((object) => object.blobSha256 as string)),
      ].sort();
      const readyBlobs = await transaction
        .select({ sha256: mediaCacheBlobs.sha256 })
        .from(mediaCacheBlobs)
        .where(and(inArray(mediaCacheBlobs.sha256, blobHashes), eq(mediaCacheBlobs.state, 'ready')))
        .orderBy(asc(mediaCacheBlobs.sha256))
        .for('update');
      if (readyBlobs.length !== blobHashes.length) {
        throw new MediaCacheLedgerError(
          'invalid_transition',
          'Every settling object must reference a ready blob',
        );
      }

      const logicalReadyBytes = settlingObjects.reduce(
        (total, object) => total + (object.actualBytes ?? 0n),
        0n,
      );
      if (logicalReadyBytes > POST_MAX_BYTES) {
        throw new MediaCacheLedgerError(
          'ledger_invariant',
          'Settled original objects exceed the per-post media cache limit',
        );
      }
      if (runtime.reservedBytes < plan.reservedOriginalBytes) {
        throw new MediaCacheLedgerError(
          'ledger_invariant',
          'Global media cache reservation is smaller than the plan reservation',
        );
      }

      await transaction
        .update(mediaCacheObjects)
        .set({
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          reservedBytes: 0n,
          state: 'ready',
          updatedAt: now,
        })
        .where(
          inArray(
            mediaCacheObjects.id,
            settlingObjects.map((object) => object.id),
          ),
        );
      await transaction
        .update(mediaCachePostPlans)
        .set({
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          readyOriginalBytes: logicalReadyBytes,
          reservedOriginalBytes: 0n,
          state: 'ready',
          updatedAt: now,
        })
        .where(eq(mediaCachePostPlans.id, plan.id));
      const [updatedRuntime] = await transaction
        .update(mediaCacheRuntime)
        .set({
          reservedBytes: runtime.reservedBytes - plan.reservedOriginalBytes,
          updatedAt: now,
        })
        .where(eq(mediaCacheRuntime.singletonKey, 'local'))
        .returning({
          readyBytes: mediaCacheRuntime.readyBytes,
          reservedBytes: mediaCacheRuntime.reservedBytes,
        });
      if (!updatedRuntime) {
        throw new MediaCacheLedgerError('ledger_invariant', 'Media cache runtime row disappeared');
      }
      return {
        logicalReadyBytes,
        readyBytes: updatedRuntime.readyBytes,
        releasedReservationBytes: plan.reservedOriginalBytes,
        reservedBytes: updatedRuntime.reservedBytes,
      };
    });
  }

  /**
   * Recovers one expired plan while the old lease provenance and the global
   * ledger lock remain held. The callback must settle or remove the old token's
   * completed staging files before it resolves.
   *
   * A precommit plan is released to retry only after cleanup succeeds. A
   * postcommit plan retains its reservation and is transferred to the new token
   * so the normal second settlement transaction can complete it.
   */
  async recoverExpiredPostPlan(
    input: RecoverExpiredMediaCachePostPlanInput,
  ): Promise<RecoveredMediaCachePostPlan | null> {
    assertRecoveryInput(input);

    return this.database.transaction(async (transaction) => {
      await lockLedger(transaction);
      const now = await readDatabaseClock(transaction);
      assertLiveLeaseExpiry(input.leaseExpiresAt, now);
      const runtime = await lockRuntime(transaction);
      const [plan] = await transaction
        .select({
          id: mediaCachePostPlans.id,
          leaseExpiresAt: mediaCachePostPlans.leaseExpiresAt,
          leaseToken: mediaCachePostPlans.leaseToken,
          reservedOriginalBytes: mediaCachePostPlans.reservedOriginalBytes,
          state: mediaCachePostPlans.state,
        })
        .from(mediaCachePostPlans)
        .where(eq(mediaCachePostPlans.id, input.planId))
        .for('update');
      if (
        !plan ||
        (plan.state !== 'staging' && plan.state !== 'settling') ||
        !plan.leaseToken ||
        !plan.leaseExpiresAt ||
        plan.leaseExpiresAt > now
      ) {
        return null;
      }
      if (plan.leaseToken === input.leaseToken) {
        throw new MediaCacheLedgerError('invalid_input', 'Recovery must use a fresh lease token');
      }

      const objects = await transaction
        .select({
          actualBytes: mediaCacheObjects.actualBytes,
          blobSha256: mediaCacheObjects.blobSha256,
          id: mediaCacheObjects.id,
          leaseToken: mediaCacheObjects.leaseToken,
          reservedBytes: mediaCacheObjects.reservedBytes,
          state: mediaCacheObjects.state,
        })
        .from(mediaCacheObjects)
        .where(
          and(eq(mediaCacheObjects.postPlanId, plan.id), eq(mediaCacheObjects.variant, 'original')),
        )
        .orderBy(asc(mediaCacheObjects.id))
        .for('update');
      const expectedObjectState = plan.state === 'staging' ? 'downloading' : 'staging';
      const recoveringObjects = objects.filter((object) => object.state !== 'skipped');
      if (
        recoveringObjects.length === 0 ||
        objects.some(
          (object) =>
            object.state !== 'skipped' &&
            (object.state !== expectedObjectState ||
              object.leaseToken !== plan.leaseToken ||
              object.reservedBytes <= 0n ||
              (plan.state === 'settling' &&
                (object.actualBytes === null || object.blobSha256 === null))),
        )
      ) {
        throw new MediaCacheLedgerError(
          'ledger_invariant',
          'Expired plan does not have a complete fenced original object set',
        );
      }

      await input.recover({
        objects: recoveringObjects.map((object) => ({
          actualBytes: object.actualBytes,
          blobSha256: object.blobSha256,
          objectId: object.id,
        })),
        phase: plan.state === 'staging' ? 'precommit' : 'postcommit',
        planId: plan.id,
        previousLeaseToken: plan.leaseToken,
      });

      const postRecoveryNow = await readDatabaseClock(transaction);
      assertLiveLeaseExpiry(input.leaseExpiresAt, postRecoveryNow);
      if (plan.state === 'staging') {
        if (runtime.reservedBytes < plan.reservedOriginalBytes) {
          throw new MediaCacheLedgerError(
            'ledger_invariant',
            'Global media cache reservation is smaller than the recovered plan reservation',
          );
        }
        await transaction
          .update(mediaCacheObjects)
          .set({
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            reservedBytes: 0n,
            state: 'retry_wait',
            updatedAt: postRecoveryNow,
          })
          .where(
            inArray(
              mediaCacheObjects.id,
              recoveringObjects.map((object) => object.id),
            ),
          );
        await transaction
          .update(mediaCachePostPlans)
          .set({
            availableAt: postRecoveryNow,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            reservedOriginalBytes: 0n,
            state: 'retry_wait',
            updatedAt: postRecoveryNow,
          })
          .where(eq(mediaCachePostPlans.id, plan.id));
        await transaction
          .update(mediaCacheRuntime)
          .set({
            reservedBytes: runtime.reservedBytes - plan.reservedOriginalBytes,
            updatedAt: postRecoveryNow,
          })
          .where(eq(mediaCacheRuntime.singletonKey, 'local'));
        return {
          nextState: 'retry_wait',
          planId: plan.id,
          releasedReservationBytes: plan.reservedOriginalBytes,
        };
      }

      await transaction
        .update(mediaCacheObjects)
        .set({
          leaseExpiresAt: input.leaseExpiresAt,
          leaseOwner: input.leaseOwner.trim(),
          leaseToken: input.leaseToken,
          updatedAt: postRecoveryNow,
        })
        .where(
          inArray(
            mediaCacheObjects.id,
            recoveringObjects.map((object) => object.id),
          ),
        );
      await transaction
        .update(mediaCachePostPlans)
        .set({
          leaseExpiresAt: input.leaseExpiresAt,
          leaseOwner: input.leaseOwner.trim(),
          leaseToken: input.leaseToken,
          updatedAt: postRecoveryNow,
        })
        .where(eq(mediaCachePostPlans.id, plan.id));
      return {
        leaseToken: input.leaseToken,
        nextState: 'settling',
        planId: plan.id,
        releasedReservationBytes: 0n,
      };
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
    throw new MediaCacheLedgerError('ledger_invariant', 'PostgreSQL returned an invalid clock');
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
      maxBytes: mediaCacheRuntime.maxBytes,
      readyBytes: mediaCacheRuntime.readyBytes,
      reservedBytes: mediaCacheRuntime.reservedBytes,
    })
    .from(mediaCacheRuntime)
    .where(eq(mediaCacheRuntime.singletonKey, 'local'))
    .for('update');
  if (!runtime) {
    throw new MediaCacheLedgerError('ledger_invariant', 'Media cache runtime row is missing');
  }
  return runtime;
}

async function lockFencedPlan(
  transaction: MediaCacheTransaction,
  planId: string,
  leaseToken: string,
  now: Date,
  state: 'settling' | 'staging',
) {
  const [plan] = await transaction
    .select({
      id: mediaCachePostPlans.id,
      leaseExpiresAt: mediaCachePostPlans.leaseExpiresAt,
      leaseToken: mediaCachePostPlans.leaseToken,
      reservedOriginalBytes: mediaCachePostPlans.reservedOriginalBytes,
      state: mediaCachePostPlans.state,
    })
    .from(mediaCachePostPlans)
    .where(eq(mediaCachePostPlans.id, planId))
    .for('update');
  if (
    !plan ||
    plan.state !== state ||
    plan.leaseToken !== leaseToken ||
    !plan.leaseExpiresAt ||
    plan.leaseExpiresAt <= now
  ) {
    throw new MediaCacheLedgerError(
      'stale_lease',
      `Media cache plan ${planId} is not held by the supplied live lease`,
    );
  }
  return plan;
}

function collapsePublishedBlobs(
  objects: readonly PublishedMediaCacheObjectIdentity[],
): PublishedMediaCacheObjectIdentity[] {
  const blobs = new Map<string, PublishedMediaCacheObjectIdentity>();
  for (const object of objects) {
    const existing = blobs.get(object.sha256);
    if (
      existing &&
      (existing.byteLength !== object.byteLength ||
        existing.detectedMime !== object.detectedMime ||
        existing.relativeKey !== object.relativeKey)
    ) {
      throw new MediaCacheLedgerError(
        'blob_identity_conflict',
        `Published objects disagree about blob ${object.sha256}`,
      );
    }
    blobs.set(object.sha256, existing ?? object);
  }
  return [...blobs.values()].sort((left, right) => left.sha256.localeCompare(right.sha256));
}

function assertLeaseInput(input: ClaimMediaCachePostPlanInput): void {
  assertPlanAndToken(input.planId, input.leaseToken);
  const leaseOwner = input.leaseOwner.trim();
  if (
    leaseOwner.length === 0 ||
    leaseOwner.length > 255 ||
    !Number.isFinite(input.leaseExpiresAt.getTime())
  ) {
    throw new MediaCacheLedgerError('invalid_input', 'A bounded lease is required');
  }
}

function assertRecoveryInput(input: RecoverExpiredMediaCachePostPlanInput): void {
  assertLeaseInput(input);
  if (typeof input.recover !== 'function') {
    throw new MediaCacheLedgerError('invalid_input', 'A recovery callback is required');
  }
}

function assertLiveLeaseExpiry(leaseExpiresAt: Date, now: Date): void {
  if (leaseExpiresAt <= now) {
    throw new MediaCacheLedgerError(
      'stale_lease',
      'The supplied lease expired before the ledger lock was acquired',
    );
  }
}

function assertFencedRowsRemainLive(
  plan: {
    leaseExpiresAt: Date | null;
    leaseToken: string | null;
  },
  objects: ReadonlyArray<{
    leaseExpiresAt: Date | null;
    leaseToken: string | null;
  }>,
  leaseToken: string,
  now: Date,
): void {
  if (
    plan.leaseToken !== leaseToken ||
    !plan.leaseExpiresAt ||
    plan.leaseExpiresAt <= now ||
    objects.some(
      (object) =>
        object.leaseToken !== leaseToken || !object.leaseExpiresAt || object.leaseExpiresAt <= now,
    )
  ) {
    throw new MediaCacheLedgerError(
      'stale_lease',
      'The media cache lease expired while filesystem publication was in progress',
    );
  }
}

function assertPublishedObjects(objects: readonly PublishedMediaCacheObjectIdentity[]): void {
  if (objects.length === 0) {
    throw new MediaCacheLedgerError('invalid_input', 'At least one published object is required');
  }
  const objectIds = new Set<string>();
  let logicalBytes = 0n;
  for (const object of objects) {
    if (
      !UUID.test(object.objectId) ||
      !SHA256.test(object.sha256) ||
      !DETECTED_MEDIA_MIMES.has(object.detectedMime) ||
      typeof object.byteLength !== 'bigint' ||
      object.byteLength <= 0n ||
      object.relativeKey !==
        `blobs/${object.sha256.slice(0, 2)}/${object.sha256.slice(2, 4)}/${object.sha256}`
    ) {
      throw new MediaCacheLedgerError('invalid_input', 'Published object identity is invalid');
    }
    if (objectIds.has(object.objectId)) {
      throw new MediaCacheLedgerError('invalid_input', 'Published object ids must be unique');
    }
    objectIds.add(object.objectId);
    logicalBytes += object.byteLength;
  }
  if (logicalBytes > POST_MAX_BYTES) {
    throw new MediaCacheLedgerError(
      'invalid_input',
      'Published original objects exceed the per-post media cache limit',
    );
  }
}

function assertPlanAndToken(planId: string, leaseToken: string): void {
  if (!UUID.test(planId) || !UUID.test(leaseToken)) {
    throw new MediaCacheLedgerError('invalid_input', 'Plan id and lease token must be UUIDs');
  }
}
