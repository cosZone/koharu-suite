import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  mediaCacheActions,
  mediaCacheBlobs,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  messageMedia,
  messageRevisions,
  messages,
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
  allowAwaitingLocalSource?: boolean;
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

export interface FailClaimedMediaCachePostPlanInput {
  cleanup: () => Promise<void>;
  conflictingObjectId?: string;
  disposition?: 'await_local_source' | 'integrity_conflict' | 'retry' | 'skip';
  errorClass: string;
  errorCode: string;
  leaseToken: string;
  planId: string;
  reasonCode?: string;
}

export interface FailedClaimedMediaCachePostPlan {
  attemptCount: number;
  availableAt: Date;
  nextState: 'awaiting_local_source' | 'blocked' | 'retry_wait' | 'skipped';
  planId: string;
  releasedReservationBytes: bigint;
}

export interface SkipClaimedMediaCacheObjectInput {
  cleanup: () => Promise<void>;
  leaseToken: string;
  objectId: string;
  planId: string;
  reasonCode: string;
}

export interface RecoverExpiredMediaCachePostPlanInput {
  leaseExpiresAt: Date;
  leaseOwner: string;
  leaseToken: string;
  planId: string;
  recover: (snapshot: ExpiredMediaCachePostPlanSnapshot) => Promise<void>;
}

export interface MarkMediaCacheRecoveryFailedInput {
  leaseExpiresAt: Date;
  leaseOwner: string;
  leaseToken: string;
  planId: string;
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
      nextState: 'awaiting_local_source' | 'blocked' | 'retry_wait';
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
    readonly objectId?: string,
  ) {
    super(message);
    this.name = 'MediaCacheLedgerError';
  }
}

export class PostgresMediaCacheLedgerRepository {
  constructor(private readonly database: Database) {}

