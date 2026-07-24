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

export type MediaCacheCommandOperation = 'evict' | 'reconcile';
export type MediaCacheCommandState = 'failed' | 'pending' | 'running' | 'succeeded';

export interface MediaCacheCommandReceipt {
  commandId: string;
  operation: MediaCacheCommandOperation;
  state: 'pending';
}

interface ClaimedMediaCacheCommand {
  id: string;
  initiatorId: string;
  objectId: string | null;
  operation: MediaCacheCommandOperation;
  reason: string;
  token: string;
}

interface CommandEviction {
  evict: MediaCacheEvictionService['evict'];
}

interface CommandMaintenance {
  reconcile: MediaCacheMaintenanceService['reconcile'];
}

export class PostgresMediaCacheCommandQueue {
  constructor(private readonly database: Database) {}

  async enqueue(input: {
    initiatorId: string;
    objectId?: string;
    operation: MediaCacheCommandOperation;
    reason: string;
  }): Promise<MediaCacheCommandReceipt> {
    const initiatorId = input.initiatorId.trim();
    const reason = input.reason.trim();
    if (!initiatorId || initiatorId.length > 255 || !reason || reason.length > 500) {
      throw new TypeError('Invalid media cache command initiator or reason');
    }
    if (
      (input.operation === 'evict' && !input.objectId) ||
      (input.operation === 'reconcile' && input.objectId)
    ) {
      throw new TypeError('Invalid media cache command target');
    }
    const [command] = await this.database
      .insert(mediaCacheCommands)
      .values({
        initiatorId,
        objectId: input.objectId,
        operation: input.operation,
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
          objectId: mediaCacheCommands.objectId,
          operation: mediaCacheCommands.operation,
          reason: mediaCacheCommands.reason,
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
      return claimed ? { ...candidate, token } : null;
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
    private readonly queue: PostgresMediaCacheCommandQueue,
    private readonly eviction: CommandEviction,
    private readonly maintenance: CommandMaintenance,
    private readonly leaseOwner: string,
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
      const result =
        command.operation === 'evict'
          ? await this.evict(command, signal)
          : await this.reconcile(command, signal);
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
        kind: 'owner_session',
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
          kind: 'owner_session',
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
    if (error.name === 'MediaCacheEvictionError') return 'eviction_failed';
  }
  return 'operation_failed';
}
