import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { mediaCacheActions, mediaCacheObjectProtections, mediaCacheObjects } from '../db/schema.js';
import { MEDIA_CACHE_ADVISORY_LOCK } from './ledger-repository.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INITIATOR_ID_LENGTH = 255;
const MAX_REASON_LENGTH = 500;
const MAX_PROTECTION_YEARS = 10;

type MediaCacheTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type MediaCacheEvictedPolicy = 'recache_on_access' | 'stay_evicted';
export type MediaCachePolicyInitiatorKind = 'local_operator' | 'owner_session';

export interface MediaCachePolicyInitiator {
  id: string;
  kind: MediaCachePolicyInitiatorKind;
  reason: string;
}

export interface ProtectMediaCacheObjectInput {
  expiresAt?: Date;
  initiator: MediaCachePolicyInitiator;
  objectId: string;
}

export interface UnprotectMediaCacheObjectInput {
  initiator: MediaCachePolicyInitiator;
  objectId: string;
}

export interface SetMediaCacheEvictedPolicyInput {
  initiator: MediaCachePolicyInitiator;
  objectId: string;
  policy: MediaCacheEvictedPolicy;
}

export interface MediaCacheProtectionMutationResult {
  alreadyApplied: boolean;
  expiresAt: Date | null;
  objectId: string;
  protected: boolean;
  protectedAt: Date | null;
}

export interface MediaCacheEvictedPolicyMutationResult {
  alreadyApplied: boolean;
  objectId: string;
  policy: MediaCacheEvictedPolicy;
}

export interface ActiveBlobProtection {
  activeCount: number;
  blocked: boolean;
  hasIndefinite: boolean;
  nextExpiry: Date | null;
}

export class MediaCacheObjectPolicyInputError extends Error {
  readonly code = 'input';

  constructor(message: string) {
    super(message);
    this.name = 'MediaCacheObjectPolicyInputError';
  }
}

export class MediaCacheObjectPolicyNotFoundError extends Error {
  readonly code = 'not_found';

  constructor() {
    super('Media cache object was not found');
    this.name = 'MediaCacheObjectPolicyNotFoundError';
  }
}

export class MediaCacheObjectPolicyConflictError extends Error {
  readonly code = 'conflict';

  constructor(message = 'Media cache object policy changed concurrently') {
    super(message);
    this.name = 'MediaCacheObjectPolicyConflictError';
  }
}

export class PostgresMediaCacheObjectPolicyService {
  constructor(private readonly database: Database) {}

  async protect(input: ProtectMediaCacheObjectInput): Promise<MediaCacheProtectionMutationResult> {
    const objectId = normalizeObjectId(input?.objectId);
    const initiator = normalizeInitiator(input?.initiator);
    const requestedExpiry = normalizeRequestedExpiry(input?.expiresAt);

    return this.database.transaction(async (transaction) => {
      await lockMediaCache(transaction);
      const now = await readDatabaseClock(transaction);
      const expiresAt = validateProtectionExpiry(requestedExpiry, now);
      const object = await lockObject(transaction, objectId);
      const [before] = await transaction
        .select({
          expiresAt: mediaCacheObjectProtections.expiresAt,
          ownerKind: mediaCacheObjectProtections.ownerKind,
          protectedAt: mediaCacheObjectProtections.protectedAt,
        })
        .from(mediaCacheObjectProtections)
        .where(eq(mediaCacheObjectProtections.objectId, objectId));

      await transaction
        .insert(mediaCacheObjectProtections)
        .values({
          expiresAt,
          objectId,
          ownerId: initiator.id,
          ownerKind: initiator.kind,
          protectedAt: now,
          reason: initiator.reason,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          set: {
            expiresAt,
            ownerId: initiator.id,
            ownerKind: initiator.kind,
            protectedAt: now,
            reason: initiator.reason,
            updatedAt: now,
          },
          target: mediaCacheObjectProtections.objectId,
        });

      await insertPolicyAction(transaction, {
        actionKind: 'protect',
        afterState: protectionAuditState({
          expiresAt,
          now,
          ownerKind: initiator.kind,
          protectedAt: now,
        }),
        beforeState: before
          ? protectionAuditState({ ...before, now })
          : { configured: false, protected: false },
        blobSha256: object.blobSha256,
        createdAt: now,
        initiator,
        objectId,
      });

      return {
        alreadyApplied: false,
        expiresAt,
        objectId,
        protected: true,
        protectedAt: now,
      };
    });
  }

