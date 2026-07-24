import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  mediaCacheObjectSources,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  messageMedia,
  messageRevisions,
  messageSourceMediaObservations,
  messageSourceObservations,
  messages,
} from '../db/schema.js';
import { lockSourceEvidenceDiscovery } from '../messages/source-evidence-coordination.js';
import { type OriginalMediaPlanItem, planOriginalMediaCache } from './policy.js';

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const ORIGINAL_RECIPE_VERSION = 1;
const BOT_SOURCE_PRIORITY = 0;
const DESKTOP_SOURCE_PRIORITY = 1;

export interface MediaCacheDiscoveryCursor {
  createdAt: Date;
  id: string;
}

export interface MediaCacheDiscoveryResult {
  cursor: MediaCacheDiscoveryCursor | null;
  objectsCreated: number;
  plansCreated: number;
  scanned: number;
  sourcesCreated: number;
}

interface DiscoveryOptions {
  batchSize?: number;
}

type DiscoveryTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type EligibleEvidence = Awaited<ReturnType<typeof loadRevisionEvidence>>[number];

/**
 * Discovers durable media-cache work without performing network or filesystem I/O.
 *
 * The runtime row is both the durable keyset cursor and the serialization point. A
 * successful call consumes at most `batchSize` append-only evidence rows; invalid
 * rows are consumed too so they cannot poison subsequent discovery.
 */
export class PostgresMediaCacheDiscoveryRepository {
  private readonly batchSize: number;

  constructor(
    private readonly database: Database,
    options: DiscoveryOptions = {},
  ) {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
      throw new RangeError(`batchSize must be a safe integer between 1 and ${MAX_BATCH_SIZE}`);
    }
    this.batchSize = batchSize;
  }

  async discoverBatch(): Promise<MediaCacheDiscoveryResult> {
    return this.database.transaction(async (transaction) => {
      await lockSourceEvidenceDiscovery(transaction);
      await transaction
        .insert(mediaCacheRuntime)
        .values({ singletonKey: 'local' })
        .onConflictDoNothing({ target: mediaCacheRuntime.singletonKey });

      const [runtime] = await transaction
        .select({
          createdAt: mediaCacheRuntime.discoveryCursorCreatedAt,
          id: mediaCacheRuntime.discoveryCursorId,
        })
        .from(mediaCacheRuntime)
        .where(eq(mediaCacheRuntime.singletonKey, 'local'))
        .limit(1)
        .for('update');
      if (!runtime) {
        throw new Error('Media cache runtime initialization failed');
      }

      const cursor =
        runtime.createdAt && runtime.id ? { createdAt: runtime.createdAt, id: runtime.id } : null;
      const batch = await transaction
        .select({
          createdAt: messageSourceMediaObservations.createdAt,
          id: messageSourceMediaObservations.id,
        })
        .from(messageSourceMediaObservations)
        .where(
          cursor
            ? or(
                gt(messageSourceMediaObservations.createdAt, cursor.createdAt),
                and(
                  eq(messageSourceMediaObservations.createdAt, cursor.createdAt),
                  gt(messageSourceMediaObservations.id, cursor.id),
                ),
              )
            : undefined,
        )
        .orderBy(
          asc(messageSourceMediaObservations.createdAt),
          asc(messageSourceMediaObservations.id),
        )
        .limit(this.batchSize);

      if (batch.length === 0) {
        return {
          cursor,
          objectsCreated: 0,
          plansCreated: 0,
          scanned: 0,
          sourcesCreated: 0,
        };
      }

      const revisionRows = await transaction
        .selectDistinct({ revisionId: messageSourceObservations.revisionId })
        .from(messageSourceMediaObservations)
        .innerJoin(
          messageSourceObservations,
          and(
            eq(messageSourceObservations.id, messageSourceMediaObservations.observationId),
            eq(messageSourceObservations.sourceKind, messageSourceMediaObservations.sourceKind),
          ),
        )
        .innerJoin(
          messageRevisions,
          and(
            eq(messageRevisions.id, messageSourceObservations.revisionId),
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
              messageSourceMediaObservations.id,
              batch.map(({ id }) => id),
            ),
            eq(messageSourceMediaObservations.availability, 'available'),
            inArray(messageSourceMediaObservations.mediaKind, ['photo', 'animation', 'video']),
            inArray(messageSourceObservations.resolution, ['created', 'matched']),
            isNotNull(messageSourceObservations.revisionId),
          ),
        );

      let plansCreated = 0;
      let objectsCreated = 0;
      let sourcesCreated = 0;
      for (const { revisionId } of revisionRows) {
        if (!revisionId) {
          continue;
        }
        const created = await discoverRevision(transaction, revisionId);
        plansCreated += created.plans;
        objectsCreated += created.objects;
        sourcesCreated += created.sources;
      }

      const last = batch.at(-1);
      if (!last) {
        throw new Error('Discovery batch unexpectedly had no final cursor');
      }
      await transaction
        .update(mediaCacheRuntime)
        .set({
          discoveryCursorCreatedAt: last.createdAt,
          discoveryCursorId: last.id,
          updatedAt: new Date(),
        })
        .where(eq(mediaCacheRuntime.singletonKey, 'local'));

      return {
        cursor: last,
        objectsCreated,
        plansCreated,
        scanned: batch.length,
        sourcesCreated,
      };
    });
  }
}

