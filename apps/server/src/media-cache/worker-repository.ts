import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  mediaCacheBlobs,
  mediaCacheObjectSources,
  mediaCacheObjects,
  mediaCachePostPlans,
  messageMedia,
  messageRevisions,
  messageSourceMediaObservations,
  messageSourceObservations,
  messages,
} from '../db/schema.js';
import type { ClaimedMediaCacheOriginal, MediaCacheWorkerWorkRepository } from './worker.js';

const MAX_QUERY_LIMIT = 4;
const THUMBNAIL_RECIPE_VERSION = 1;
const THUMBNAIL_INPUT_MIMES = [
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export class PostgresMediaCacheWorkerRepository implements MediaCacheWorkerWorkRepository {
  constructor(private readonly database: Database) {}

  async listRunnablePostPlanIds(limit: number): Promise<string[]> {
    assertLimit(limit);
    const rows = await this.database
      .select({ id: mediaCachePostPlans.id })
      .from(mediaCachePostPlans)
      .where(
        and(
          inArray(mediaCachePostPlans.state, ['discovered', 'retry_wait']),
          lte(mediaCachePostPlans.availableAt, sql<Date>`clock_timestamp()`),
          lt(mediaCachePostPlans.attemptCount, 10),
        ),
      )
      .orderBy(asc(mediaCachePostPlans.availableAt), asc(mediaCachePostPlans.id))
      .limit(limit);
    return rows.map(({ id }) => id);
  }

  async discoverThumbnailObjects(limit = MAX_QUERY_LIMIT): Promise<number> {
    assertLimit(limit);
    const plans = await this.database
      .selectDistinct({ id: mediaCachePostPlans.id })
      .from(mediaCachePostPlans)
      .innerJoin(mediaCacheObjects, eq(mediaCacheObjects.postPlanId, mediaCachePostPlans.id))
      .innerJoin(messageMedia, eq(messageMedia.id, mediaCacheObjects.canonicalMediaId))
      .innerJoin(mediaCacheBlobs, eq(mediaCacheBlobs.sha256, mediaCacheObjects.blobSha256))
      .where(
        and(
          eq(mediaCachePostPlans.state, 'ready'),
          eq(mediaCacheObjects.variant, 'original'),
          eq(mediaCacheObjects.state, 'ready'),
          eq(mediaCacheBlobs.state, 'ready'),
          inArray(mediaCacheBlobs.detectedMime, THUMBNAIL_INPUT_MIMES),
          or(eq(messageMedia.kind, 'photo'), eq(messageMedia.kind, 'animation')),
        ),
      )
      .orderBy(asc(mediaCachePostPlans.id))
      .limit(limit);
    let created = 0;
    for (const plan of plans) {
      created += await this.ensureThumbnailObjects(plan.id);
    }
    return created;
  }

  async listExpiredPostPlanIds(limit: number): Promise<string[]> {
    assertLimit(limit);
    // Recovery is maintenance work and must remain runnable after content attempts are exhausted.
    const rows = await this.database
      .select({ id: mediaCachePostPlans.id })
      .from(mediaCachePostPlans)
      .where(
        and(
          inArray(mediaCachePostPlans.state, ['staging', 'settling', 'recovering']),
          isNotNull(mediaCachePostPlans.leaseToken),
          isNotNull(mediaCachePostPlans.leaseExpiresAt),
          lte(mediaCachePostPlans.leaseExpiresAt, sql<Date>`clock_timestamp()`),
          lte(mediaCachePostPlans.availableAt, sql<Date>`clock_timestamp()`),
        ),
      )
      .orderBy(asc(mediaCachePostPlans.availableAt), asc(mediaCachePostPlans.id))
      .limit(limit);
    return rows.map(({ id }) => id);
  }

  async listRunnableThumbnailObjectIds(limit = 1): Promise<string[]> {
    assertLimit(limit);
    const rows = await this.database
      .select({ id: mediaCacheObjects.id })
      .from(mediaCacheObjects)
      .innerJoin(mediaCachePostPlans, eq(mediaCachePostPlans.id, mediaCacheObjects.postPlanId))
      .innerJoin(messageMedia, eq(messageMedia.id, mediaCacheObjects.canonicalMediaId))
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
          eq(mediaCacheObjects.variant, 'thumbnail'),
          inArray(mediaCacheObjects.state, ['discovered', 'retry_wait']),
          lte(mediaCacheObjects.availableAt, sql<Date>`clock_timestamp()`),
          eq(mediaCachePostPlans.state, 'ready'),
        ),
      )
      .orderBy(asc(mediaCacheObjects.availableAt), asc(mediaCacheObjects.id))
      .limit(limit);
    return rows.map(({ id }) => id);
  }

  async listExpiredThumbnailObjectIds(limit = 1): Promise<string[]> {
    assertLimit(limit);
    const rows = await this.database
      .select({ id: mediaCacheObjects.id })
      .from(mediaCacheObjects)
      .where(
        and(
          eq(mediaCacheObjects.variant, 'thumbnail'),
          inArray(mediaCacheObjects.state, ['downloading', 'staging']),
          isNotNull(mediaCacheObjects.leaseExpiresAt),
          lte(mediaCacheObjects.leaseExpiresAt, sql<Date>`clock_timestamp()`),
        ),
      )
      .orderBy(asc(mediaCacheObjects.leaseExpiresAt), asc(mediaCacheObjects.id))
      .limit(limit);
    return rows.map(({ id }) => id);
  }

  async loadClaimedOriginals(
    planId: string,
    leaseToken: string,
  ): Promise<ClaimedMediaCacheOriginal[]> {
    const objects = await this.database
      .select({
        kind: messageMedia.kind,
        objectId: mediaCacheObjects.id,
        position: messageMedia.position,
      })
      .from(mediaCacheObjects)
      .innerJoin(messageMedia, eq(messageMedia.id, mediaCacheObjects.canonicalMediaId))
      .where(
        and(
          eq(mediaCacheObjects.postPlanId, planId),
          eq(mediaCacheObjects.variant, 'original'),
          eq(mediaCacheObjects.state, 'downloading'),
          eq(mediaCacheObjects.leaseToken, leaseToken),
          isNotNull(mediaCacheObjects.leaseExpiresAt),
          gt(mediaCacheObjects.leaseExpiresAt, sql<Date>`clock_timestamp()`),
        ),
      )
      .orderBy(asc(messageMedia.position), asc(mediaCacheObjects.id));
    if (objects.length === 0) {
      return [];
    }

    const sources = await this.database
      .select({
        fileId: messageSourceMediaObservations.telegramFileId,
        objectId: mediaCacheObjectSources.objectId,
      })
      .from(mediaCacheObjectSources)
      .innerJoin(mediaCacheObjects, eq(mediaCacheObjects.id, mediaCacheObjectSources.objectId))
      .innerJoin(messageMedia, eq(messageMedia.id, mediaCacheObjects.canonicalMediaId))
      .innerJoin(
        messageSourceMediaObservations,
        and(
          eq(messageSourceMediaObservations.id, mediaCacheObjectSources.sourceMediaObservationId),
          eq(messageSourceMediaObservations.sourceKind, 'telegram_bot_update'),
          eq(messageSourceMediaObservations.availability, 'available'),
          eq(messageSourceMediaObservations.position, messageMedia.position),
          eq(messageSourceMediaObservations.mediaKind, messageMedia.kind),
        ),
      )
      .innerJoin(
        messageSourceObservations,
        and(
          eq(messageSourceObservations.id, messageSourceMediaObservations.observationId),
          eq(messageSourceObservations.sourceKind, messageSourceMediaObservations.sourceKind),
          eq(messageSourceObservations.revisionId, mediaCacheObjects.revisionId),
          inArray(messageSourceObservations.resolution, ['created', 'matched']),
        ),
      )
      .innerJoin(
        messageRevisions,
        and(
          eq(messageRevisions.id, mediaCacheObjects.revisionId),
          eq(messageRevisions.messageId, messageSourceObservations.messageId),
        ),
      )
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
          inArray(
            mediaCacheObjectSources.objectId,
            objects.map(({ objectId }) => objectId),
          ),
          isNotNull(messageSourceMediaObservations.telegramFileId),
        ),
      )
      .orderBy(
        asc(messageMedia.position),
        asc(mediaCacheObjects.id),
        asc(mediaCacheObjectSources.sourcePriority),
        asc(messageSourceMediaObservations.createdAt),
        asc(messageSourceMediaObservations.id),
      );
    const sourcesByObject = new Map<string, Array<{ fileId: string }>>();
    for (const source of sources) {
      if (!source.fileId) {
        continue;
      }
      const current = sourcesByObject.get(source.objectId) ?? [];
      current.push({ fileId: source.fileId });
      sourcesByObject.set(source.objectId, current);
    }

    return objects.flatMap((object) => {
      if (object.kind !== 'photo' && object.kind !== 'animation' && object.kind !== 'video') {
        return [];
      }
      return [
        {
          kind: object.kind,
          objectId: object.objectId,
          position: object.position,
          sources: sourcesByObject.get(object.objectId) ?? [],
        },
      ];
    });
  }

  async ensureThumbnailObjects(planId: string): Promise<number> {
    const originals = await this.database
      .select({
        canonicalMediaId: mediaCacheObjects.canonicalMediaId,
        kind: messageMedia.kind,
        revisionId: mediaCacheObjects.revisionId,
      })
      .from(mediaCacheObjects)
      .innerJoin(mediaCachePostPlans, eq(mediaCachePostPlans.id, mediaCacheObjects.postPlanId))
      .innerJoin(messageMedia, eq(messageMedia.id, mediaCacheObjects.canonicalMediaId))
      .innerJoin(mediaCacheBlobs, eq(mediaCacheBlobs.sha256, mediaCacheObjects.blobSha256))
      .where(
        and(
          eq(mediaCacheObjects.postPlanId, planId),
          eq(mediaCacheObjects.variant, 'original'),
          eq(mediaCacheObjects.state, 'ready'),
          eq(mediaCachePostPlans.state, 'ready'),
          eq(mediaCacheBlobs.state, 'ready'),
          inArray(mediaCacheBlobs.detectedMime, THUMBNAIL_INPUT_MIMES),
          or(eq(messageMedia.kind, 'photo'), eq(messageMedia.kind, 'animation')),
        ),
      )
      .orderBy(asc(messageMedia.position), asc(mediaCacheObjects.id));
    if (originals.length === 0) {
      return 0;
    }
    const inserted = await this.database
      .insert(mediaCacheObjects)
      .values(
        originals.map((original) => ({
          canonicalMediaId: original.canonicalMediaId,
          postPlanId: planId,
          recipeVersion: THUMBNAIL_RECIPE_VERSION,
          revisionId: original.revisionId,
          state: 'discovered' as const,
          variant: 'thumbnail' as const,
        })),
      )
      .onConflictDoNothing({
        target: [
          mediaCacheObjects.canonicalMediaId,
          mediaCacheObjects.variant,
          mediaCacheObjects.recipeVersion,
        ],
      })
      .returning({ id: mediaCacheObjects.id });
    return inserted.length;
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new RangeError(`Media cache worker query limit must be between 1 and ${MAX_QUERY_LIMIT}`);
  }
}