  async requiredHeadroomBytes(): Promise<bigint> {
    return this.database.transaction(async (transaction) => {
      await lockLedger(transaction);
      const runtime = await lockRuntime(transaction);
      const configuredExcess =
        runtime.readyBytes > runtime.maxBytes ? runtime.readyBytes - runtime.maxBytes : 0n;
      const [plan] = await transaction
        .select({
          id: mediaCachePostPlans.id,
          readyOriginalBytes: mediaCachePostPlans.readyOriginalBytes,
        })
        .from(mediaCachePostPlans)
        .where(
          and(
            inArray(mediaCachePostPlans.state, ['discovered', 'retry_wait']),
            sql`${mediaCachePostPlans.availableAt} <= clock_timestamp()`,
            sql`${mediaCachePostPlans.attemptCount} < 10`,
            eq(mediaCachePostPlans.reservedOriginalBytes, 0n),
          ),
        )
        .orderBy(asc(mediaCachePostPlans.availableAt), asc(mediaCachePostPlans.id))
        .limit(1);
      if (!plan) {
        return configuredExcess;
      }
      const objects = await transaction
        .select({
          actualBytes: mediaCacheObjects.actualBytes,
          blobSha256: mediaCacheObjects.blobSha256,
          kind: messageMedia.kind,
          state: mediaCacheObjects.state,
        })
        .from(mediaCacheObjects)
        .innerJoin(messageMedia, eq(mediaCacheObjects.canonicalMediaId, messageMedia.id))
        .where(
          and(eq(mediaCacheObjects.postPlanId, plan.id), eq(mediaCacheObjects.variant, 'original')),
        )
        .orderBy(asc(mediaCacheObjects.id));
      const reservable = objects.flatMap((object) => {
        if (isInactiveOriginalState(object.state)) {
          return [];
        }
        const limit = ORIGINAL_LIMITS[object.kind as keyof typeof ORIGINAL_LIMITS];
        if (!limit || (object.state !== 'discovered' && object.state !== 'retry_wait')) {
          return [];
        }
        const reservation =
          object.blobSha256 && object.actualBytes !== null ? object.actualBytes : limit;
        return reservation > 0n && reservation <= limit ? [reservation] : [];
      });
      if (
        reservable.length === 0 ||
        reservable.length !==
          objects.filter((object) => !isInactiveOriginalState(object.state)).length
      ) {
        return configuredExcess;
      }
      const remainingPostBytes = POST_MAX_BYTES - plan.readyOriginalBytes;
      if (remainingPostBytes <= 0n) {
        return configuredExcess;
      }
      const requested = reservable.reduce((total, bytes) => total + bytes, 0n);
      const reservation = requested > remainingPostBytes ? remainingPostBytes : requested;
      const admissionTotal = runtime.readyBytes + runtime.reservedBytes + reservation;
      const admissionExcess =
        admissionTotal > runtime.maxBytes ? admissionTotal - runtime.maxBytes : 0n;
      return admissionExcess > configuredExcess ? admissionExcess : configuredExcess;
    });
  }

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
          attemptCount: mediaCachePostPlans.attemptCount,
          id: mediaCachePostPlans.id,
          readyOriginalBytes: mediaCachePostPlans.readyOriginalBytes,
        })
        .from(mediaCachePostPlans)
        .where(
          and(
            eq(mediaCachePostPlans.id, input.planId),
            inArray(
              mediaCachePostPlans.state,
              input.allowAwaitingLocalSource
                ? ['awaiting_local_source', 'discovered', 'retry_wait']
                : ['discovered', 'retry_wait'],
            ),
            eq(mediaCachePostPlans.reservedOriginalBytes, 0n),
          ),
        )
        .for('update');
      if (!plan) {
        return null;
      }

      const objects = await transaction
        .select({
          actualBytes: mediaCacheObjects.actualBytes,
          blobSha256: mediaCacheObjects.blobSha256,
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
        if (isInactiveOriginalState(object.state)) {
          return [];
        }
        const limit = ORIGINAL_LIMITS[object.kind as keyof typeof ORIGINAL_LIMITS];
        if (!limit) {
          return [];
        }
        const reservation =
          object.blobSha256 && object.actualBytes !== null ? object.actualBytes : limit;
        return [{ ...object, limit, reservation }];
      });
      if (
        reservable.length === 0 ||
        reservable.length !==
          objects.filter((object) => !isInactiveOriginalState(object.state)).length ||
        objects.some(
          (object) =>
            !isInactiveOriginalState(object.state) &&
            object.state !== 'discovered' &&
            object.state !== 'retry_wait' &&
            (!input.allowAwaitingLocalSource || object.state !== 'awaiting_local_source'),
        ) ||
        reservable.some(
          (object) =>
            object.availableAt > now ||
            object.reservation <= 0n ||
            object.reservation > object.limit,
        )
      ) {
        return null;
      }

      const requestedBytes = reservable.reduce((total, object) => total + object.reservation, 0n);
      const remainingPostBytes = POST_MAX_BYTES - plan.readyOriginalBytes;
      if (remainingPostBytes <= 0n) {
        return null;
      }
      const cappedRequestedBytes =
        requestedBytes > remainingPostBytes ? remainingPostBytes : requestedBytes;
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
            reservedBytes: object.reservation,
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
        .innerJoin(messageRevisions, eq(messageRevisions.id, mediaCacheObjects.revisionId))
        .innerJoin(
          messages,
          and(
            eq(messages.id, messageRevisions.messageId),
            eq(messages.currentRevisionNumber, messageRevisions.revisionNumber),
            isNull(messages.tombstonedAt),
          ),
        )
        .where(
          and(eq(mediaCacheObjects.postPlanId, plan.id), eq(mediaCacheObjects.variant, 'original')),
        )
        .orderBy(asc(mediaCacheObjects.id))
        .for('update', { of: mediaCacheObjects });
      const claimedObjects = objects.filter((object) => object.state === 'downloading');
      if (
        claimedObjects.length === 0 ||
        objects.some(
          (object) => !isInactiveOriginalState(object.state) && object.state !== 'downloading',
        ) ||
        claimedObjects.some(
          (object) =>
            object.leaseToken !== input.leaseToken ||
            !object.leaseExpiresAt ||
            object.leaseExpiresAt <= now,
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
        if (object.blobSha256 && object.blobSha256 !== published.sha256) {
          throw new MediaCacheLedgerError(
            'sticky_hash_conflict',
            `Media cache object ${object.id} is already bound to another blob`,
            object.id,
          );
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
      }
      const publishedLogicalBytes = publishedObjects.reduce(
        (total, object) => total + object.byteLength,
        0n,
      );
      if (plan.readyOriginalBytes + publishedLogicalBytes > POST_MAX_BYTES) {
        throw new MediaCacheLedgerError(
          'ledger_invariant',
          'Publishing would exceed the per-post media cache limit',
        );
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

      const pendingOriginalBytesByPlan = new Map<string, bigint>();
      for (const object of claimedObjects) {
        const published = inputByObjectId.get(object.id);
        if (!published) {
          throw new MediaCacheLedgerError('invalid_transition', 'Published object is missing');
        }
        pendingOriginalBytesByPlan.set(
          plan.id,
          (pendingOriginalBytesByPlan.get(plan.id) ?? 0n) + published.byteLength,
        );
      }
      await restoreRelatedBlobObjects(
        transaction,
        uniqueBlobs
          .filter((blob) => existingBlobs.get(blob.sha256)?.state !== 'ready')
          .map((blob) => blob.sha256),
        pendingOriginalBytesByPlan,
        postPublishNow,
      );

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
      const settlingObjects = objects.filter((object) => object.state === 'staging');
      if (
        settlingObjects.length === 0 ||
        objects.some(
          (object) => !isInactiveOriginalState(object.state) && object.state !== 'staging',
        ) ||
        settlingObjects.some(
          (object) =>
            object.leaseToken !== input.leaseToken ||
            !object.leaseExpiresAt ||
            object.leaseExpiresAt <= now ||
            object.actualBytes === null ||
            object.blobSha256 === null,
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

      const logicalReadyBytes =
        plan.readyOriginalBytes +
        settlingObjects.reduce((total, object) => total + (object.actualBytes ?? 0n), 0n);
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

  async failClaimedPostPlan(
    input: FailClaimedMediaCachePostPlanInput,
  ): Promise<FailedClaimedMediaCachePostPlan> {
    assertPlanAndToken(input.planId, input.leaseToken);
    assertFailureInput(input);

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
      const activeObjects = objects.filter((object) => object.state === 'downloading');
      if (
        activeObjects.length === 0 ||
        objects.some(
          (object) => !isInactiveOriginalState(object.state) && object.state !== 'downloading',
        ) ||
        activeObjects.some(
          (object) =>
            object.leaseToken !== input.leaseToken ||
            !object.leaseExpiresAt ||
            object.leaseExpiresAt <= now,
        )
      ) {
        throw new MediaCacheLedgerError(
          'invalid_transition',
          'Failed plan does not have a complete fenced original object set',
        );
      }
      if (
        input.disposition === 'integrity_conflict' &&
        !activeObjects.some((object) => object.id === input.conflictingObjectId)
      ) {
        throw new MediaCacheLedgerError(
          'invalid_transition',
          'Integrity conflict must identify an object held by the live plan lease',
        );
      }

      await input.cleanup();
      const postCleanupNow = await readDatabaseClock(transaction);
      assertFencedRowsRemainLive(plan, activeObjects, input.leaseToken, postCleanupNow);
      if (runtime.reservedBytes < plan.reservedOriginalBytes) {
        throw new MediaCacheLedgerError(
          'ledger_invariant',
          'Global media cache reservation is smaller than the failed plan reservation',
        );
      }

      const attemptCount =
        input.disposition === 'await_local_source'
          ? plan.attemptCount
          : Math.min(plan.attemptCount + 1, 10);
      const nextState =
        input.disposition === 'await_local_source'
          ? 'awaiting_local_source'
          : input.disposition === 'integrity_conflict'
            ? 'blocked'
            : input.disposition === 'skip'
              ? 'skipped'
              : attemptCount >= 10
                ? 'blocked'
                : 'retry_wait';
      const availableAt =
        nextState === 'retry_wait'
          ? new Date(postCleanupNow.getTime() + retryDelayMs(attemptCount))
          : postCleanupNow;
      const reasonCode =
        input.disposition === 'integrity_conflict'
          ? 'integrity_conflict'
          : nextState === 'skipped'
            ? (input.reasonCode ?? input.errorCode)
            : null;

      if (activeObjects.length > 0) {
        await transaction
          .update(mediaCacheObjects)
          .set({
            attemptCount,
            availableAt,
            lastErrorClass: input.errorClass,
            lastErrorCode: input.errorCode,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            reasonCode: input.disposition === 'integrity_conflict' ? null : reasonCode,
            reservedBytes: 0n,
            state: nextState,
            updatedAt: postCleanupNow,
          })
          .where(
            inArray(
              mediaCacheObjects.id,
              activeObjects.map((object) => object.id),
            ),
          );
        if (input.disposition === 'integrity_conflict') {
          await transaction
            .update(mediaCacheObjects)
            .set({
              reasonCode: 'integrity_conflict',
              state: 'integrity_conflict',
              updatedAt: postCleanupNow,
            })
            .where(eq(mediaCacheObjects.id, input.conflictingObjectId as string));
        }
      }
      await transaction
        .update(mediaCachePostPlans)
        .set({
          attemptCount,
          availableAt,
          lastErrorClass: input.errorClass,
          lastErrorCode: input.errorCode,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          reasonCode,
          reservedOriginalBytes: 0n,
          state: nextState,
          updatedAt: postCleanupNow,
        })
        .where(eq(mediaCachePostPlans.id, plan.id));
      await transaction
        .update(mediaCacheRuntime)
        .set({
          reservedBytes: runtime.reservedBytes - plan.reservedOriginalBytes,
          updatedAt: postCleanupNow,
        })
        .where(eq(mediaCacheRuntime.singletonKey, 'local'));

      return {
        attemptCount,
        availableAt,
        nextState,
        planId: plan.id,
        releasedReservationBytes: plan.reservedOriginalBytes,
      };
    });
  }

  async skipClaimedObject(input: SkipClaimedMediaCacheObjectInput): Promise<boolean> {
    assertPlanAndToken(input.planId, input.leaseToken);
    if (!UUID.test(input.objectId) || !/^[a-z][a-z0-9_]{0,63}$/u.test(input.reasonCode)) {
      throw new MediaCacheLedgerError('invalid_input', 'Skipped object input is invalid');
    }
    if (typeof input.cleanup !== 'function') {
      throw new MediaCacheLedgerError('invalid_input', 'A staging cleanup callback is required');
    }

    return this.database.transaction(async (transaction) => {
      await lockLedger(transaction);
      const now = await readDatabaseClock(transaction);
      await lockRuntime(transaction);
      const plan = await lockFencedPlan(
        transaction,
        input.planId,
        input.leaseToken,
        now,
        'staging',
      );
      const [object] = await transaction
        .select({
          id: mediaCacheObjects.id,
          leaseExpiresAt: mediaCacheObjects.leaseExpiresAt,
          leaseToken: mediaCacheObjects.leaseToken,
          state: mediaCacheObjects.state,
        })
        .from(mediaCacheObjects)
        .where(
          and(
            eq(mediaCacheObjects.id, input.objectId),
            eq(mediaCacheObjects.postPlanId, plan.id),
            eq(mediaCacheObjects.variant, 'original'),
          ),
        )
        .for('update');
      if (
        object?.state !== 'downloading' ||
        object.leaseToken !== input.leaseToken ||
        !object.leaseExpiresAt ||
        object.leaseExpiresAt <= now
      ) {
        throw new MediaCacheLedgerError(
          'stale_lease',
          'Media cache object is not held by the supplied live plan lease',
        );
      }

      await input.cleanup();
      const postCleanupNow = await readDatabaseClock(transaction);
      assertFencedRowsRemainLive(plan, [object], input.leaseToken, postCleanupNow);
      const updated = await transaction
        .update(mediaCacheObjects)
        .set({
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          reasonCode: input.reasonCode,
          reservedBytes: 0n,
          state: 'skipped',
          updatedAt: postCleanupNow,
        })
        .where(
          and(
            eq(mediaCacheObjects.id, object.id),
            eq(mediaCacheObjects.leaseToken, input.leaseToken),
          ),
        )
        .returning({ id: mediaCacheObjects.id });
      return updated.length === 1;
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
          attemptCount: mediaCachePostPlans.attemptCount,
          id: mediaCachePostPlans.id,
          leaseExpiresAt: mediaCachePostPlans.leaseExpiresAt,
          leaseOwner: mediaCachePostPlans.leaseOwner,
          leaseToken: mediaCachePostPlans.leaseToken,
          reservedOriginalBytes: mediaCachePostPlans.reservedOriginalBytes,
          state: mediaCachePostPlans.state,
        })
        .from(mediaCachePostPlans)
        .where(eq(mediaCachePostPlans.id, input.planId))
        .for('update');
      if (
        !plan ||
        (plan.state !== 'staging' && plan.state !== 'settling' && plan.state !== 'recovering') ||
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
      const expectedObjectState =
        plan.state === 'staging'
          ? 'downloading'
          : plan.state === 'settling'
            ? 'staging'
            : objects.find((object) => object.state === 'downloading' || object.state === 'staging')
                ?.state;
      if (expectedObjectState !== 'downloading' && expectedObjectState !== 'staging') {
        throw new MediaCacheLedgerError(
          'ledger_invariant',
          'Recovering plan has no consistent original object phase',
        );
      }
      const recoveringObjects = objects.filter((object) => object.state === expectedObjectState);
      if (
        recoveringObjects.length === 0 ||
        objects.some(
          (object) =>
            !isInactiveOriginalState(object.state) && object.state !== expectedObjectState,
        ) ||
        recoveringObjects.some(
          (object) =>
            object.leaseToken !== plan.leaseToken ||
            object.reservedBytes <= 0n ||
            (expectedObjectState === 'staging' &&
              (object.actualBytes === null || object.blobSha256 === null)),
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
        phase: expectedObjectState === 'downloading' ? 'precommit' : 'postcommit',
        planId: plan.id,
        previousLeaseToken: plan.leaseToken,
      });

      const postRecoveryNow = await readDatabaseClock(transaction);
      assertLiveLeaseExpiry(input.leaseExpiresAt, postRecoveryNow);
      if (expectedObjectState === 'downloading') {
        if (runtime.reservedBytes < plan.reservedOriginalBytes) {
          throw new MediaCacheLedgerError(
            'ledger_invariant',
            'Global media cache reservation is smaller than the recovered plan reservation',
          );
        }
        const localSource = plan.leaseOwner?.startsWith('desktop-cli:') === true;
        const attemptCount = localSource ? plan.attemptCount : Math.min(plan.attemptCount + 1, 10);
        const nextState = localSource
          ? 'awaiting_local_source'
          : attemptCount >= 10
            ? 'blocked'
            : 'retry_wait';
        const availableAt =
          nextState === 'retry_wait'
            ? new Date(postRecoveryNow.getTime() + retryDelayMs(attemptCount))
            : postRecoveryNow;
        await transaction
          .update(mediaCacheObjects)
          .set({
            attemptCount,
            availableAt,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            reservedBytes: 0n,
            state: nextState,
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
            attemptCount,
            availableAt,
            leaseExpiresAt: null,
            leaseOwner: null,
            leaseToken: null,
            reservedOriginalBytes: 0n,
            state: nextState,
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
          nextState,
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

  async markExpiredRecoveryFailed(input: MarkMediaCacheRecoveryFailedInput): Promise<boolean> {
    assertLeaseInput(input);
    return this.database.transaction(async (transaction) => {
      await lockLedger(transaction);
      const now = await readDatabaseClock(transaction);
      assertLiveLeaseExpiry(input.leaseExpiresAt, now);
      const [plan] = await transaction
        .select({
          attemptCount: mediaCachePostPlans.attemptCount,
          id: mediaCachePostPlans.id,
          leaseExpiresAt: mediaCachePostPlans.leaseExpiresAt,
          state: mediaCachePostPlans.state,
        })
        .from(mediaCachePostPlans)
        .where(eq(mediaCachePostPlans.id, input.planId))
        .for('update');
      if (
        !plan ||
        !inRecoveryState(plan.state) ||
        !plan.leaseExpiresAt ||
        plan.leaseExpiresAt > now
      ) {
        return false;
      }
      const attemptCount = Math.min(plan.attemptCount + 1, 10);
      const availableAt = new Date(now.getTime() + retryDelayMs(attemptCount));
      const activeObjects = await transaction
        .select({ id: mediaCacheObjects.id, state: mediaCacheObjects.state })
        .from(mediaCacheObjects)
        .where(
          and(
            eq(mediaCacheObjects.postPlanId, plan.id),
            eq(mediaCacheObjects.variant, 'original'),
            inArray(mediaCacheObjects.state, ['downloading', 'staging']),
          ),
        )
        .for('update');
      if (activeObjects.length === 0) {
        throw new MediaCacheLedgerError(
          'ledger_invariant',
          'Failed recovery plan has no active provenance',
        );
      }
      await transaction
        .update(mediaCacheObjects)
        .set({
          lastErrorClass: 'recovery',
          lastErrorCode: 'temp_cleanup_failed',
          attemptCount,
          availableAt,
          updatedAt: now,
        })
        .where(
          inArray(
            mediaCacheObjects.id,
            activeObjects.map(({ id }) => id),
          ),
        );
      await transaction
        .update(mediaCachePostPlans)
        .set({
          lastErrorClass: 'recovery',
          lastErrorCode: 'temp_cleanup_failed',
          attemptCount,
          availableAt,
          state: 'recovering',
          updatedAt: now,
        })
        .where(eq(mediaCachePostPlans.id, plan.id));
      return true;
    });
  }
}

function inRecoveryState(state: string): boolean {
  return state === 'staging' || state === 'settling' || state === 'recovering';
}

function isInactiveOriginalState(state: string): boolean {
  return (
    state === 'blocked' ||
    state === 'evicted' ||
    state === 'integrity_conflict' ||
    state === 'missing' ||
    state === 'ready' ||
    state === 'skipped'
  );
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
      attemptCount: mediaCachePostPlans.attemptCount,
      leaseExpiresAt: mediaCachePostPlans.leaseExpiresAt,
      leaseToken: mediaCachePostPlans.leaseToken,
      readyOriginalBytes: mediaCachePostPlans.readyOriginalBytes,
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

function assertFailureInput(input: FailClaimedMediaCachePostPlanInput): void {
  if (typeof input.cleanup !== 'function') {
    throw new MediaCacheLedgerError('invalid_input', 'A staging cleanup callback is required');
  }
  if (
    input.disposition === 'integrity_conflict' &&
    (!input.conflictingObjectId || !UUID.test(input.conflictingObjectId))
  ) {
    throw new MediaCacheLedgerError(
      'invalid_input',
      'An integrity conflict must identify the conflicting object',
    );
  }
  for (const [label, value] of [
    ['errorClass', input.errorClass],
    ['errorCode', input.errorCode],
    ...(input.reasonCode === undefined ? [] : [['reasonCode', input.reasonCode]]),
  ] as const) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(value)) {
      throw new MediaCacheLedgerError('invalid_input', `${label} must be a stable bounded code`);
    }
  }
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attemptCount - 1), 5 * 60_000);
}

async function restoreRelatedBlobObjects(
  transaction: MediaCacheTransaction,
  blobHashes: readonly string[],
  pendingOriginalBytesByPlan: ReadonlyMap<string, bigint>,
  now: Date,
): Promise<void> {
  if (blobHashes.length === 0) {
    return;
  }
  const candidates = await transaction
    .select({
      actualBytes: mediaCacheObjects.actualBytes,
      id: mediaCacheObjects.id,
      planId: mediaCacheObjects.postPlanId,
      state: mediaCacheObjects.state,
      variant: mediaCacheObjects.variant,
    })
    .from(mediaCacheObjects)
    .innerJoin(messageRevisions, eq(messageRevisions.id, mediaCacheObjects.revisionId))
    .innerJoin(
      messages,
      and(
        eq(messages.id, messageRevisions.messageId),
        eq(messages.currentRevisionNumber, messageRevisions.revisionNumber),
        isNull(messages.tombstonedAt),
      ),
    )
    .where(
      and(
        inArray(mediaCacheObjects.blobSha256, [...blobHashes]),
        inArray(mediaCacheObjects.state, ['blocked', 'evicted', 'missing', 'retry_wait']),
      ),
    )
    .orderBy(asc(mediaCacheObjects.postPlanId), asc(mediaCacheObjects.id))
    .for('update', { of: mediaCacheObjects });
  if (candidates.length === 0) {
    return;
  }

  const originalBytesByPlan = new Map<string, bigint>();
  for (const candidate of candidates) {
    if (candidate.actualBytes === null || candidate.actualBytes <= 0n) {
      throw new MediaCacheLedgerError(
        'ledger_invariant',
        `Restorable media cache object ${candidate.id} has no positive byte length`,
      );
    }
    if (candidate.variant === 'original') {
      originalBytesByPlan.set(
        candidate.planId,
        (originalBytesByPlan.get(candidate.planId) ?? 0n) + candidate.actualBytes,
      );
    }
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
    throw new MediaCacheLedgerError(
      'ledger_invariant',
      'A restorable media cache object references a missing post plan',
    );
  }

  const restorablePlanIds = new Set<string>();
  for (const plan of plans) {
    const restoring = originalBytesByPlan.get(plan.id) ?? 0n;
    const pending = pendingOriginalBytesByPlan.get(plan.id) ?? 0n;
    if (plan.readyOriginalBytes + restoring + pending <= POST_MAX_BYTES) {
      restorablePlanIds.add(plan.id);
    }
  }
  const restorable = candidates.filter(
    (candidate) => candidate.variant === 'thumbnail' || restorablePlanIds.has(candidate.planId),
  );
  if (restorable.length === 0) {
    return;
  }

  await transaction
    .update(mediaCacheObjects)
    .set({ state: 'ready', updatedAt: now })
    .where(
      inArray(
        mediaCacheObjects.id,
        restorable.map(({ id }) => id),
      ),
    );
  for (const plan of plans) {
    if (!restorablePlanIds.has(plan.id)) {
      continue;
    }
    const restoring = originalBytesByPlan.get(plan.id) ?? 0n;
    await transaction
      .update(mediaCachePostPlans)
      .set({
        readyOriginalBytes: plan.readyOriginalBytes + restoring,
        updatedAt: now,
      })
      .where(eq(mediaCachePostPlans.id, plan.id));
  }
  for (const plan of plans) {
    if (!restorablePlanIds.has(plan.id)) {
      continue;
    }
    const originals = await transaction
      .select({
        actualBytes: mediaCacheObjects.actualBytes,
        state: mediaCacheObjects.state,
      })
      .from(mediaCacheObjects)
      .where(
        and(eq(mediaCacheObjects.postPlanId, plan.id), eq(mediaCacheObjects.variant, 'original')),
      )
      .orderBy(asc(mediaCacheObjects.id))
      .for('update');
    const allReadyOrSkipped =
      originals.length > 0 &&
      originals.every((object) => object.state === 'ready' || object.state === 'skipped');
    if (!allReadyOrSkipped) {
      continue;
    }
    const readyOriginalBytes = originals.reduce(
      (total, object) =>
        object.state === 'ready' && object.actualBytes !== null
          ? total + object.actualBytes
          : total,
      0n,
    );
    if (readyOriginalBytes > POST_MAX_BYTES) {
      throw new MediaCacheLedgerError(
        'ledger_invariant',
        `Restored media cache plan ${plan.id} exceeds its logical byte limit`,
      );
    }
    await transaction
      .update(mediaCachePostPlans)
      .set({
        attemptCount: 0,
        availableAt: now,
        lastErrorClass: null,
        lastErrorCode: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseToken: null,
        readyOriginalBytes,
        reasonCode: null,
        reservedOriginalBytes: 0n,
        state: 'ready',
        updatedAt: now,
      })
      .where(eq(mediaCachePostPlans.id, plan.id));
  }
  await transaction.insert(mediaCacheActions).values(
    restorable.map((candidate) => ({
      actionKind: 'restore_missing' as const,
      afterState: { state: 'ready', variant: candidate.variant },
      beforeState: { state: candidate.state, variant: candidate.variant },
      initiatorKind: 'worker' as const,
      objectId: candidate.id,
    })),
  );
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