async function discoverRevision(
  transaction: DiscoveryTransaction,
  revisionId: string,
): Promise<{ objects: number; plans: number; sources: number }> {
  const canonicalMedia = await loadCanonicalRevisionMedia(transaction, revisionId);
  const evidence = await loadRevisionEvidence(transaction, revisionId);
  if (canonicalMedia.length === 0 || evidence.length === 0) {
    return { objects: 0, plans: 0, sources: 0 };
  }

  const byCanonicalMedia = groupEvidence(evidence);
  const policy = planOriginalMediaCache(
    canonicalMedia.map((canonical) => ({
      declaredBytes: canonical.declaredBytes,
      id: canonical.id,
      kind: canonical.kind,
      position: canonical.position,
    })),
  );
  const eligible = policy.items.filter((item) => item.decision === 'eligible');
  const allEligibleAreBotBacked = eligible.every((item) =>
    byCanonicalMedia
      .get(item.id)
      ?.sources.some((source) => source.sourceKind === 'telegram_bot_update'),
  );
  const planState =
    policy.decision === 'skipped_post_limit' || eligible.length === 0
      ? 'skipped'
      : allEligibleAreBotBacked
        ? 'discovered'
        : 'awaiting_local_source';
  const planReason =
    policy.decision === 'skipped_post_limit'
      ? 'skipped_post_limit'
      : eligible.length === 0
        ? 'skipped_kind_limit'
        : null;

  const firstCanonicalMedia = canonicalMedia[0];
  if (!firstCanonicalMedia) {
    throw new Error('Canonical revision media unexpectedly became empty');
  }
  const insertedPlans = await transaction
    .insert(mediaCachePostPlans)
    .values({
      messageId: firstCanonicalMedia.messageId,
      reasonCode: planReason,
      revisionId,
      state: planState,
    })
    .onConflictDoNothing({ target: mediaCachePostPlans.revisionId })
    .returning({ id: mediaCachePostPlans.id });
  const [plan] = await transaction
    .select({
      id: mediaCachePostPlans.id,
      state: mediaCachePostPlans.state,
    })
    .from(mediaCachePostPlans)
    .where(eq(mediaCachePostPlans.revisionId, revisionId))
    .limit(1)
    .for('update');
  if (!plan) {
    throw new Error('Media cache post plan initialization failed');
  }
  const planWasCreated = insertedPlans.length === 1;
  const planCanAbsorbEvidence =
    plan.state === 'discovered' || plan.state === 'awaiting_local_source';
  if (!planWasCreated && !planCanAbsorbEvidence) {
    return { objects: 0, plans: 0, sources: 0 };
  }

  const insertedObjects = await transaction
    .insert(mediaCacheObjects)
    .values(
      policy.items.map((item) => {
        const sources = byCanonicalMedia.get(item.id)?.sources ?? [];
        return objectInsert(plan.id, revisionId, item, sources);
      }),
    )
    .onConflictDoNothing({
      target: [
        mediaCacheObjects.canonicalMediaId,
        mediaCacheObjects.variant,
        mediaCacheObjects.recipeVersion,
      ],
    })
    .returning({ id: mediaCacheObjects.id });

  const botBackedEligibleIds = eligible.flatMap((item) =>
    byCanonicalMedia
      .get(item.id)
      ?.sources.some((source) => source.sourceKind === 'telegram_bot_update')
      ? [item.id]
      : [],
  );
  if (botBackedEligibleIds.length > 0) {
    const now = new Date();
    await transaction
      .update(mediaCacheObjects)
      .set({ reasonCode: null, state: 'discovered', updatedAt: now })
      .where(
        and(
          eq(mediaCacheObjects.revisionId, revisionId),
          eq(mediaCacheObjects.variant, 'original'),
          eq(mediaCacheObjects.recipeVersion, ORIGINAL_RECIPE_VERSION),
          eq(mediaCacheObjects.state, 'awaiting_local_source'),
          inArray(mediaCacheObjects.canonicalMediaId, botBackedEligibleIds),
        ),
      );
    if (allEligibleAreBotBacked) {
      await transaction
        .update(mediaCachePostPlans)
        .set({ reasonCode: null, state: 'discovered', updatedAt: now })
        .where(
          and(
            eq(mediaCachePostPlans.id, plan.id),
            eq(mediaCachePostPlans.state, 'awaiting_local_source'),
          ),
        );
    }
  }

  const objects = await transaction
    .select({
      canonicalMediaId: mediaCacheObjects.canonicalMediaId,
      id: mediaCacheObjects.id,
    })
    .from(mediaCacheObjects)
    .where(
      and(
        eq(mediaCacheObjects.revisionId, revisionId),
        eq(mediaCacheObjects.variant, 'original'),
        eq(mediaCacheObjects.recipeVersion, ORIGINAL_RECIPE_VERSION),
        inArray(
          mediaCacheObjects.canonicalMediaId,
          policy.items.map(({ id }) => id),
        ),
      ),
    );
  const objectByCanonicalMedia = new Map(
    objects.map((object) => [object.canonicalMediaId, object.id]),
  );
  const sourceValues = policy.items.flatMap((item) => {
    const objectId = objectByCanonicalMedia.get(item.id);
    if (!objectId) {
      throw new Error('Media cache object initialization failed');
    }
    return (byCanonicalMedia.get(item.id)?.sources ?? []).map((source) => ({
      objectId,
      sourceMediaObservationId: source.id,
      sourcePriority:
        source.sourceKind === 'telegram_bot_update' ? BOT_SOURCE_PRIORITY : DESKTOP_SOURCE_PRIORITY,
    }));
  });
  const insertedSources =
    sourceValues.length === 0
      ? []
      : await transaction
          .insert(mediaCacheObjectSources)
          .values(sourceValues)
          .onConflictDoNothing({
            target: [
              mediaCacheObjectSources.objectId,
              mediaCacheObjectSources.sourceMediaObservationId,
            ],
          })
          .returning({ objectId: mediaCacheObjectSources.objectId });

  return {
    objects: insertedObjects.length,
    plans: insertedPlans.length,
    sources: insertedSources.length,
  };
}

