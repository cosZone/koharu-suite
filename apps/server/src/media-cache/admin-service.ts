import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { mediaCacheActions, mediaCacheObjects, mediaCachePostPlans } from '../db/schema.js';
import { type MediaCacheCommandReceipt, PostgresMediaCacheCommandQueue } from './command-queue.js';
import { MEDIA_CACHE_ADVISORY_LOCK } from './ledger-repository.js';

const RETRYABLE_TERMINAL_STATES = [
  'blocked',
  'evicted',
  'integrity_conflict',
  'missing',
  'skipped',
] as const;

type MediaCacheTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface MediaCacheAdminMutationInput {
  initiatorId: string;
  objectId: string;
  reason: string;
}

export interface MediaCacheAdminReconcileInput {
  initiatorId: string;
  reason: string;
}

export interface MediaCacheAdminRetryResult {
  objectIds: string[];
  planId: string;
  state: 'retry_wait';
  variant: 'original' | 'thumbnail';
}

export interface MediaCacheAdminMutations {
  evict(input: MediaCacheAdminMutationInput): Promise<MediaCacheCommandReceipt>;
  reconcile(input: MediaCacheAdminReconcileInput): Promise<MediaCacheCommandReceipt>;
  retry(input: MediaCacheAdminMutationInput): Promise<MediaCacheAdminRetryResult>;
}

export class MediaCacheAdminNotFoundError extends Error {
  constructor(message = 'Media cache object was not found') {
    super(message);
    this.name = 'MediaCacheAdminNotFoundError';
  }
}

export class MediaCacheAdminConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaCacheAdminConflictError';
  }
}

export class MediaCacheAdminNotSupportedError extends MediaCacheAdminConflictError {
  constructor() {
    super('Filesystem and database reconciliation is not available yet');
    this.name = 'MediaCacheAdminNotSupportedError';
  }
}

export class PostgresMediaCacheAdminService implements MediaCacheAdminMutations {
  private readonly commands: PostgresMediaCacheCommandQueue;

  constructor(
    private readonly database: Database,
    commands = new PostgresMediaCacheCommandQueue(database),
  ) {
    this.commands = commands;
  }

