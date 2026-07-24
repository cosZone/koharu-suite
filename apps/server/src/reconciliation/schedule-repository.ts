import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { reconciliationRuns, reconciliationSchedule } from '../db/schema.js';

const SCHEDULE_KEY = 'telegram';
const DEFAULT_INTERVAL_SECONDS = 3_600;
const SCHEDULE_SCOPE_CHANNEL_LIMIT = 100;

export type ReconciliationScheduleStatus = 'completed' | 'failed' | 'interrupted' | 'partial';

export interface ReconciliationScheduleState {
  claimedRunId: string | null;
  enabled: boolean;
  intervalSeconds: number;
  lastRunId: string | null;
  lastStatus: ReconciliationScheduleStatus | null;
  leaseExpiresAt: string | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  nextRunAt: string;
}

export interface ReconciliationScheduleLease extends ReconciliationScheduleState {
  claimedRunId: string;
  leaseExpiresAt: string;
  leaseOwner: string;
  leaseToken: string;
}

interface FinishInput {
  leaseToken: string;
  report?: Record<string, unknown>;
  runId: string;
}

type ScheduleTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class PostgresReconciliationScheduleRepository {
  constructor(private readonly database: Database) {}

  async initialize(
    input: { enabled?: boolean; intervalSeconds?: number; nextRunAt?: Date; now?: Date } = {},
  ): Promise<ReconciliationScheduleState> {
    const now = input.now ?? new Date();
    const intervalSeconds = input.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
    assertPositiveSafeInteger('intervalSeconds', intervalSeconds);

    await this.database
      .insert(reconciliationSchedule)
      .values({
        createdAt: now,
        enabled: input.enabled ?? true,
        intervalSeconds,
        nextRunAt: input.nextRunAt ?? now,
        singletonKey: SCHEDULE_KEY,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: reconciliationSchedule.singletonKey });

    const state = await this.get();
    if (!state) {
      throw new Error('Reconciliation schedule initialization failed');
    }
    return state;
  }

  async get(): Promise<ReconciliationScheduleState | null> {
    const [row] = await this.database
      .select()
      .from(reconciliationSchedule)
      .where(eq(reconciliationSchedule.singletonKey, SCHEDULE_KEY))
      .limit(1);
    return row ? publicState(row) : null;
  }

  async claimDue(
    instanceId: string,
    leaseDurationMs: number,
    scope: readonly string[] = [],
  ): Promise<ReconciliationScheduleLease | null> {
    assertNonEmpty('instanceId', instanceId);
    assertPositiveSafeInteger('leaseDurationMs', leaseDurationMs);
    const leaseToken = randomUUID();

    return this.database.transaction(async (transaction) => {
      const [schedule] = await transaction
        .select({
          claimedRunId: reconciliationSchedule.claimedRunId,
          due: sql<boolean>`${reconciliationSchedule.enabled}
            and ${reconciliationSchedule.nextRunAt} <= clock_timestamp()
            and (
              ${reconciliationSchedule.leaseExpiresAt} is null
              or ${reconciliationSchedule.leaseExpiresAt} <= clock_timestamp()
            )`,
          leaseOwner: reconciliationSchedule.leaseOwner,
          leaseToken: reconciliationSchedule.leaseToken,
        })
        .from(reconciliationSchedule)
        .where(eq(reconciliationSchedule.singletonKey, SCHEDULE_KEY))
        .limit(1)
        .for('update');
      if (!schedule?.due) {
        return null;
      }
      const normalizedScope = normalizeScheduleScope(scope);

      if (schedule.claimedRunId) {
        const [interrupted] = await transaction
          .update(reconciliationRuns)
          .set({
            completedAt: sql`clock_timestamp()`,
            report: { reason: 'lease_expired' },
            status: 'interrupted',
          })
          .where(
            and(
              eq(reconciliationRuns.id, schedule.claimedRunId),
              eq(reconciliationRuns.initiatorKind, 'worker'),
              eq(reconciliationRuns.initiatorId, `${schedule.leaseOwner}:${schedule.leaseToken}`),
              eq(reconciliationRuns.mode, 'scheduled_scan'),
              eq(reconciliationRuns.status, 'running'),
            ),
          )
          .returning({ id: reconciliationRuns.id });
        if (!interrupted) {
          throw new Error('Expired reconciliation lease is not bound to a running worker run');
        }
      }

      const [run] = await transaction
        .insert(reconciliationRuns)
        .values({
          initiatorId: `${instanceId}:${leaseToken}`,
          initiatorKind: 'worker',
          mode: 'scheduled_scan',
          report: {},
          scope: normalizedScope,
          startedAt: sql`clock_timestamp()`,
          status: 'running',
        })
        .returning({ id: reconciliationRuns.id });
      if (!run) {
        throw new Error('Failed to create the claimed reconciliation run');
      }

      const [claimed] = await transaction
        .update(reconciliationSchedule)
        .set({
          claimedRunId: run.id,
          ...(schedule.claimedRunId
            ? { lastRunId: schedule.claimedRunId, lastStatus: 'interrupted' as const }
            : {}),
          leaseExpiresAt: leaseExpiry(leaseDurationMs),
          leaseOwner: instanceId,
          leaseToken,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(reconciliationSchedule.singletonKey, SCHEDULE_KEY))
        .returning();
      if (
        !claimed?.claimedRunId ||
        !claimed.leaseOwner ||
        !claimed.leaseExpiresAt ||
        !claimed.leaseToken
      ) {
        throw new Error('Failed to claim the reconciliation schedule');
      }
      return claimedLease(claimed);
    });
  }

  async complete(
    instanceId: string,
    input: FinishInput & { status: 'completed' | 'partial' },
  ): Promise<ReconciliationScheduleState> {
    return this.finishAndRelease(instanceId, input);
  }

  async release(
    instanceId: string,
    input: FinishInput & { status: 'failed' | 'interrupted' },
  ): Promise<ReconciliationScheduleState> {
    return this.finishAndRelease(instanceId, input);
  }

  async renew(
    instanceId: string,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<ReconciliationScheduleLease> {
    assertNonEmpty('instanceId', instanceId);
    assertNonEmpty('leaseToken', leaseToken);
    assertPositiveSafeInteger('leaseDurationMs', leaseDurationMs);
    const [renewed] = await this.database
      .update(reconciliationSchedule)
      .set({
        leaseExpiresAt: leaseExpiry(leaseDurationMs),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(reconciliationSchedule.singletonKey, SCHEDULE_KEY),
          eq(reconciliationSchedule.leaseOwner, instanceId),
          eq(reconciliationSchedule.leaseToken, leaseToken),
          sql`${reconciliationSchedule.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning();

    if (
      !renewed?.claimedRunId ||
      !renewed.leaseOwner ||
      !renewed.leaseExpiresAt ||
      !renewed.leaseToken
    ) {
      throw new Error('Reconciliation schedule lease ownership was lost');
    }
    return claimedLease(renewed);
  }

  private async finishAndRelease(
    instanceId: string,
    input: FinishInput & { status: ReconciliationScheduleStatus },
  ): Promise<ReconciliationScheduleState> {
    assertNonEmpty('instanceId', instanceId);
    assertNonEmpty('leaseToken', input.leaseToken);
    assertNonEmpty('runId', input.runId);

    return this.database.transaction(async (transaction) => {
      const schedule = await this.lockOwnedSchedule(
        transaction,
        instanceId,
        input.leaseToken,
        input.runId,
      );
      const [run] = await transaction
        .select({
          completedAt: reconciliationRuns.completedAt,
          initiatorId: reconciliationRuns.initiatorId,
          initiatorKind: reconciliationRuns.initiatorKind,
          mode: reconciliationRuns.mode,
          status: reconciliationRuns.status,
        })
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.id, input.runId))
        .limit(1)
        .for('update');
      if (
        !run ||
        run.completedAt !== null ||
        run.initiatorKind !== 'worker' ||
        run.initiatorId !== `${instanceId}:${input.leaseToken}` ||
        run.mode !== 'scheduled_scan' ||
        run.status !== 'running'
      ) {
        throw new Error('Reconciliation run is not the active token-bound scheduled worker run');
      }

      await transaction
        .update(reconciliationRuns)
        .set({
          completedAt: sql`clock_timestamp()`,
          report: input.report ?? {},
          status: input.status,
        })
        .where(eq(reconciliationRuns.id, input.runId));

      const [updated] = await transaction
        .update(reconciliationSchedule)
        .set({
          claimedRunId: null,
          lastRunId: input.runId,
          lastStatus: input.status,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseToken: null,
          nextRunAt: sql`clock_timestamp()
            + (${schedule.intervalSeconds} * interval '1 second')`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(reconciliationSchedule.singletonKey, SCHEDULE_KEY))
        .returning();
      if (!updated) {
        throw new Error('Failed to complete the reconciliation schedule');
      }
      return publicState(updated);
    });
  }

  private async lockOwnedSchedule(
    transaction: ScheduleTransaction,
    instanceId: string,
    leaseToken: string,
    runId: string,
  ) {
    const [schedule] = await transaction
      .select()
      .from(reconciliationSchedule)
      .where(
        and(
          eq(reconciliationSchedule.singletonKey, SCHEDULE_KEY),
          eq(reconciliationSchedule.leaseOwner, instanceId),
          eq(reconciliationSchedule.leaseToken, leaseToken),
          eq(reconciliationSchedule.claimedRunId, runId),
          sql`${reconciliationSchedule.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .limit(1)
      .for('update');
    if (!schedule) {
      throw new Error('Reconciliation schedule lease ownership was lost');
    }
    return schedule;
  }
}

function claimedLease(
  row: typeof reconciliationSchedule.$inferSelect,
): ReconciliationScheduleLease {
  if (!row.claimedRunId || !row.leaseExpiresAt || !row.leaseOwner || !row.leaseToken) {
    throw new Error('Reconciliation schedule lease is incomplete');
  }
  return {
    ...publicState(row),
    claimedRunId: row.claimedRunId,
    leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    leaseOwner: row.leaseOwner,
    leaseToken: row.leaseToken,
  };
}

function publicState(row: typeof reconciliationSchedule.$inferSelect): ReconciliationScheduleState {
  return {
    claimedRunId: row.claimedRunId,
    enabled: row.enabled,
    intervalSeconds: row.intervalSeconds,
    lastRunId: row.lastRunId,
    lastStatus: row.lastStatus,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    leaseOwner: row.leaseOwner,
    leaseToken: row.leaseToken,
    nextRunAt: row.nextRunAt.toISOString(),
  };
}

function leaseExpiry(leaseDurationMs: number) {
  return sql`clock_timestamp() + (${leaseDurationMs} * interval '1 millisecond')`;
}

function assertNonEmpty(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function assertPositiveSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function normalizeScheduleScope(values: readonly string[]): string[] {
  const unique = new Map<bigint, string>();
  for (const value of values) {
    if (value.length > 20 || !/^-[1-9]\d*$/u.test(value)) {
      throw new TypeError('Scheduled reconciliation scope must contain canonical channel IDs');
    }
    const telegramChannelId = BigInt(value);
    if (telegramChannelId < -9_223_372_036_854_775_808n) {
      throw new RangeError('Scheduled reconciliation channel ID is outside the bigint range');
    }
    unique.set(telegramChannelId, value);
    if (unique.size > SCHEDULE_SCOPE_CHANNEL_LIMIT) {
      throw new RangeError(
        `Scheduled reconciliation scope may include at most ${SCHEDULE_SCOPE_CHANNEL_LIMIT} channels`,
      );
    }
  }
  if (unique.size === 0) {
    throw new TypeError('Scheduled reconciliation scope must include at least one channel');
  }
  return [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value);
}
