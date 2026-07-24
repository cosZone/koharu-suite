import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  mediaCacheBlobs,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  messageMedia,
} from '../db/schema.js';
import { MEDIA_CACHE_ADVISORY_LOCK } from './ledger-repository.js';

const THUMBNAIL_MAX_BYTES = 1024n * 1024n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ClaimedMediaCacheThumbnail {
  objectId: string;
  original: {
    byteLength: bigint;
    detectedMime: string;
    relativeKey: string;
    sha256: string;
  };
  planId: string;
}

export interface PublishedMediaCacheThumbnail {
  byteLength: bigint;
  detectedMime: 'image/webp';
  objectId: string;
  relativeKey: string;
  sha256: string;
}

export interface ExpiredMediaCacheThumbnail {
  actualBytes: bigint | null;
  blobSha256: string | null;
  objectId: string;
  phase: 'postcommit' | 'precommit';
  planId: string;
  previousLeaseToken: string;
}

export class PostgresMediaCacheThumbnailLedgerRepository {
  constructor(private readonly database: Database) {}

  async claim(input: {
    leaseExpiresAt: Date;
    leaseOwner: string;
    leaseToken: string;
    objectId: string;
  }): Promise<ClaimedMediaCacheThumbnail | null> {
    assertLease(input);
    return this.database.transaction(async (tx) => {
      await lock(tx);
      const now = await clock(tx);
      if (input.leaseExpiresAt <= now) {
        throw new Error('Thumbnail lease is already expired');
      }
      const runtime = await runtimeRow(tx);
      if (runtime.readyBytes + runtime.reservedBytes + THUMBNAIL_MAX_BYTES > runtime.maxBytes) {
        return null;
      }
      const [thumbnail] = await tx
        .select({
          canonicalMediaId: mediaCacheObjects.canonicalMediaId,
          id: mediaCacheObjects.id,
          planId: mediaCacheObjects.postPlanId,
          state: mediaCacheObjects.state,
        })
        .from(mediaCacheObjects)
        .innerJoin(mediaCachePostPlans, eq(mediaCachePostPlans.id, mediaCacheObjects.postPlanId))
        .where(
          and(
            eq(mediaCacheObjects.id, input.objectId),
            eq(mediaCacheObjects.variant, 'thumbnail'),
            inArray(mediaCacheObjects.state, ['discovered', 'retry_wait']),
            eq(mediaCachePostPlans.state, 'ready'),
          ),
        )
        .for('update', { of: mediaCacheObjects });
      if (!thumbnail) {
        return null;
      }
      const [original] = await tx
        .select({
          byteLength: mediaCacheBlobs.byteLength,
          detectedMime: mediaCacheBlobs.detectedMime,
          kind: messageMedia.kind,
          relativeKey: mediaCacheBlobs.relativeKey,
          sha256: mediaCacheBlobs.sha256,
        })
        .from(mediaCacheObjects)
        .innerJoin(messageMedia, eq(messageMedia.id, mediaCacheObjects.canonicalMediaId))
        .innerJoin(mediaCacheBlobs, eq(mediaCacheBlobs.sha256, mediaCacheObjects.blobSha256))
        .where(
          and(
            eq(mediaCacheObjects.canonicalMediaId, thumbnail.canonicalMediaId),
            eq(mediaCacheObjects.variant, 'original'),
            eq(mediaCacheObjects.recipeVersion, 1),
            eq(mediaCacheObjects.state, 'ready'),
            eq(mediaCacheBlobs.state, 'ready'),
          ),
        )
        .for('update', { of: mediaCacheObjects });
      if (!original || !isThumbnailInput(original.kind, original.detectedMime)) {
        return null;
      }
      await tx
        .update(mediaCacheRuntime)
        .set({
          reservedBytes: runtime.reservedBytes + THUMBNAIL_MAX_BYTES,
          updatedAt: now,
        })
        .where(eq(mediaCacheRuntime.singletonKey, 'local'));
      await tx
        .update(mediaCacheObjects)
        .set({
          leaseExpiresAt: input.leaseExpiresAt,
          leaseOwner: input.leaseOwner.trim(),
          leaseToken: input.leaseToken,
          reservedBytes: THUMBNAIL_MAX_BYTES,
          state: 'downloading',
          updatedAt: now,
        })
        .where(eq(mediaCacheObjects.id, thumbnail.id));
      return {
        objectId: thumbnail.id,
        original,
        planId: thumbnail.planId,
      };
    });
  }