  async retry(input: MediaCacheAdminMutationInput): Promise<MediaCacheAdminRetryResult> {
    assertMutationInput(input);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${MEDIA_CACHE_ADVISORY_LOCK})`);
      const now = await readDatabaseClock(transaction);
      const [target] = await transaction
        .select({
          attemptCount: mediaCacheObjects.attemptCount,
          id: mediaCacheObjects.id,
          leaseToken: mediaCacheObjects.leaseToken,
          planId: mediaCacheObjects.postPlanId,
          reservedBytes: mediaCacheObjects.reservedBytes,
          state: mediaCacheObjects.state,
          variant: mediaCacheObjects.variant,
        })
        .from(mediaCacheObjects)
        .where(eq(mediaCacheObjects.id, input.objectId))
        .for('update');
      if (!target) {
        throw new MediaCacheAdminNotFoundError();
      }
      assertRetryableObject(target);

      if (target.variant === 'thumbnail') {
        await transaction
          .update(mediaCacheObjects)
          .set(retryObjectState(now))
          .where(eq(mediaCacheObjects.id, target.id));
        await insertRetryAction(transaction, input, {
          afterState: { state: 'retry_wait', variant: 'thumbnail' },
          beforeState: {
            attemptCount: target.attemptCount,
            state: target.state,
            variant: 'thumbnail',
          },
        });
        return {
          objectIds: [target.id],
          planId: target.planId,
          state: 'retry_wait',
          variant: 'thumbnail',
        };
      }

      const [plan] = await transaction
        .select({
          id: mediaCachePostPlans.id,
          readyOriginalBytes: mediaCachePostPlans.readyOriginalBytes,
          reservedOriginalBytes: mediaCachePostPlans.reservedOriginalBytes,
          state: mediaCachePostPlans.state,
        })
        .from(mediaCachePostPlans)
        .where(eq(mediaCachePostPlans.id, target.planId))
        .for('update');
      if (!plan) {
        throw new MediaCacheAdminConflictError('Media cache post plan is missing');
      }
      const originals = await transaction
        .select({
          attemptCount: mediaCacheObjects.attemptCount,
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
      if (originals.length === 0 || plan.reservedOriginalBytes !== 0n) {
        throw new MediaCacheAdminConflictError(
          'The complete original post plan is not in a retryable terminal state',
        );
      }

      const hasReadyOriginals = plan.readyOriginalBytes > 0n;
      const canRetryPartial =
        hasReadyOriginals &&
        originals.every(
          (object) =>
            object.state === 'ready' || object.state === 'skipped' || isRetryableObject(object),
        );
      const canRetryComplete =
        !hasReadyOriginals && originals.every((object) => isRetryableObject(object));
      if (!canRetryPartial && !canRetryComplete) {
        throw new MediaCacheAdminConflictError(
          'The original post plan is not in a retryable terminal state',
        );
      }
      const retriedOriginals = canRetryPartial
        ? originals.filter((object) => object.id === target.id)
        : originals;
      const objectIds = retriedOriginals.map(({ id }) => id);
      await transaction
        .update(mediaCacheObjects)
        .set(retryObjectState(now))
        .where(inArray(mediaCacheObjects.id, objectIds));
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
          reasonCode: null,
          reservedOriginalBytes: 0n,
          state: 'retry_wait',
          updatedAt: now,
        })
        .where(eq(mediaCachePostPlans.id, plan.id));
      await insertRetryAction(transaction, input, {
        afterState: {
          objectCount: objectIds.length,
          preservedReadyOriginalBytes: plan.readyOriginalBytes.toString(),
          planState: 'retry_wait',
          variant: 'original',
        },
        beforeState: {
          objectStates: retriedOriginals.map(({ id, state }) => ({ id, state })),
          planState: plan.state,
          variant: 'original',
        },
      });
      return {
        objectIds,
        planId: plan.id,
        state: 'retry_wait',
        variant: 'original',
      };
    });
  }

  async evict(input: MediaCacheAdminMutationInput): Promise<MediaCacheCommandReceipt> {
    assertMutationInput(input);
    const [target] = await this.database
      .select({ id: mediaCacheObjects.id, state: mediaCacheObjects.state })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.id, input.objectId))
      .limit(1);
    if (!target) {
      throw new MediaCacheAdminNotFoundError();
    }
    if (target.state !== 'ready') {
      throw new MediaCacheAdminConflictError('Media cache object is not ready for eviction');
    }
    return this.commands.enqueue({
      initiatorId: input.initiatorId,
      objectId: target.id,
      operation: 'evict',
      reason: input.reason,
    });
  }

  async reconcile(input: MediaCacheAdminReconcileInput): Promise<MediaCacheCommandReceipt> {
    assertReconcileInput(input);
    return this.commands.enqueue({
      initiatorId: input.initiatorId,
      operation: 'reconcile',
      reason: input.reason,
    });
  }
}

function retryObjectState(now: Date) {
  return {
    attemptCount: 0,
    availableAt: now,
    lastErrorClass: null,
    lastErrorCode: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    leaseToken: null,
    reasonCode: null,
    reservedBytes: 0n,
    state: 'retry_wait' as const,
    updatedAt: now,
  };
}

function assertMutationInput(input: MediaCacheAdminMutationInput): void {
  if (!input.objectId) {
    throw new TypeError('Media cache mutation identifiers must not be empty');
  }
  assertReconcileInput(input);
}

function assertReconcileInput(input: MediaCacheAdminReconcileInput): void {
  if (!input.initiatorId.trim()) {
    throw new TypeError('Media cache mutation identifiers must not be empty');
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) {
    throw new TypeError('Media cache mutation reason must be between 1 and 500 characters');
  }
}

function assertRetryableObject(object: {
  leaseToken: string | null;
  reservedBytes: bigint;
  state: string;
}): void {
  if (!isRetryableObject(object)) {
    throw new MediaCacheAdminConflictError(
      'Media cache object is not in a retryable terminal state',
    );
  }
}

function isRetryableObject(object: {
  leaseToken: string | null;
  reservedBytes: bigint;
  state: string;
}): boolean {
  return (
    RETRYABLE_TERMINAL_STATES.some((state) => state === object.state) &&
    object.leaseToken === null &&
    object.reservedBytes === 0n
  );
}

async function readDatabaseClock(transaction: MediaCacheTransaction): Promise<Date> {
  const [clock] = await transaction.execute<{ now: Date | string }>(
    sql`select clock_timestamp() as now`,
  );
  const now = clock ? new Date(clock.now) : null;
  if (!now || !Number.isFinite(now.getTime())) {
    throw new Error('PostgreSQL returned an invalid clock');
  }
  return now;
}

async function insertRetryAction(
  transaction: MediaCacheTransaction,
  input: MediaCacheAdminMutationInput,
  state: {
    afterState: Record<string, unknown>;
    beforeState: Record<string, unknown>;
  },
): Promise<void> {
  await transaction.insert(mediaCacheActions).values({
    actionKind: 'retry',
    afterState: state.afterState,
    beforeState: state.beforeState,
    initiatorId: input.initiatorId.trim(),
    initiatorKind: 'owner_session',
    objectId: input.objectId,
    reason: input.reason.trim(),
  });
}