  async unprotect(
    input: UnprotectMediaCacheObjectInput,
  ): Promise<MediaCacheProtectionMutationResult> {
    const objectId = normalizeObjectId(input?.objectId);
    const initiator = normalizeInitiator(input?.initiator);

    return this.database.transaction(async (transaction) => {
      await lockMediaCache(transaction);
      const now = await readDatabaseClock(transaction);
      const object = await lockObject(transaction, objectId);
      const [before] = await transaction
        .select({
          expiresAt: mediaCacheObjectProtections.expiresAt,
          ownerKind: mediaCacheObjectProtections.ownerKind,
          protectedAt: mediaCacheObjectProtections.protectedAt,
        })
        .from(mediaCacheObjectProtections)
        .where(eq(mediaCacheObjectProtections.objectId, objectId));
      if (!before || !isProtectionActive(before.expiresAt, now)) {
        return {
          alreadyApplied: true,
          expiresAt: null,
          objectId,
          protected: false,
          protectedAt: null,
        };
      }

      const deleted = await transaction
        .delete(mediaCacheObjectProtections)
        .where(eq(mediaCacheObjectProtections.objectId, objectId))
        .returning({ objectId: mediaCacheObjectProtections.objectId });
      if (deleted.length !== 1) {
        throw new MediaCacheObjectPolicyConflictError();
      }
      await insertPolicyAction(transaction, {
        actionKind: 'unprotect',
        afterState: { configured: false, protected: false },
        beforeState: protectionAuditState({ ...before, now }),
        blobSha256: object.blobSha256,
        createdAt: now,
        initiator,
        objectId,
      });

      return {
        alreadyApplied: false,
        expiresAt: null,
        objectId,
        protected: false,
        protectedAt: null,
      };
    });
  }

  async setEvictedPolicy(
    input: SetMediaCacheEvictedPolicyInput,
  ): Promise<MediaCacheEvictedPolicyMutationResult> {
    const objectId = normalizeObjectId(input?.objectId);
    const initiator = normalizeInitiator(input?.initiator);
    const policy = normalizeEvictedPolicy(input?.policy);

    return this.database.transaction(async (transaction) => {
      await lockMediaCache(transaction);
      const now = await readDatabaseClock(transaction);
      const object = await lockObject(transaction, objectId);
      if (object.evictedPolicy === policy) {
        return { alreadyApplied: true, objectId, policy };
      }

      const updated = await transaction
        .update(mediaCacheObjects)
        .set({ evictedPolicy: policy, updatedAt: now })
        .where(eq(mediaCacheObjects.id, objectId))
        .returning({ id: mediaCacheObjects.id });
      if (updated.length !== 1) {
        throw new MediaCacheObjectPolicyConflictError();
      }
      await insertPolicyAction(transaction, {
        actionKind: 'set_evicted_policy',
        afterState: { evictedPolicy: policy },
        beforeState: { evictedPolicy: object.evictedPolicy },
        blobSha256: object.blobSha256,
        createdAt: now,
        initiator,
        objectId,
      });
      return { alreadyApplied: false, objectId, policy };
    });
  }

  async getActiveBlobProtection(
    blobSha256: string,
    transaction?: MediaCacheTransaction,
  ): Promise<ActiveBlobProtection> {
    const normalizedSha256 = normalizeSha256(blobSha256);
    if (transaction) {
      return readActiveBlobProtection(transaction, normalizedSha256);
    }
    return readActiveBlobProtection(this.database, normalizedSha256);
  }
}

export function normalizeObjectPolicyInitiator(
  initiator: MediaCachePolicyInitiator,
): MediaCachePolicyInitiator {
  return normalizeInitiator(initiator);
}

export function validateMediaCacheProtectionExpiry(
  expiresAt: Date | undefined,
  now: Date,
): Date | null {
  return validateProtectionExpiry(normalizeRequestedExpiry(expiresAt), normalizeDate(now, 'clock'));
}

export function validateMediaCacheEvictedPolicy(policy: unknown): MediaCacheEvictedPolicy {
  return normalizeEvictedPolicy(policy);
}