  async recordPublished(input: {
    leaseToken: string;
    object: PublishedMediaCacheThumbnail;
    publish: () => Promise<void>;
  }): Promise<void> {
    assertPublished(input.object, input.leaseToken);
    await this.database.transaction(async (tx) => {
      await lock(tx);
      const now = await clock(tx);
      const runtime = await runtimeRow(tx);
      const object = await lockedObject(
        tx,
        input.object.objectId,
        input.leaseToken,
        'downloading',
        now,
      );
      if (object.blobSha256 && object.blobSha256 !== input.object.sha256) {
        throw new Error('Thumbnail object sticky hash conflict');
      }
      const [blob] = await tx
        .select()
        .from(mediaCacheBlobs)
        .where(eq(mediaCacheBlobs.sha256, input.object.sha256))
        .for('update');
      if (
        blob &&
        (blob.byteLength !== input.object.byteLength ||
          blob.detectedMime !== input.object.detectedMime ||
          blob.relativeKey !== input.object.relativeKey)
      ) {
        throw new Error('Thumbnail blob identity conflict');
      }
      if (blob?.state === 'deleting') {
        throw new Error('Thumbnail blob is being deleted');
      }
      const physicalAdded = blob?.state !== 'ready' ? input.object.byteLength : 0n;
      if (runtime.readyBytes + physicalAdded > runtime.maxBytes) {
        throw new Error('Thumbnail publication exceeds the media cache budget');
      }
      await input.publish();
      const afterPublish = await clock(tx);
      await lockedObject(tx, input.object.objectId, input.leaseToken, 'downloading', afterPublish);
      if (!blob) {
        await tx.insert(mediaCacheBlobs).values({
          byteLength: input.object.byteLength,
          detectedMime: input.object.detectedMime,
          relativeKey: input.object.relativeKey,
          sha256: input.object.sha256,
          state: 'ready',
        });
      } else if (blob.state !== 'ready') {
        await tx
          .update(mediaCacheBlobs)
          .set({
            evictionExpiresAt: null,
            evictionOwner: null,
            evictionToken: null,
            state: 'ready',
            updatedAt: afterPublish,
          })
          .where(eq(mediaCacheBlobs.sha256, blob.sha256));
      }
      await tx
        .update(mediaCacheObjects)
        .set({
          actualBytes: input.object.byteLength,
          blobSha256: input.object.sha256,
          state: 'staging',
          updatedAt: afterPublish,
        })
        .where(eq(mediaCacheObjects.id, input.object.objectId));
      await tx
        .update(mediaCacheRuntime)
        .set({ readyBytes: runtime.readyBytes + physicalAdded, updatedAt: afterPublish })
        .where(eq(mediaCacheRuntime.singletonKey, 'local'));
    });
  }

  async complete(input: { leaseToken: string; objectId: string }): Promise<void> {
    await this.database.transaction(async (tx) => {
      await lock(tx);
      const now = await clock(tx);
      const runtime = await runtimeRow(tx);
      const object = await lockedObject(tx, input.objectId, input.leaseToken, 'staging', now);
      if (!object.blobSha256 || object.actualBytes === null) {
        throw new Error('Settling thumbnail has no blob identity');
      }
      const [blob] = await tx
        .select({ state: mediaCacheBlobs.state })
        .from(mediaCacheBlobs)
        .where(eq(mediaCacheBlobs.sha256, object.blobSha256))
        .for('update');
      if (blob?.state !== 'ready' || runtime.reservedBytes < object.reservedBytes) {
        throw new Error('Thumbnail settlement ledger invariant failed');
      }
      await tx
        .update(mediaCacheObjects)
        .set({
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          reservedBytes: 0n,
          state: 'ready',
          updatedAt: now,
        })
        .where(eq(mediaCacheObjects.id, object.id));
      await tx
        .update(mediaCacheRuntime)
        .set({
          reservedBytes: runtime.reservedBytes - object.reservedBytes,
          updatedAt: now,
        })
        .where(eq(mediaCacheRuntime.singletonKey, 'local'));
    });
  }

  async fail(input: {
    cleanup: () => Promise<void>;
    errorCode: string;
    leaseToken: string;
    objectId: string;
  }): Promise<void> {
    await this.database.transaction(async (tx) => {
      await lock(tx);
      const now = await clock(tx);
      const runtime = await runtimeRow(tx);
      const object = await lockedObject(tx, input.objectId, input.leaseToken, 'downloading', now);
      await input.cleanup();
      const afterCleanup = await clock(tx);
      await lockedObject(tx, input.objectId, input.leaseToken, 'downloading', afterCleanup);
      if (runtime.reservedBytes < object.reservedBytes) {
        throw new Error('Thumbnail failure ledger invariant failed');
      }
      await tx
        .update(mediaCacheObjects)
        .set({
          lastErrorClass: 'thumbnail',
          lastErrorCode: input.errorCode,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          reasonCode: 'thumbnail_unavailable',
          reservedBytes: 0n,
          state: 'skipped',
          updatedAt: afterCleanup,
        })
        .where(eq(mediaCacheObjects.id, object.id));
      await tx
        .update(mediaCacheRuntime)
        .set({
          reservedBytes: runtime.reservedBytes - object.reservedBytes,
          updatedAt: afterCleanup,
        })
        .where(eq(mediaCacheRuntime.singletonKey, 'local'));
    });
  }

