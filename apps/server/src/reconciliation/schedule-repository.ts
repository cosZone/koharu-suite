import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  reconciliationRuns,
  reconciliationSchedule,
  telegramChannelAllowlist,
} from '../db/schema.js';
import {
  addReconciliationReportIssue,
  createReconciliationReport,
  finishReconciliationReport,
  RECONCILIATION_REPORT_FINDING_LIMIT,
  RECONCILIATION_REPORT_ISSUE_LIMIT,
  RECONCILIATION_REPORT_SCHEMA_VERSION,
  RECONCILIATION_REPORT_TEXT_LIMIT,
  type ReconciliationReport,
  sanitizeReconciliationReportText,
} from './report.js';

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
  report?: ReconciliationReport;
  runId: string;
}

type ScheduleTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class PostgresReconciliationScheduleRepository {
  constructor(private readonly database: Database) {}

  async listConfiguredChannelScope(): Promise<string[]> {
    const rows = await this.database
      .select({ telegramChatId: telegramChannelAllowlist.telegramChatId })
      .from(telegramChannelAllowlist)
      .orderBy(asc(telegramChannelAllowlist.telegramChatId))
      .limit(SCHEDULE_SCOPE_CHANNEL_LIMIT + 1);
    if (rows.length > SCHEDULE_SCOPE_CHANNEL_LIMIT) {
      throw new RangeError(
        `Scheduled reconciliation supports at most ${SCHEDULE_SCOPE_CHANNEL_LIMIT} configured channels`,
      );
    }
    return rows.map(({ telegramChatId }) => telegramChatId.toString());
  }

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
        const [expiredRun] = await transaction
          .select()
          .from(reconciliationRuns)
          .where(eq(reconciliationRuns.id, schedule.claimedRunId))
          .limit(1)
          .for('update');
        if (
          !expiredRun ||
          expiredRun.completedAt !== null ||
          expiredRun.initiatorKind !== 'worker' ||
          expiredRun.initiatorId !== `${schedule.leaseOwner}:${schedule.leaseToken}` ||
          expiredRun.mode !== 'scheduled_scan' ||
          expiredRun.status !== 'running'
        ) {
          throw new Error('Expired reconciliation lease is not bound to a running worker run');
        }
        const completedAt = new Date();
        const [interrupted] = await transaction
          .update(reconciliationRuns)
          .set({
            completedAt,
            report: reportJson(
              interruptedScheduleReport(
                expiredRun.scope,
                expiredRun.startedAt,
                completedAt,
                'scheduled_lease_expired',
                'The scheduled reconciliation lease expired before completion',
              ),
            ),
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

      const startedAt = new Date();
      const initialReport = createReconciliationReport({
        channelIds: normalizedScope,
        mode: 'scheduled-scan',
        startedAt,
      });
      const [run] = await transaction
        .insert(reconciliationRuns)
        .values({
          initiatorId: `${instanceId}:${leaseToken}`,
          initiatorKind: 'worker',
          mode: 'scheduled_scan',
          report: reportJson(initialReport),
          scope: normalizedScope,
          startedAt,
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
          scope: reconciliationRuns.scope,
          startedAt: reconciliationRuns.startedAt,
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
      const completedAt = new Date();
      const report =
        input.report ?? terminalScheduleReport(run.scope, run.startedAt, completedAt, input.status);
      assertTerminalScheduleReport(report, run.scope, input.status);

      await transaction
        .update(reconciliationRuns)
        .set({
          completedAt,
          report: reportJson(report),
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

function terminalScheduleReport(
  scope: readonly string[],
  startedAt: Date,
  completedAt: Date,
  status: ReconciliationScheduleStatus,
): ReconciliationReport {
  const report = createReconciliationReport({
    channelIds: scope,
    mode: 'scheduled-scan',
    startedAt,
  });
  if (status === 'partial' || status === 'failed') {
    addReconciliationReportIssue(report, {
      code: status === 'partial' ? 'scheduled_scan_partial' : 'scheduled_scan_failed',
      sanitizedReason:
        status === 'partial'
          ? 'Scheduled reconciliation completed with incomplete evidence'
          : 'Scheduled reconciliation failed before producing a report',
    });
  }
  return finishReconciliationReport(report, {
    completedAt,
    fatal: status === 'failed',
    interrupted: status === 'interrupted',
  });
}

function interruptedScheduleReport(
  scope: readonly string[],
  startedAt: Date,
  completedAt: Date,
  code: string,
  reason: string,
): ReconciliationReport {
  const report = createReconciliationReport({
    channelIds: scope,
    mode: 'scheduled-scan',
    startedAt,
  });
  addReconciliationReportIssue(report, { code, sanitizedReason: reason });
  return finishReconciliationReport(report, { completedAt, interrupted: true });
}

function assertTerminalScheduleReport(
  report: ReconciliationReport,
  runScope: readonly string[],
  status: ReconciliationScheduleStatus,
): void {
  const expectedStatus = {
    completed: 'clean',
    failed: 'fatal',
    interrupted: 'interrupted',
    partial: 'partial',
  } as const satisfies Record<ReconciliationScheduleStatus, ReconciliationReport['status']>;
  if (
    report.schemaVersion !== RECONCILIATION_REPORT_SCHEMA_VERSION ||
    report.mode !== 'scheduled-scan' ||
    report.completedAt === null ||
    report.status !== expectedStatus[status] ||
    report.counts.repaired !== 0
  ) {
    throw new TypeError('Scheduled reconciliation report does not match its terminal run state');
  }
  if (
    report.findings.length > RECONCILIATION_REPORT_FINDING_LIMIT ||
    report.issues.length > RECONCILIATION_REPORT_ISSUE_LIMIT
  ) {
    throw new RangeError('Scheduled reconciliation report exceeds its bounded sample limits');
  }
  const countValues = Object.values(report.counts);
  if (countValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError('Scheduled reconciliation report counts must be non-negative integers');
  }
  if (
    report.findings.some(
      (finding) =>
        finding.sanitizedReason.length > RECONCILIATION_REPORT_TEXT_LIMIT ||
        sanitizeReconciliationReportText(finding.sanitizedReason) !== finding.sanitizedReason,
    ) ||
    report.issues.some(
      (issue) =>
        issue.sanitizedReason.length > RECONCILIATION_REPORT_TEXT_LIMIT ||
        sanitizeReconciliationReportText(issue.sanitizedReason) !== issue.sanitizedReason,
    )
  ) {
    throw new TypeError('Scheduled reconciliation report contains unsanitized text');
  }
  const startedAt = Date.parse(report.startedAt);
  const completedAt = Date.parse(report.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    throw new TypeError('Scheduled reconciliation report has an invalid time range');
  }
  const expectedScope = [...new Set(runScope)].sort();
  const actualScope = [...report.scope.channelIds].sort();
  if (
    report.scope.channelIdsTruncated ||
    actualScope.length !== expectedScope.length ||
    actualScope.some((channelId, index) => channelId !== expectedScope[index])
  ) {
    throw new TypeError('Scheduled reconciliation report scope does not match its claimed run');
  }
}

function reportJson(report: ReconciliationReport): Record<string, unknown> {
  return {
    completedAt: report.completedAt,
    counts: {
      errors: report.counts.errors,
      findings: report.counts.findings,
      ignored: report.counts.ignored,
      itemErrors: report.counts.itemErrors,
      open: report.counts.open,
      repaired: report.counts.repaired,
      resolved: report.counts.resolved,
      scanned: report.counts.scanned,
      warnings: report.counts.warnings,
    },
    findings: report.findings.map((finding) => ({
      channelId: finding.channelId,
      evidenceVersion: finding.evidenceVersion,
      kind: finding.kind,
      ...(finding.messageId === undefined ? {} : { messageId: finding.messageId }),
      ...(finding.observationId === undefined ? {} : { observationId: finding.observationId }),
      sanitizedReason: finding.sanitizedReason,
      severity: finding.severity,
      stableKey: finding.stableKey,
      state: finding.state,
    })),
    findingsTruncated: report.findingsTruncated,
    issues: report.issues.map((issue) => ({
      code: issue.code,
      sanitizedReason: issue.sanitizedReason,
    })),
    issuesTruncated: report.issuesTruncated,
    mode: report.mode,
    schemaVersion: report.schemaVersion,
    scope: {
      channelIds: [...report.scope.channelIds],
      channelIdsTruncated: report.scope.channelIdsTruncated,
    },
    startedAt: report.startedAt,
    status: report.status,
  };
}
