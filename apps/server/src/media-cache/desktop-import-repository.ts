import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  importRunObservations,
  importRuns,
  mediaCacheActions,
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
import { PostgresMediaCacheWorkerRepository } from './worker-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;

export class DesktopImportProvenanceError extends Error {
  readonly code = 'desktop_import_provenance_invalid';

  constructor() {
    super('The Desktop import provenance could not be verified');
    this.name = 'DesktopImportProvenanceError';
  }
}

export class PostgresDesktopMediaCacheRepository implements MediaCacheWorkerWorkRepository {
  private readonly offeredPlanIds = new Set<string>();
  private readonly thumbnails: PostgresMediaCacheWorkerRepository;

  constructor(
    private readonly database: Database,
    private readonly importRunId: string,
  ) {
    if (!UUID.test(importRunId)) {
      throw new DesktopImportProvenanceError();
    }
    this.thumbnails = new PostgresMediaCacheWorkerRepository(database);
  }

  async verifyCompletedImport(sourceFileSha256: string): Promise<void> {
    if (!SHA256.test(sourceFileSha256)) {
      throw new DesktopImportProvenanceError();
    }
    const [run] = await this.database
      .select({ id: importRuns.id })
      .from(importRuns)
      .where(
        and(
          eq(importRuns.id, this.importRunId),
          eq(importRuns.sourceKind, 'telegram_desktop_json'),
          eq(importRuns.status, 'completed'),
          eq(importRuns.sourceFileSha256, sourceFileSha256),
          isNotNull(importRuns.completedAt),
        ),
      )
      .limit(1);
    if (!run) {
      throw new DesktopImportProvenanceError();
    }
  }

  async listRunnablePostPlanIds(limit: number): Promise<string[]> {
    assertLimit(limit);
    const evidence = await this.database
      .select({
        objectId: mediaCacheObjects.id,
        planId: mediaCachePostPlans.id,
      })
      .from(importRunObservations)
      .innerJoin(
        messageSourceObservations,
        and(
          eq(messageSourceObservations.id, importRunObservations.observationId),
          eq(messageSourceObservations.sourceKind, importRunObservations.sourceKind),
          inArray(messageSourceObservations.resolution, ['created', 'matched']),
          isNotNull(messageSourceObservations.revisionId),
        ),
      )
      .innerJoin(
        messageSourceMediaObservations,
        and(
          eq(messageSourceMediaObservations.observationId, messageSourceObservations.id),
          eq(messageSourceMediaObservations.sourceKind, 'telegram_desktop_json'),
          eq(messageSourceMediaObservations.availability, 'available'),
          isNotNull(messageSourceMediaObservations.desktopSourcePath),
        ),
      )
      .innerJoin(
        mediaCacheObjectSources,
        eq(mediaCacheObjectSources.sourceMediaObservationId, messageSourceMediaObservations.id),
      )
      .innerJoin(
        mediaCacheObjects,
        and(
          eq(mediaCacheObjects.id, mediaCacheObjectSources.objectId),
          eq(mediaCacheObjects.revisionId, messageSourceObservations.revisionId),
          eq(mediaCacheObjects.variant, 'original'),
          inArray(mediaCacheObjects.state, ['awaiting_local_source', 'discovered']),
        ),
      )
      .innerJoin(
        messageMedia,
        and(
          eq(messageMedia.id, mediaCacheObjects.canonicalMediaId),
          eq(messageMedia.position, messageSourceMediaObservations.position),
          eq(messageMedia.kind, messageSourceMediaObservations.mediaKind),
        ),
      )
      .innerJoin(
        mediaCachePostPlans,
        and(
          eq(mediaCachePostPlans.id, mediaCacheObjects.postPlanId),
          inArray(mediaCachePostPlans.state, ['awaiting_local_source', 'discovered']),
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
          eq(importRunObservations.runId, this.importRunId),
          inArray(importRunObservations.resolutionAtRun, ['created', 'matched']),
        ),
      )
      .orderBy(asc(mediaCachePostPlans.id), asc(mediaCacheObjects.id));

    const exactObjectsByPlan = new Map<string, Set<string>>();
    for (const row of evidence) {
      const ids = exactObjectsByPlan.get(row.planId) ?? new Set<string>();
      ids.add(row.objectId);
      exactObjectsByPlan.set(row.planId, ids);
    }
    const candidatePlanIds = [...exactObjectsByPlan.keys()];
    if (candidatePlanIds.length === 0) {
      return [];
    }
    const activeObjects = await this.database
      .select({ objectId: mediaCacheObjects.id, planId: mediaCacheObjects.postPlanId })
      .from(mediaCacheObjects)
      .where(
        and(
          inArray(mediaCacheObjects.postPlanId, candidatePlanIds),
          eq(mediaCacheObjects.variant, 'original'),
          ne(mediaCacheObjects.state, 'skipped'),
        ),
      )
      .orderBy(asc(mediaCacheObjects.postPlanId), asc(mediaCacheObjects.id));
    const activeObjectsByPlan = new Map<string, Set<string>>();
    for (const row of activeObjects) {
      const ids = activeObjectsByPlan.get(row.planId) ?? new Set<string>();
      ids.add(row.objectId);
      activeObjectsByPlan.set(row.planId, ids);
    }

    const runnable = candidatePlanIds
      .filter((planId) => !this.offeredPlanIds.has(planId))
      .filter((planId) => {
        const exact = exactObjectsByPlan.get(planId);
        const active = activeObjectsByPlan.get(planId);
        return (
          exact !== undefined &&
          active !== undefined &&
          exact.size === active.size &&
          [...active].every((objectId) => exact.has(objectId))
        );
      })
      .slice(0, limit);
    for (const planId of runnable) {
      this.offeredPlanIds.add(planId);
    }
    return runnable;
  }