  async recoverExpired(input: {
    leaseExpiresAt: Date;
    leaseOwner: string;
    leaseToken: string;
    objectId: string;
    recover: (snapshot: ExpiredMediaCacheThumbnail) => Promise<void>;
  }): Promise<'retry_wait' | 'settling' | null> {
    assertLease(input);
    return this.database.transaction(async (tx) => {
      await lock(tx);
      const now = await clock(tx);
      const runtime = await runtimeRow(tx);
      const [object] = await tx
        .select()
        .from(mediaCacheObjects)
        .where(eq(mediaCacheObjects.id, input.objectId))
        .for('update');
      if (
        object?.variant !== 'thumbnail' ||
        (object.state !== 'downloading' && object.state !== 'staging') ||
        !object.leaseToken ||
        !object.leaseExpiresAt ||
        object.leaseExpiresAt > now
      ) {
        return null;
      }
      if (object.leaseToken === input.leaseToken || input.leaseExpiresAt <= now) {
        throw new Error('Thumbnail recovery requires a fresh live lease');
      }
      await input.recover({
        actualBytes: object.actualBytes,
        blobSha256: object.blobSha256,
        objectId: object.id,
        phase: object.state === 'staging' ? 'postcommit' : 'precommit',
        planId: object.postPlanId,
        previousLeaseToken: object.leaseToken,
      });
      const afterRecovery = await clock(tx);
      if (input.leaseExpiresAt <= afterRecovery) {
        throw new Error('Thumbnail recovery lease expired during cleanup');
      }
      if (object.state === 'staging') {
        await tx
          .update(mediaCacheObjects)
          .set({
            leaseExpiresAt: input.leaseExpiresAt,
            leaseOwner: input.leaseOwner.trim(),
            leaseToken: input.leaseToken,
            updatedAt: afterRecovery,
          })
          .where(eq(mediaCacheObjects.id, object.id));
        return 'settling';
      }
      if (runtime.reservedBytes < object.reservedBytes) {
        throw new Error('Thumbnail recovery ledger invariant failed');
      }
      await tx
        .update(mediaCacheObjects)
        .set({
          attemptCount: Math.min(object.attemptCount + 1, 10),
          availableAt: afterRecovery,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          reservedBytes: 0n,
          state: object.attemptCount + 1 >= 10 ? 'blocked' : 'retry_wait',
          updatedAt: afterRecovery,
        })
        .where(eq(mediaCacheObjects.id, object.id));
      await tx
        .update(mediaCacheRuntime)
        .set({
          reservedBytes: runtime.reservedBytes - object.reservedBytes,
          updatedAt: afterRecovery,
        })
        .where(eq(mediaCacheRuntime.singletonKey, 'local'));
      return 'retry_wait';
    });
  }
}

async function lockedObject(
  tx: Transaction,
  objectId: string,
  leaseToken: string,
  state: 'downloading' | 'staging',
  now: Date,
) {
  const [object] = await tx
    .select()
    .from(mediaCacheObjects)
    .where(eq(mediaCacheObjects.id, objectId))
    .for('update');
  if (
    object?.variant !== 'thumbnail' ||
    object.state !== state ||
    object.leaseToken !== leaseToken ||
    !object.leaseExpiresAt ||
    object.leaseExpiresAt <= now
  ) {
    throw new Error('Thumbnail lease is stale');
  }
  return object;
}

async function lock(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${MEDIA_CACHE_ADVISORY_LOCK})`);
}

async function clock(tx: Transaction): Promise<Date> {
  const result = await tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  const now = result[0] ? new Date(result[0].now) : null;
  if (!now || !Number.isFinite(now.getTime())) {
    throw new Error('Database clock unavailable');
  }
  return now;
}

async function runtimeRow(tx: Transaction) {
  await tx.insert(mediaCacheRuntime).values({ singletonKey: 'local' }).onConflictDoNothing();
  const [runtime] = await tx
    .select()
    .from(mediaCacheRuntime)
    .where(eq(mediaCacheRuntime.singletonKey, 'local'))
    .for('update');
  if (!runtime) {
    throw new Error('Media cache runtime missing');
  }
  return runtime;
}

function assertLease(input: {
  leaseExpiresAt: Date;
  leaseOwner: string;
  leaseToken: string;
  objectId: string;
}): void {
  if (
    !UUID.test(input.objectId) ||
    !UUID.test(input.leaseToken) ||
    input.leaseOwner.trim().length < 1 ||
    input.leaseOwner.trim().length > 255
  ) {
    throw new TypeError('Invalid thumbnail lease');
  }
}

function assertPublished(object: PublishedMediaCacheThumbnail, leaseToken: string): void {
  if (
    !UUID.test(leaseToken) ||
    !UUID.test(object.objectId) ||
    !SHA256.test(object.sha256) ||
    object.detectedMime !== 'image/webp' ||
    object.byteLength <= 0n ||
    object.byteLength > THUMBNAIL_MAX_BYTES ||
    object.relativeKey !==
      `blobs/${object.sha256.slice(0, 2)}/${object.sha256.slice(2, 4)}/${object.sha256}`
  ) {
    throw new TypeError('Invalid published thumbnail identity');
  }
}

function isThumbnailInput(kind: string, mime: string): boolean {
  return kind === 'photo'
    ? ['image/avif', 'image/jpeg', 'image/png', 'image/webp'].includes(mime)
    : kind === 'animation' && ['image/gif', 'image/webp'].includes(mime);
}