async function loadCanonicalRevisionMedia(transaction: DiscoveryTransaction, revisionId: string) {
  return transaction
    .select({
      declaredBytes: messageMedia.fileSize,
      id: messageMedia.id,
      kind: messageMedia.kind,
      messageId: messageRevisions.messageId,
      position: messageMedia.position,
    })
    .from(messageMedia)
    .innerJoin(
      messageRevisions,
      and(eq(messageRevisions.id, messageMedia.revisionId), eq(messageRevisions.id, revisionId)),
    )
    .innerJoin(
      messages,
      and(
        eq(messages.id, messageRevisions.messageId),
        eq(messages.currentRevisionNumber, messageRevisions.revisionNumber),
        isNull(messages.tombstonedAt),
      ),
    )
    .orderBy(asc(messageMedia.position), asc(messageMedia.id));
}

async function loadRevisionEvidence(transaction: DiscoveryTransaction, revisionId: string) {
  return transaction
    .select({
      canonicalMediaId: messageMedia.id,
      createdAt: messageSourceMediaObservations.createdAt,
      declaredBytes: messageMedia.fileSize,
      id: messageSourceMediaObservations.id,
      kind: messageMedia.kind,
      messageId: messageRevisions.messageId,
      position: messageMedia.position,
      sourceKind: messageSourceMediaObservations.sourceKind,
    })
    .from(messageSourceMediaObservations)
    .innerJoin(
      messageSourceObservations,
      and(
        eq(messageSourceObservations.id, messageSourceMediaObservations.observationId),
        eq(messageSourceObservations.sourceKind, messageSourceMediaObservations.sourceKind),
      ),
    )
    .innerJoin(
      messageRevisions,
      and(
        eq(messageRevisions.id, messageSourceObservations.revisionId),
        eq(messageRevisions.messageId, messageSourceObservations.messageId),
        eq(messageRevisions.id, revisionId),
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
    .innerJoin(
      messageMedia,
      and(
        eq(messageMedia.revisionId, messageRevisions.id),
        eq(messageMedia.position, messageSourceMediaObservations.position),
        eq(messageMedia.kind, messageSourceMediaObservations.mediaKind),
      ),
    )
    .where(
      and(
        eq(messageSourceMediaObservations.availability, 'available'),
        inArray(messageSourceMediaObservations.mediaKind, ['photo', 'animation', 'video']),
        inArray(messageSourceObservations.resolution, ['created', 'matched']),
        isNotNull(messageSourceObservations.revisionId),
      ),
    )
    .orderBy(
      asc(messageMedia.position),
      asc(messageMedia.id),
      asc(messageSourceMediaObservations.createdAt),
      asc(messageSourceMediaObservations.id),
    );
}

function groupEvidence(evidence: readonly EligibleEvidence[]) {
  const grouped = new Map<
    string,
    {
      canonical: {
        declaredBytes: bigint | null;
        id: string;
        kind: EligibleEvidence['kind'];
        position: number;
      };
      sources: EligibleEvidence[];
    }
  >();
  for (const row of evidence) {
    const current = grouped.get(row.canonicalMediaId);
    if (current) {
      current.sources.push(row);
      continue;
    }
    grouped.set(row.canonicalMediaId, {
      canonical: {
        declaredBytes: row.declaredBytes,
        id: row.canonicalMediaId,
        kind: row.kind,
        position: row.position,
      },
      sources: [row],
    });
  }
  return grouped;
}

function objectInsert(
  postPlanId: string,
  revisionId: string,
  item: OriginalMediaPlanItem,
  sources: readonly EligibleEvidence[],
): typeof mediaCacheObjects.$inferInsert {
  if (item.decision !== 'eligible') {
    return {
      canonicalMediaId: item.id,
      declaredBytes: item.declaredBytes,
      postPlanId,
      reasonCode: item.decision,
      recipeVersion: ORIGINAL_RECIPE_VERSION,
      revisionId,
      state: 'skipped',
      variant: 'original',
    };
  }
  const botBacked = sources.some((source) => source.sourceKind === 'telegram_bot_update');
  return {
    canonicalMediaId: item.id,
    declaredBytes: item.declaredBytes,
    postPlanId,
    recipeVersion: ORIGINAL_RECIPE_VERSION,
    revisionId,
    state: botBacked ? 'discovered' : 'awaiting_local_source',
    variant: 'original',
  };
}