async function lockMediaCache(transaction: MediaCacheTransaction): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(${MEDIA_CACHE_ADVISORY_LOCK})`);
}

async function lockObject(transaction: MediaCacheTransaction, objectId: string) {
  const [object] = await transaction
    .select({
      blobSha256: mediaCacheObjects.blobSha256,
      evictedPolicy: mediaCacheObjects.evictedPolicy,
      id: mediaCacheObjects.id,
    })
    .from(mediaCacheObjects)
    .where(eq(mediaCacheObjects.id, objectId))
    .for('update');
  if (!object) {
    throw new MediaCacheObjectPolicyNotFoundError();
  }
  return object;
}

async function readActiveBlobProtection(
  database: Database | MediaCacheTransaction,
  blobSha256: string,
): Promise<ActiveBlobProtection> {
  const now = await readDatabaseClock(database);
  const [summary] = await database
    .select({
      activeCount: sql<number>`count(*)::integer`,
      hasIndefinite: sql<boolean>`coalesce(bool_or(${mediaCacheObjectProtections.expiresAt} is null), false)`,
      nextExpiry: sql<Date | string | null>`min(${mediaCacheObjectProtections.expiresAt})`,
    })
    .from(mediaCacheObjectProtections)
    .innerJoin(mediaCacheObjects, eq(mediaCacheObjects.id, mediaCacheObjectProtections.objectId))
    .where(
      and(
        eq(mediaCacheObjects.blobSha256, blobSha256),
        or(
          isNull(mediaCacheObjectProtections.expiresAt),
          gt(mediaCacheObjectProtections.expiresAt, now),
        ),
      ),
    );
  const activeCount = summary?.activeCount ?? 0;
  const nextExpiry = summary?.nextExpiry ? new Date(summary.nextExpiry) : null;
  if (nextExpiry && !Number.isFinite(nextExpiry.getTime())) {
    throw new MediaCacheObjectPolicyConflictError('PostgreSQL returned an invalid expiry');
  }
  return {
    activeCount,
    blocked: activeCount > 0,
    hasIndefinite: summary?.hasIndefinite ?? false,
    nextExpiry,
  };
}

async function readDatabaseClock(database: Database | MediaCacheTransaction): Promise<Date> {
  const [clock] = await database.execute<{ now: Date | string }>(
    sql`select clock_timestamp() as now`,
  );
  const now = clock ? new Date(clock.now) : null;
  if (!now || !Number.isFinite(now.getTime())) {
    throw new MediaCacheObjectPolicyConflictError('PostgreSQL returned an invalid clock');
  }
  return now;
}

async function insertPolicyAction(
  transaction: MediaCacheTransaction,
  input: {
    actionKind: 'protect' | 'set_evicted_policy' | 'unprotect';
    afterState: Record<string, unknown>;
    beforeState: Record<string, unknown>;
    blobSha256: string | null;
    createdAt: Date;
    initiator: MediaCachePolicyInitiator;
    objectId: string;
  },
): Promise<void> {
  await transaction.insert(mediaCacheActions).values({
    actionKind: input.actionKind,
    afterState: input.afterState,
    beforeState: input.beforeState,
    blobSha256: input.blobSha256,
    createdAt: input.createdAt,
    initiatorId: input.initiator.id,
    initiatorKind: input.initiator.kind,
    objectId: input.objectId,
    reason: input.initiator.reason,
  });
}

function protectionAuditState(input: {
  expiresAt: Date | null;
  now: Date;
  ownerKind: MediaCachePolicyInitiatorKind;
  protectedAt: Date;
}): Record<string, unknown> {
  return {
    configured: true,
    expiresAt: input.expiresAt?.toISOString() ?? null,
    ownerKind: input.ownerKind,
    protected: isProtectionActive(input.expiresAt, input.now),
    protectedAt: input.protectedAt.toISOString(),
  };
}

function isProtectionActive(expiresAt: Date | null, now: Date): boolean {
  return expiresAt === null || expiresAt.getTime() > now.getTime();
}

function normalizeObjectId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new MediaCacheObjectPolicyInputError('Media cache object ID must be a UUID');
  }
  return value.toLowerCase();
}

function normalizeSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new MediaCacheObjectPolicyInputError('Media cache blob SHA-256 must be lowercase hex');
  }
  return value;
}

function normalizeInitiator(value: unknown): MediaCachePolicyInitiator {
  if (!value || typeof value !== 'object') {
    throw new MediaCacheObjectPolicyInputError('Media cache policy initiator is required');
  }
  const initiator = value as Partial<MediaCachePolicyInitiator>;
  if (initiator.kind !== 'local_operator' && initiator.kind !== 'owner_session') {
    throw new MediaCacheObjectPolicyInputError('Media cache policy initiator kind is invalid');
  }
  const id = normalizeBoundedText(initiator.id, 'initiator ID', MAX_INITIATOR_ID_LENGTH);
  const reason = normalizeBoundedText(initiator.reason, 'reason', MAX_REASON_LENGTH);
  return { id, kind: initiator.kind, reason };
}

function normalizeBoundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new MediaCacheObjectPolicyInputError(`Media cache policy ${label} must be text`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new MediaCacheObjectPolicyInputError(
      `Media cache policy ${label} must contain 1 to ${maxLength} characters`,
    );
  }
  return normalized;
}

function normalizeRequestedExpiry(value: unknown): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  return normalizeDate(value, 'protection expiry');
}

function validateProtectionExpiry(expiresAt: Date | undefined, now: Date): Date | null {
  if (!expiresAt) {
    return null;
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new MediaCacheObjectPolicyInputError(
      'Protection expiry must be after the database clock',
    );
  }
  const latest = new Date(now);
  latest.setUTCFullYear(latest.getUTCFullYear() + MAX_PROTECTION_YEARS);
  if (expiresAt.getTime() > latest.getTime()) {
    throw new MediaCacheObjectPolicyInputError(
      `Protection expiry must be within ${MAX_PROTECTION_YEARS} years`,
    );
  }
  return new Date(expiresAt);
}

function normalizeEvictedPolicy(value: unknown): MediaCacheEvictedPolicy {
  if (value !== 'recache_on_access' && value !== 'stay_evicted') {
    throw new MediaCacheObjectPolicyInputError('Media cache eviction policy is invalid');
  }
  return value;
}

function normalizeDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new MediaCacheObjectPolicyInputError(`Media cache ${label} must be a valid Date`);
  }
  return new Date(value);
}
