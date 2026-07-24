import { randomUUID } from 'node:crypto';
import { and, asc, eq, lt, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { mediaCacheCommands, mediaCacheObjects } from '../db/schema.js';
import type { MediaCacheEvictionService } from './eviction-repository.js';
import type {
  MediaCacheMaintenanceService,
  MediaCacheReconcileResult,
} from './maintenance-service.js';

const COMMAND_LEASE_MS = 5 * 60_000;
const COMMAND_RENEWAL_MS = 60_000;
const EVICTION_LEASE_MS = 2 * 60_000;

export type MediaCacheCommandOperation = 'evict' | 'migrate' | 'prune' | 'reconcile' | 'restore';
export type MediaCacheCommandState = 'failed' | 'pending' | 'running' | 'succeeded';
export type MediaCacheCommandInitiatorKind = 'local_operator' | 'owner_session';

export interface MediaCacheCommandReceipt {
  commandId: string;
  operation: MediaCacheCommandOperation;
  state: 'pending';
}

interface MediaCacheCommandInputBase {
  initiatorId: string;
  initiatorKind?: MediaCacheCommandInitiatorKind;
  reason: string;
}

export type MediaCacheCommandInput = MediaCacheCommandInputBase &
  (
    | {
        objectId: string;
        operation: 'evict';
        sourceBackendId?: never;
        targetBackendId?: never;
        targetBytes?: never;
      }
    | {
        objectId?: string;
        operation: 'migrate';
        sourceBackendId: string;
        targetBackendId: string;
        targetBytes?: never;
      }
    | {
        objectId?: never;
        operation: 'prune';
        sourceBackendId?: never;
        targetBackendId: string;
        targetBytes: bigint;
      }
    | {
        objectId?: never;
        operation: 'reconcile';
        sourceBackendId?: never;
        targetBackendId?: never;
        targetBytes?: never;
      }
    | {
        objectId: string;
        operation: 'restore';
        sourceBackendId?: never;
        targetBackendId: string;
        targetBytes?: never;
      }
  );

interface ClaimedMediaCacheCommandBase {
  id: string;
  initiatorId: string;
  initiatorKind: MediaCacheCommandInitiatorKind;
  reason: string;
  token: string;
}

export type ClaimedMediaCacheCommand = ClaimedMediaCacheCommandBase &
  (
    | {
        objectId: string;
        operation: 'evict';
        sourceBackendId: null;
        targetBackendId: null;
        targetBytes: null;
      }
    | {
        objectId: string | null;
        operation: 'migrate';
        sourceBackendId: string;
        targetBackendId: string;
        targetBytes: null;
      }
    | {
        objectId: null;
        operation: 'prune';
        sourceBackendId: null;
        targetBackendId: string;
        targetBytes: bigint;
      }
    | {
        objectId: null;
        operation: 'reconcile';
        sourceBackendId: null;
        targetBackendId: null;
        targetBytes: null;
      }
    | {
        objectId: string;
        operation: 'restore';
        sourceBackendId: null;
        targetBackendId: string;
        targetBytes: null;
      }
  );

interface CommandEviction {
  evict: MediaCacheEvictionService['evict'];
}

interface CommandMaintenance {
  reconcile: MediaCacheMaintenanceService['reconcile'];
}

type StorageCommandOperation = 'migrate' | 'prune' | 'restore';

export interface CommandStorageOperationInput<Operation extends StorageCommandOperation> {
  command: Extract<ClaimedMediaCacheCommand, { operation: Operation }>;
  renewLease(): Promise<void>;
  signal?: AbortSignal;
}

export interface CommandStorageMigrateResult {
  alreadyApplied?: boolean;
  hasMore?: boolean;
  migratedBlobCount: number;
  migratedBytes: string;
  sourceBackendId: string;
  targetBackendId: string;
}

export interface CommandStoragePruneResult {
  alreadyApplied?: boolean;
  hasMore?: boolean;
  prunedBlobCount: number;
  prunedBytes: string;
  readyBytes: string;
  targetBackendId: string;
}

export interface CommandStorageRestoreResult {
  alreadyApplied?: boolean;
  hasMore?: boolean;
  restoredBytes: string;
  restoredObjectCount: number;
  targetBackendId: string;
}

export interface CommandStorageOperations {
  migrate(input: CommandStorageOperationInput<'migrate'>): Promise<CommandStorageMigrateResult>;
  prune(input: CommandStorageOperationInput<'prune'>): Promise<CommandStoragePruneResult>;
  restore(input: CommandStorageOperationInput<'restore'>): Promise<CommandStorageRestoreResult>;
}

export interface MediaCacheCommandQueueControl {
  claim(input: { leaseOwner: string }): Promise<ClaimedMediaCacheCommand | null>;
  fail(command: ClaimedMediaCacheCommand, errorCode: string): Promise<void>;
  renew(command: ClaimedMediaCacheCommand): Promise<void>;
  succeed(command: ClaimedMediaCacheCommand, result: Record<string, unknown>): Promise<void>;
}

export class PostgresMediaCacheCommandQueue {
  constructor(private readonly database: Database) {}

  async enqueue(input: MediaCacheCommandInput): Promise<MediaCacheCommandReceipt> {
    const initiatorId = input.initiatorId.trim();
    const initiatorKind = normalizeInitiatorKind(input.initiatorKind);
    const reason = input.reason.trim();
    if (!initiatorId || initiatorId.length > 255 || !reason || reason.length > 500) {
      throw new TypeError('Invalid media cache command initiator or reason');
    }
    const payload = normalizeCommandPayload(input);
    const [command] = await this.database
      .insert(mediaCacheCommands)
      .values({
        initiatorId,
        initiatorKind,
        operation: input.operation,
        ...payload,
        reason,
      })
      .returning({ id: mediaCacheCommands.id });
    if (!command) {
      throw new Error('Media cache command was not enqueued');
    }
    return { commandId: command.id, operation: input.operation, state: 'pending' };
  }

  async claim(input: { leaseOwner: string }): Promise<ClaimedMediaCacheCommand | null> {
    const leaseOwner = input.leaseOwner.trim();
    if (!leaseOwner || leaseOwner.length > 255) {
      throw new TypeError('Invalid media cache command lease owner');
    }
    return this.database.transaction(async (transaction) => {
      const [clock] = await transaction.execute<{ now: Date | string }>(
        sql`select clock_timestamp() as now`,
      );
      const now = parseClock(clock?.now);
      await transaction
        .update(mediaCacheCommands)
        .set({
          completedAt: now,
          errorCode: 'retry_exhausted',
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          state: 'failed',
          updatedAt: now,
        })
        .where(
          and(
            eq(mediaCacheCommands.state, 'running'),
            lte(mediaCacheCommands.leaseExpiresAt, now),
            sql`${mediaCacheCommands.attemptCount} >= 100`,
          ),
        );
      const [candidate] = await transaction
        .select({
          id: mediaCacheCommands.id,
          initiatorId: mediaCacheCommands.initiatorId,
          initiatorKind: mediaCacheCommands.initiatorKind,
          objectId: mediaCacheCommands.objectId,
          operation: mediaCacheCommands.operation,
          reason: mediaCacheCommands.reason,
          sourceBackendId: mediaCacheCommands.sourceBackendId,
          targetBackendId: mediaCacheCommands.targetBackendId,
          targetBytes: mediaCacheCommands.targetBytes,
        })
        .from(mediaCacheCommands)
        .where(
          or(
            eq(mediaCacheCommands.state, 'pending'),
            and(
              eq(mediaCacheCommands.state, 'running'),
              lte(mediaCacheCommands.leaseExpiresAt, now),
              lt(mediaCacheCommands.attemptCount, 100),
            ),
          ),
        )
        .orderBy(asc(mediaCacheCommands.createdAt), asc(mediaCacheCommands.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!candidate) return null;

      const token = randomUUID();
      const [claimed] = await transaction
        .update(mediaCacheCommands)
        .set({
          attemptCount: sql`${mediaCacheCommands.attemptCount} + 1`,
          leaseExpiresAt: new Date(now.getTime() + COMMAND_LEASE_MS),
          leaseOwner,
          leaseToken: token,
          state: 'running',
          updatedAt: now,
        })
        .where(eq(mediaCacheCommands.id, candidate.id))
        .returning({ id: mediaCacheCommands.id });
      return claimed ? hydrateClaimedCommand(candidate, token) : null;
    });
  }

  async renew(command: ClaimedMediaCacheCommand): Promise<void> {
    const [clock] = await this.database.execute<{ now: Date | string }>(
      sql`select clock_timestamp() as now`,
    );
    const now = parseClock(clock?.now);
    const [renewed] = await this.database
      .update(mediaCacheCommands)
      .set({
        leaseExpiresAt: new Date(now.getTime() + COMMAND_LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(mediaCacheCommands.id, command.id),
          eq(mediaCacheCommands.state, 'running'),
          eq(mediaCacheCommands.leaseToken, command.token),
        ),
      )
      .returning({ id: mediaCacheCommands.id });
    if (!renewed) throw new Error('Media cache command lease is stale');
  }

  async succeed(command: ClaimedMediaCacheCommand, result: Record<string, unknown>): Promise<void> {
    const [completed] = await this.database
      .update(mediaCacheCommands)
      .set({
        completedAt: sql`clock_timestamp()`,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseToken: null,
        result,
        state: 'succeeded',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(mediaCacheCommands.id, command.id),
          eq(mediaCacheCommands.state, 'running'),
          eq(mediaCacheCommands.leaseToken, command.token),
        ),
      )
      .returning({ id: mediaCacheCommands.id });
    if (!completed) throw new Error('Media cache command lease is stale');
  }

  async fail(command: ClaimedMediaCacheCommand, errorCode: string): Promise<void> {
    const [failed] = await this.database
      .update(mediaCacheCommands)
      .set({
        completedAt: sql`clock_timestamp()`,
        errorCode,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseToken: null,
        state: 'failed',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(mediaCacheCommands.id, command.id),
          eq(mediaCacheCommands.state, 'running'),
          eq(mediaCacheCommands.leaseToken, command.token),
        ),
      )
      .returning({ id: mediaCacheCommands.id });
    if (!failed) throw new Error('Media cache command lease is stale');
  }
}

export class MediaCacheCommandProcessor {
  constructor(
    private readonly database: Database,
    private readonly queue: MediaCacheCommandQueueControl,
    private readonly eviction: CommandEviction,
    private readonly maintenance: CommandMaintenance,
    private readonly leaseOwner: string,
    private readonly storageOperations?: CommandStorageOperations,
  ) {}

  async runOnce(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const command = await this.queue.claim({ leaseOwner: this.leaseOwner });
    if (!command) return false;
    let renewalError: unknown;
    let renewal = Promise.resolve();
    const renewalTimer = setInterval(() => {
      renewal = renewal
        .then(() => this.queue.renew(command))
        .catch((error: unknown) => {
          renewalError ??= error;
        });
    }, COMMAND_RENEWAL_MS);
    renewalTimer.unref();
    try {
      const result = await this.dispatch(command, signal);
      clearInterval(renewalTimer);
      await renewal;
      if (renewalError) throw renewalError;
      await this.queue.succeed(command, result);
    } catch (error) {
      clearInterval(renewalTimer);
      await renewal;
      if (signal?.aborted) {
        throw error;
      }
      await this.queue.fail(command, classifyCommandError(error));
    }
    return true;
  }

  private async dispatch(
    command: ClaimedMediaCacheCommand,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    switch (command.operation) {
      case 'evict':
        return await this.evict(command, signal);
      case 'migrate':
      case 'prune':
      case 'restore':
        return await this.runStorageOperation(command, signal);
      case 'reconcile':
        return await this.reconcile(command, signal);
      default:
        return assertNever(command);
    }
  }

  private async evict(
    command: ClaimedMediaCacheCommand,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    if (!command.objectId) throw new Error('invalid_target');
    const [object] = await this.database
      .select({
        blobSha256: mediaCacheObjects.blobSha256,
        state: mediaCacheObjects.state,
      })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.id, command.objectId))
      .limit(1);
    if (!object) throw new Error('invalid_target');
    if (object.state === 'evicted') {
      return { alreadyApplied: true, evictedObjectCount: 0 };
    }
    if (!object.blobSha256 || !['deleting', 'ready'].includes(object.state)) {
      throw new Error('object_not_evictable');
    }
    const [clock] = await this.database.execute<{ now: Date | string }>(
      sql`select clock_timestamp() as now`,
    );
    const now = parseClock(clock?.now);
    const result = await this.eviction.evict({
      evictionExpiresAt: new Date(now.getTime() + EVICTION_LEASE_MS),
      evictionOwner: this.leaseOwner,
      evictionToken: randomUUID(),
      initiator: {
        initiatorId: command.initiatorId,
        kind: command.initiatorKind,
        reason: command.reason,
      },
      selection: { kind: 'specific_blob', sha256: object.blobSha256 },
    });
    if (!result) throw new Error('object_not_evictable');
    return {
      evictedObjectCount: result.evictedObjectIds.length,
      fileOutcome: result.fileOutcome,
      physicalBytesRemoved: result.physicalBytesRemoved.toString(),
      readyBytes: result.readyBytes.toString(),
    };
  }

  private async reconcile(
    command: ClaimedMediaCacheCommand,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const totals = {
      checked: 0,
      missing: 0,
      orphanFailed: 0,
      orphanFound: 0,
      orphanRecovered: 0,
      repairFailed: 0,
      repaired: 0,
    };
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let pages = 0;
    do {
      pages += 1;
      if (pages > 10_000) throw new Error('reconcile_page_limit');
      signal?.throwIfAborted();
      await this.queue.renew(command);
      const page: MediaCacheReconcileResult = await this.maintenance.reconcile({
        apply: true,
        ...(cursor ? { cursor } : {}),
        initiator: {
          id: command.initiatorId,
          kind: command.initiatorKind,
          reason: command.reason,
        },
      });
      totals.checked += page.checked;
      totals.missing += page.missing;
      totals.orphanFailed += page.orphans.failed;
      totals.orphanFound += page.orphans.found;
      totals.orphanRecovered += page.orphans.recovered;
      totals.repairFailed += page.repairFailed;
      totals.repaired += page.repaired;
      cursor = page.nextCursor ?? undefined;
      if (cursor && seenCursors.has(cursor)) throw new Error('reconcile_cursor_loop');
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return { ...totals, pages };
  }

  private async runStorageOperation(
    command: ClaimedMediaCacheCommand,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const operations = this.storageOperations;
    if (!operations) throw new Error('storage_operation_unavailable');
    await this.queue.renew(command);
    const renewLease = () => this.queue.renew(command);
    switch (command.operation) {
      case 'migrate':
        return sanitizeStorageOperationResult(
          'migrate',
          await operations.migrate({
            command,
            renewLease,
            ...(signal ? { signal } : {}),
          }),
        );
      case 'prune':
        return sanitizeStorageOperationResult(
          'prune',
          await operations.prune({
            command,
            renewLease,
            ...(signal ? { signal } : {}),
          }),
        );
      case 'restore':
        return sanitizeStorageOperationResult(
          'restore',
          await operations.restore({
            command,
            renewLease,
            ...(signal ? { signal } : {}),
          }),
        );
      default:
        throw new Error('storage_operation_unavailable');
    }
  }
}

function hydrateClaimedCommand(
  candidate: {
    id: string;
    initiatorId: string;
    initiatorKind: MediaCacheCommandInitiatorKind;
    objectId: string | null;
    operation: MediaCacheCommandOperation;
    reason: string;
    sourceBackendId: string | null;
    targetBackendId: string | null;
    targetBytes: bigint | null;
  },
  token: string,
): ClaimedMediaCacheCommand {
  const common = {
    id: candidate.id,
    initiatorId: candidate.initiatorId,
    initiatorKind: candidate.initiatorKind,
    reason: candidate.reason,
    token,
  };
  switch (candidate.operation) {
    case 'evict':
      if (
        !candidate.objectId ||
        candidate.sourceBackendId ||
        candidate.targetBackendId ||
        candidate.targetBytes !== null
      ) {
        return invalidClaimedPayload();
      }
      return {
        ...common,
        objectId: candidate.objectId,
        operation: 'evict',
        sourceBackendId: null,
        targetBackendId: null,
        targetBytes: null,
      };
    case 'migrate':
      if (
        !candidate.sourceBackendId ||
        !candidate.targetBackendId ||
        candidate.sourceBackendId === candidate.targetBackendId ||
        candidate.targetBytes !== null
      ) {
        return invalidClaimedPayload();
      }
      return {
        ...common,
        objectId: candidate.objectId,
        operation: 'migrate',
        sourceBackendId: candidate.sourceBackendId,
        targetBackendId: candidate.targetBackendId,
        targetBytes: null,
      };
    case 'prune':
      if (
        candidate.objectId ||
        candidate.sourceBackendId ||
        !candidate.targetBackendId ||
        candidate.targetBytes === null ||
        candidate.targetBytes < 0n
      ) {
        return invalidClaimedPayload();
      }
      return {
        ...common,
        objectId: null,
        operation: 'prune',
        sourceBackendId: null,
        targetBackendId: candidate.targetBackendId,
        targetBytes: candidate.targetBytes,
      };
    case 'reconcile':
      if (
        candidate.objectId ||
        candidate.sourceBackendId ||
        candidate.targetBackendId ||
        candidate.targetBytes !== null
      ) {
        return invalidClaimedPayload();
      }
      return {
        ...common,
        objectId: null,
        operation: 'reconcile',
        sourceBackendId: null,
        targetBackendId: null,
        targetBytes: null,
      };
    case 'restore':
      if (
        !candidate.objectId ||
        candidate.sourceBackendId ||
        !candidate.targetBackendId ||
        candidate.targetBytes !== null
      ) {
        return invalidClaimedPayload();
      }
      return {
        ...common,
        objectId: candidate.objectId,
        operation: 'restore',
        sourceBackendId: null,
        targetBackendId: candidate.targetBackendId,
        targetBytes: null,
      };
    default:
      return assertNever(candidate.operation);
  }
}

function invalidClaimedPayload(): never {
  throw new Error('PostgreSQL returned an invalid media cache command payload');
}

function normalizeInitiatorKind(value: unknown): MediaCacheCommandInitiatorKind {
  if (value === undefined) return 'owner_session';
  if (value === 'local_operator' || value === 'owner_session') return value;
  throw new TypeError('Invalid media cache command initiator kind');
}

function normalizeCommandPayload(input: MediaCacheCommandInput): {
  objectId?: string;
  sourceBackendId?: string;
  targetBackendId?: string;
  targetBytes?: bigint;
} {
  const raw = input as MediaCacheCommandInput & Record<string, unknown>;
  const objectId = normalizeOptionalId(raw.objectId, 255);
  const sourceBackendId = normalizeOptionalId(raw.sourceBackendId, 64);
  const targetBackendId = normalizeOptionalId(raw.targetBackendId, 64);
  const hasTargetBytes = raw.targetBytes !== undefined && raw.targetBytes !== null;
  const targetBytes =
    hasTargetBytes && typeof raw.targetBytes === 'bigint' ? raw.targetBytes : null;
  switch (input.operation) {
    case 'evict':
      if (!objectId || sourceBackendId || targetBackendId || hasTargetBytes) invalidTarget();
      return { objectId };
    case 'migrate':
      if (
        !sourceBackendId ||
        !targetBackendId ||
        sourceBackendId === targetBackendId ||
        hasTargetBytes
      ) {
        invalidTarget();
      }
      return {
        ...(objectId ? { objectId } : {}),
        sourceBackendId,
        targetBackendId,
      };
    case 'prune':
      if (
        objectId ||
        sourceBackendId ||
        !targetBackendId ||
        targetBytes === null ||
        targetBytes < 0n
      ) {
        invalidTarget();
      }
      return { targetBackendId, targetBytes };
    case 'reconcile':
      if (objectId || sourceBackendId || targetBackendId || hasTargetBytes) invalidTarget();
      return {};
    case 'restore':
      if (!objectId || sourceBackendId || !targetBackendId || hasTargetBytes) invalidTarget();
      return { objectId, targetBackendId };
    default:
      return assertNever(input as never);
  }
}

function normalizeOptionalId(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalidTarget();
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) invalidTarget();
  return normalized;
}

function invalidTarget(): never {
  throw new TypeError('Invalid media cache command target');
}

const STORAGE_BOOLEAN_KEYS = new Set(['alreadyApplied', 'hasMore']);
const STORAGE_COUNT_KEYS = new Set(['migratedBlobCount', 'prunedBlobCount', 'restoredObjectCount']);
const STORAGE_BYTE_KEYS = new Set(['migratedBytes', 'prunedBytes', 'readyBytes', 'restoredBytes']);
const STORAGE_BACKEND_KEYS = new Set(['sourceBackendId', 'targetBackendId']);

export function sanitizeStorageOperationResult(
  operation: StorageCommandOperation,
  result: object,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (STORAGE_BOOLEAN_KEYS.has(key) && typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (STORAGE_COUNT_KEYS.has(key) && Number.isSafeInteger(value) && Number(value) >= 0) {
      sanitized[key] = value;
    } else if (STORAGE_BYTE_KEYS.has(key) && isDecimalString(value)) {
      sanitized[key] = value;
    } else if (
      STORAGE_BACKEND_KEYS.has(key) &&
      typeof value === 'string' &&
      /^[a-z][a-z0-9_-]{0,63}$/u.test(value)
    ) {
      sanitized[key] = value;
    }
  }
  if (operation === 'migrate') {
    return pickKeys(sanitized, [
      'alreadyApplied',
      'hasMore',
      'migratedBlobCount',
      'migratedBytes',
      'sourceBackendId',
      'targetBackendId',
    ]);
  }
  if (operation === 'restore') {
    return pickKeys(sanitized, [
      'alreadyApplied',
      'hasMore',
      'restoredBytes',
      'restoredObjectCount',
      'targetBackendId',
    ]);
  }
  return pickKeys(sanitized, [
    'alreadyApplied',
    'hasMore',
    'prunedBlobCount',
    'prunedBytes',
    'readyBytes',
    'targetBackendId',
  ]);
}

function pickKeys(
  result: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) => (Object.hasOwn(result, key) ? [[key, result[key]]] : [])),
  );
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/u.test(value);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported media cache command operation: ${String(value)}`);
}

function parseClock(value: Date | string | undefined): Date {
  const now = value === undefined ? null : new Date(value);
  if (!now || !Number.isFinite(now.getTime())) {
    throw new Error('PostgreSQL returned an invalid media cache command clock');
  }
  return now;
}

function classifyCommandError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  if (error instanceof Error) {
    if (error.message === 'invalid_target') return 'invalid_target';
    if (error.message === 'object_not_evictable') return 'object_not_evictable';
    if (error.message === 'reconcile_cursor_loop') return 'reconcile_cursor_loop';
    if (error.message === 'reconcile_page_limit') return 'reconcile_page_limit';
    if (error.message === 'storage_operation_unavailable') {
      return 'storage_operation_unavailable';
    }
    if (error.name === 'MediaCacheEvictionError') return 'eviction_failed';
  }
  return 'operation_failed';
}