  offeredPlanCount(): number {
    return this.offeredPlanIds.size;
  }

  async listExpiredPostPlanIds(_limit: number): Promise<string[]> {
    return [];
  }

  async loadClaimedOriginals(
    planId: string,
    leaseToken: string,
  ): Promise<ClaimedMediaCacheOriginal[]> {
    if (!this.offeredPlanIds.has(planId) || !UUID.test(leaseToken)) {
      return [];
    }
    const rows = await this.database
      .select({
        kind: messageMedia.kind,
        objectId: mediaCacheObjects.id,
        position: messageMedia.position,
        sourcePath: messageSourceMediaObservations.desktopSourcePath,
      })
      .from(mediaCacheObjects)
      .innerJoin(messageMedia, eq(messageMedia.id, mediaCacheObjects.canonicalMediaId))
      .innerJoin(
        mediaCacheObjectSources,
        eq(mediaCacheObjectSources.objectId, mediaCacheObjects.id),
      )
      .innerJoin(
        messageSourceMediaObservations,
        and(
          eq(messageSourceMediaObservations.id, mediaCacheObjectSources.sourceMediaObservationId),
          eq(messageSourceMediaObservations.sourceKind, 'telegram_desktop_json'),
          eq(messageSourceMediaObservations.availability, 'available'),
          eq(messageSourceMediaObservations.position, messageMedia.position),
          eq(messageSourceMediaObservations.mediaKind, messageMedia.kind),
          isNotNull(messageSourceMediaObservations.desktopSourcePath),
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
        importRunObservations,
        and(
          eq(importRunObservations.runId, this.importRunId),
          eq(importRunObservations.observationId, messageSourceObservations.id),
          inArray(importRunObservations.resolutionAtRun, ['created', 'matched']),
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
          eq(mediaCacheObjects.postPlanId, planId),
          eq(mediaCacheObjects.variant, 'original'),
          eq(mediaCacheObjects.state, 'downloading'),
          eq(mediaCacheObjects.leaseToken, leaseToken),
          isNotNull(mediaCacheObjects.leaseExpiresAt),
          sql`${mediaCacheObjects.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .orderBy(
        asc(messageMedia.position),
        asc(mediaCacheObjects.id),
        asc(mediaCacheObjectSources.sourcePriority),
        asc(messageSourceMediaObservations.createdAt),
        asc(messageSourceMediaObservations.id),
      );

    const objects = new Map<
      string,
      {
        kind: ClaimedMediaCacheOriginal['kind'];
        objectId: string;
        position: number;
        sources: Array<{ fileId: string }>;
      }
    >();
    for (const row of rows) {
      if (
        !row.sourcePath ||
        (row.kind !== 'photo' && row.kind !== 'animation' && row.kind !== 'video')
      ) {
        continue;
      }
      const object = objects.get(row.objectId) ?? {
        kind: row.kind,
        objectId: row.objectId,
        position: row.position,
        sources: [],
      };
      object.sources.push({ fileId: row.sourcePath });
      objects.set(row.objectId, object);
    }
    return [...objects.values()].sort(
      (left, right) =>
        left.position - right.position || left.objectId.localeCompare(right.objectId),
    );
  }

  async ensureThumbnailObjects(planId: string): Promise<number> {
    return this.thumbnails.ensureThumbnailObjects(planId);
  }

  async recordCompletedActions(input: { initiatorId: string; reason: string }): Promise<number> {
    const planIds = [...this.offeredPlanIds];
    if (planIds.length === 0) {
      return 0;
    }
    const objects = await this.database
      .select({ id: mediaCacheObjects.id })
      .from(mediaCacheObjects)
      .innerJoin(mediaCachePostPlans, eq(mediaCachePostPlans.id, mediaCacheObjects.postPlanId))
      .where(
        and(
          inArray(mediaCachePostPlans.id, planIds),
          eq(mediaCachePostPlans.state, 'ready'),
          eq(mediaCacheObjects.variant, 'original'),
          eq(mediaCacheObjects.state, 'ready'),
        ),
      )
      .orderBy(asc(mediaCacheObjects.id));
    if (objects.length === 0) {
      return 0;
    }
    await this.database.insert(mediaCacheActions).values(
      objects.map((object) => ({
        actionKind: 'retry' as const,
        afterState: { state: 'ready' },
        beforeState: { importRunId: this.importRunId, state: 'awaiting_local_source' },
        initiatorId: input.initiatorId,
        initiatorKind: 'local_operator' as const,
        objectId: object.id,
        reason: input.reason,
      })),
    );
    return objects.length;
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4) {
    throw new RangeError('Desktop media cache plan limit must be between 1 and 4');
  }
}
