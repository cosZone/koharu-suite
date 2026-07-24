import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  messageSourceObservations,
  messages,
  reconciliationActions,
  reconciliationFindings,
  reconciliationRuns,
  reconciliationSchedule,
  telegramChannels,
} from '../db/schema.js';
import {
  addReconciliationFinding,
  createReconciliationFindingKey,
  createReconciliationReport,
  finishReconciliationReport,
  type ReconciliationReport,
  sanitizeReconciliationReportText,
} from './report.js';
import {
  PostgresReconciliationRepository,
  RECONCILIATION_ADVISORY_LOCK,
  RECONCILIATION_SCAN_BATCH_SIZE,
  type ReconciliationCandidate,
  type ReconciliationSnapshotScanner,
  type ReconciliationTransaction,
  reconciliationScope,
} from './repository.js';
import type {
  ClaimedScheduledReconciliationScanInput,
  ClaimedScheduledReconciliationScanner,
} from './scheduled-runner.js';
import {
  assertReconciliationFindingScope,
  type ReconciliationEvidenceKind,
  type ReconciliationFindingSeverity,
  type ReconciliationFindingState,
} from './types.js';

export type ReconciliationInitiatorKind =
  | 'local_operator'
  | 'owner_session'
  | 'service_token'
  | 'worker';

export interface PersistedReconciliationScanInput {
  initiatorId?: string;
  initiatorKind: ReconciliationInitiatorKind;
  now?: Date;
  telegramChannelIds: readonly bigint[];
}

export interface PersistedReconciliationScanResult {
  report: ReconciliationReport;
  runId: string;
}

export interface IgnoreFindingInput {
  expectedEvidenceVersion: number;
  findingId: string;
  initiatorId?: string;
  initiatorKind: ReconciliationInitiatorKind;
  reason: string;
}

export interface PersistedFindingState {
  evidenceVersion: number;
  id: string;
  state: ReconciliationFindingState;
}

export interface ReconciliationListPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ReconciliationFindingSummary {
  evidenceVersion: number;
  firstSeenAt: string;
  id: string;
  kind: ReconciliationEvidenceKind;
  lastSeenAt: string;
  messageId: string | null;
  messageTombstoned: boolean;
  observationId: string | null;
  sanitizedDetails: Record<string, unknown>;
  severity: ReconciliationFindingSeverity;
  stableKey: string;
  state: ReconciliationFindingState;
  telegramChatId: string | null;
}

export interface ReconciliationRunSummary {
  completedAt: string | null;
  id: string;
  mode: 'apply' | 'persisted_scan' | 'scheduled_scan';
  scope: string[];
  startedAt: string;
  status: 'completed' | 'failed' | 'interrupted' | 'partial' | 'running';
}

const EXHAUSTIVELY_VERIFIED_KINDS = [
  'current_pointer_invalid',
  'derived_html_drift',
  'durable_blocked',
  'durable_pending',
  'import_lineage_missing',
  'media_evidence_missing',
  'message_id_candidate',
  'retention_risk',
] as const satisfies readonly ReconciliationEvidenceKind[];

type FindingWrite = {
  evidenceVersion: number;
  kind: ReconciliationEvidenceKind;
  messageId: string | null;
  observationId: string | null;
  sanitizedDetails: Record<string, unknown>;
  severity: ReconciliationFindingSeverity;
  stableKey: string;
  telegramChatId: bigint | null;
};

type FindingIdentityRow = {
  evidenceVersion: number;
  id: string;
  kind: ReconciliationEvidenceKind;
  messageId: string | null;
  observationId: string | null;
  state: ReconciliationFindingState;
  telegramChatId: bigint | null;
};

interface PersistScanTransactionInput {
  completedAt?: Date;
  initiatorId?: string;
  initiatorKind: ReconciliationInitiatorKind;
  mode: 'persisted-scan' | 'scheduled-scan';
  reportStartedAt: Date;
  runId: string;
  scanAt: Date;
  scope: readonly bigint[];
  scopeStrings: readonly string[];
  signal?: AbortSignal;
}

export class PostgresReconciliationPersistenceRepository
  implements ClaimedScheduledReconciliationScanner
{
  private readonly scanner: ReconciliationSnapshotScanner;

  constructor(
    private readonly database: Database,
    scanner?: ReconciliationSnapshotScanner,
  ) {
    this.scanner = scanner ?? new PostgresReconciliationRepository(database);
  }

  async listFindings(input: {
    cursor?: string;
    limit: number;
  }): Promise<ReconciliationListPage<ReconciliationFindingSummary>> {
    assertListLimit(input.limit);
    const cursor = input.cursor
      ? await this.database
          .select({
            id: reconciliationFindings.id,
            lastSeenAt: reconciliationFindings.lastSeenAt,
          })
          .from(reconciliationFindings)
          .where(eq(reconciliationFindings.id, input.cursor))
          .limit(1)
          .then(([row]) => row)
      : undefined;
    if (input.cursor && !cursor) {
      throw new RangeError('Invalid reconciliation cursor');
    }
    const rows = await this.database
      .select({
        finding: reconciliationFindings,
        messageTombstoned: sql<boolean>`${messages.tombstonedAt} is not null`,
      })
      .from(reconciliationFindings)
      .leftJoin(messages, eq(reconciliationFindings.messageId, messages.id))
      .where(
        cursor
          ? or(
              lt(reconciliationFindings.lastSeenAt, cursor.lastSeenAt),
              and(
                eq(reconciliationFindings.lastSeenAt, cursor.lastSeenAt),
                lt(reconciliationFindings.id, cursor.id),
              ),
            )
          : undefined,
      )
      .orderBy(desc(reconciliationFindings.lastSeenAt), desc(reconciliationFindings.id))
      .limit(input.limit + 1);
    return page(
      rows.map(({ finding, messageTombstoned }) => ({
        evidenceVersion: finding.evidenceVersion,
        firstSeenAt: finding.firstSeenAt.toISOString(),
        id: finding.id,
        kind: finding.kind,
        lastSeenAt: finding.lastSeenAt.toISOString(),
        messageId: finding.messageId,
        messageTombstoned,
        observationId: finding.observationId,
        sanitizedDetails: finding.sanitizedDetails,
        severity: finding.severity,
        stableKey: finding.stableKey,
        state: finding.state,
        telegramChatId: finding.telegramChatId?.toString() ?? null,
      })),
      input.limit,
    );
  }

  async listRuns(input: {
    cursor?: string;
    limit: number;
  }): Promise<ReconciliationListPage<ReconciliationRunSummary>> {
    assertListLimit(input.limit);
    const cursor = input.cursor
      ? await this.database
          .select({
            id: reconciliationRuns.id,
            startedAt: reconciliationRuns.startedAt,
          })
          .from(reconciliationRuns)
          .where(eq(reconciliationRuns.id, input.cursor))
          .limit(1)
          .then(([row]) => row)
      : undefined;
    if (input.cursor && !cursor) {
      throw new RangeError('Invalid reconciliation cursor');
    }
    const rows = await this.database
      .select()
      .from(reconciliationRuns)
      .where(
        cursor
          ? or(
              lt(reconciliationRuns.startedAt, cursor.startedAt),
              and(
                eq(reconciliationRuns.startedAt, cursor.startedAt),
                lt(reconciliationRuns.id, cursor.id),
              ),
            )
          : undefined,
      )
      .orderBy(desc(reconciliationRuns.startedAt), desc(reconciliationRuns.id))
      .limit(input.limit + 1);
    return page(
      rows.map((row) => ({
        completedAt: row.completedAt?.toISOString() ?? null,
        id: row.id,
        mode: row.mode,
        scope: row.scope,
        startedAt: row.startedAt.toISOString(),
        status: row.status,
      })),
      input.limit,
    );
  }

  async persistScan(
    input: PersistedReconciliationScanInput,
  ): Promise<PersistedReconciliationScanResult> {
    const now = input.now ?? new Date();
    const scope = reconciliationScope(input.telegramChannelIds);
    const scopeStrings = scope.map(String);
    assertInitiator(input.initiatorKind, input.initiatorId);

    return this.database.transaction(
      async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${RECONCILIATION_ADVISORY_LOCK})`,
        );
        const [run] = await transaction
          .insert(reconciliationRuns)
          .values({
            initiatorId: input.initiatorId,
            initiatorKind: input.initiatorKind,
            mode: 'persisted_scan',
            report: {},
            scope: scopeStrings,
            startedAt: now,
            status: 'running',
          })
          .returning({ id: reconciliationRuns.id });
        if (!run) {
          throw new Error('Failed to create persisted reconciliation run');
        }

        const report = await this.persistScanInTransaction(transaction, {
          completedAt: now,
          ...(input.initiatorId === undefined ? {} : { initiatorId: input.initiatorId }),
          initiatorKind: input.initiatorKind,
          mode: 'persisted-scan',
          reportStartedAt: now,
          runId: run.id,
          scanAt: now,
          scope,
          scopeStrings,
        });
        const [completed] = await transaction
          .update(reconciliationRuns)
          .set({
            completedAt: now,
            report: reportJson(report),
            status: report.status === 'partial' ? 'partial' : 'completed',
          })
          .where(and(eq(reconciliationRuns.id, run.id), eq(reconciliationRuns.status, 'running')))
          .returning({ id: reconciliationRuns.id });
        if (!completed) {
          throw new Error('Persisted reconciliation run lost its running state');
        }
        return { report, runId: run.id };
      },
      { isolationLevel: 'repeatable read' },
    );
  }

  async scanClaimedRun(
    input: ClaimedScheduledReconciliationScanInput,
  ): Promise<ReconciliationReport> {
    const runId = input.runId.trim();
    if (runId.length === 0) {
      throw new TypeError('Claimed reconciliation run ID must not be empty');
    }
    const { scope, scopeStrings } = normalizeScheduledScope(input.telegramChannelIds);
    let startedAt: Date | undefined;

    try {
      return await this.database.transaction(
        async (transaction) => {
          await transaction.execute(
            sql`select pg_advisory_xact_lock(${RECONCILIATION_ADVISORY_LOCK})`,
          );
          const [run] = await transaction
            .select()
            .from(reconciliationRuns)
            .where(eq(reconciliationRuns.id, runId))
            .limit(1)
            .for('update');
          const [schedule] = await transaction
            .select({
              claimedRunId: reconciliationSchedule.claimedRunId,
              leaseActive: sql<boolean>`${reconciliationSchedule.leaseExpiresAt}
                > clock_timestamp()`,
              leaseOwner: reconciliationSchedule.leaseOwner,
              leaseToken: reconciliationSchedule.leaseToken,
            })
            .from(reconciliationSchedule)
            .where(eq(reconciliationSchedule.singletonKey, 'telegram'))
            .limit(1);
          if (!run || schedule?.claimedRunId !== runId) {
            throw new Error('Scheduled reconciliation run is not the current claimed run');
          }
          if (
            run.status !== 'running' ||
            run.mode !== 'scheduled_scan' ||
            run.initiatorKind !== 'worker'
          ) {
            throw new Error('Scheduled reconciliation run must be a running worker scheduled scan');
          }
          if (
            !schedule.leaseOwner ||
            !schedule.leaseToken ||
            run.initiatorId !== `${schedule.leaseOwner}:${schedule.leaseToken}`
          ) {
            throw new Error('Scheduled reconciliation run lease token binding is invalid');
          }
          if (!schedule.leaseActive) {
            throw new Error('Scheduled reconciliation run lease has expired');
          }
          if (!equalScope(run.scope, scopeStrings)) {
            throw new Error('Scheduled reconciliation run scope does not match the claimed scope');
          }
          startedAt = run.startedAt;
          return this.persistScanInTransaction(transaction, {
            initiatorId: run.initiatorId,
            initiatorKind: 'worker',
            mode: 'scheduled-scan',
            reportStartedAt: run.startedAt,
            runId,
            scanAt: new Date(),
            scope,
            scopeStrings,
            signal: input.signal,
          });
        },
        { isolationLevel: 'repeatable read' },
      );
    } catch (error) {
      if (!(error instanceof ClaimedScanInterruptedError) || !startedAt) {
        throw error;
      }
      const report = createReconciliationReport({
        channelIds: scopeStrings,
        mode: 'scheduled-scan',
        startedAt,
      });
      finishReconciliationReport(report, {
        completedAt: new Date(),
        interrupted: true,
      });
      return report;
    }
  }

  private async persistScanInTransaction(
    transaction: ReconciliationTransaction,
    input: PersistScanTransactionInput,
  ): Promise<ReconciliationReport> {
    const assertNotAborted = () => {
      if (input.signal?.aborted) {
        throw new ClaimedScanInterruptedError();
      }
    };
    assertNotAborted();
    await transaction.execute(sql`
      create temporary table pg_temp.reconciliation_seen_keys (
        stable_key text primary key
      ) on commit drop
    `);
    const report = createReconciliationReport({
      channelIds: input.scopeStrings,
      mode: input.mode,
      startedAt: input.reportStartedAt,
    });
    const pending: ReconciliationCandidate[] = [];
    const flush = async () => {
      assertNotAborted();
      if (pending.length === 0) {
        return;
      }
      const candidates = pending.splice(0, pending.length);
      const writes = candidates.map(candidateWrite);
      const persisted = await persistFindingBatch(
        transaction,
        input.runId,
        input.initiatorKind,
        input.initiatorId,
        writes,
      );
      await recordSeenKeys(
        transaction,
        writes.map((write) => write.stableKey),
      );
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const finding = persisted[index];
        if (!candidate || !finding) {
          throw new Error('Persisted finding batch result is incomplete');
        }
        addReconciliationFinding(report, {
          channelId: candidate.channelId,
          evidenceVersion: finding.evidenceVersion,
          kind: candidate.kind,
          ...(candidate.messageId === undefined ? {} : { messageId: candidate.messageId }),
          ...(candidate.observationId === undefined
            ? {}
            : { observationId: candidate.observationId }),
          sanitizedReason: candidate.sanitizedReason,
          severity: candidate.severity,
          stableKey: writes[index]?.stableKey ?? '',
          state: finding.state,
        });
      }
      assertNotAborted();
    };

    const snapshot = await this.scanner.scanSnapshotInTransaction(
      transaction,
      input.scope,
      input.scanAt,
      async (candidate) => {
        assertNotAborted();
        pending.push(candidate);
        if (pending.length === RECONCILIATION_SCAN_BATCH_SIZE) {
          await flush();
        }
      },
    );
    assertNotAborted();
    await flush();
    const verifiedResolved = await resolveAbsentExhaustiveFindings(
      transaction,
      input.runId,
      input.initiatorKind,
      input.initiatorId,
      input.scope,
      assertNotAborted,
    );
    assertNotAborted();
    report.counts.scanned = snapshot.scanned;
    report.counts.errors += verifiedResolved.errors;
    report.counts.findings += verifiedResolved.resolved;
    report.counts.resolved += verifiedResolved.resolved;
    report.counts.warnings += verifiedResolved.warnings;
    if (verifiedResolved.resolved > 0) {
      report.findingsTruncated = true;
    }
    finishReconciliationReport(report, { completedAt: input.completedAt ?? new Date() });
    return report;
  }

  async ignoreFinding(input: IgnoreFindingInput): Promise<PersistedFindingState> {
    assertPositiveEvidenceVersion(input.expectedEvidenceVersion);
    assertInitiator(input.initiatorKind, input.initiatorId);
    if (input.initiatorKind !== 'owner_session' || !input.initiatorId) {
      throw new TypeError('Only an identified owner session can ignore a reconciliation finding');
    }
    const reason = auditReason(input.reason);

    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${RECONCILIATION_ADVISORY_LOCK})`);
      const [finding] = await transaction
        .select({
          evidenceVersion: reconciliationFindings.evidenceVersion,
          id: reconciliationFindings.id,
          state: reconciliationFindings.state,
        })
        .from(reconciliationFindings)
        .where(eq(reconciliationFindings.id, input.findingId))
        .limit(1)
        .for('update');
      if (!finding) {
        throw new Error('Reconciliation finding was not found');
      }
      if (finding.evidenceVersion !== input.expectedEvidenceVersion) {
        throw new Error('Reconciliation finding evidence version changed');
      }
      if (finding.state === 'ignored') {
        return finding;
      }
      if (finding.state !== 'open') {
        throw new Error('Only an open finding can be ignored');
      }

      const [ignored] = await transaction
        .update(reconciliationFindings)
        .set({
          resolvedAt: sql`clock_timestamp()`,
          state: 'ignored',
        })
        .where(eq(reconciliationFindings.id, finding.id))
        .returning({
          evidenceVersion: reconciliationFindings.evidenceVersion,
          id: reconciliationFindings.id,
          state: reconciliationFindings.state,
        });
      if (!ignored) {
        throw new Error('Failed to ignore reconciliation finding');
      }
      await transaction.insert(reconciliationActions).values({
        actionKind: 'ignore_finding',
        afterState: {
          evidenceVersion: ignored.evidenceVersion,
          state: ignored.state,
        },
        beforeState: {
          evidenceVersion: finding.evidenceVersion,
          state: finding.state,
        },
        findingId: finding.id,
        initiatorId: input.initiatorId,
        initiatorKind: input.initiatorKind,
        reason,
      });
      return ignored;
    });
  }
}

function candidateWrite(candidate: ReconciliationCandidate): FindingWrite {
  assertReconciliationFindingScope(candidate.kind, candidate.channelId);
  assertPositiveEvidenceVersion(candidate.evidenceVersion);
  return {
    evidenceVersion: candidate.evidenceVersion,
    kind: candidate.kind,
    messageId: candidate.messageId ?? null,
    observationId: candidate.observationId ?? null,
    sanitizedDetails: {
      reason: sanitizeReconciliationReportText(candidate.sanitizedReason),
    },
    severity: candidate.severity,
    stableKey: createReconciliationFindingKey({
      channelId: candidate.channelId,
      kind: candidate.kind,
      ...(candidate.evidenceIds === undefined ? {} : { evidenceIds: candidate.evidenceIds }),
      ...(candidate.messageId === undefined ? {} : { messageId: candidate.messageId }),
      ...(candidate.observationId === undefined ? {} : { observationId: candidate.observationId }),
    }),
    telegramChatId: candidate.channelId === null ? null : BigInt(candidate.channelId),
  };
}

async function persistFindingBatch(
  transaction: ReconciliationTransaction,
  runId: string,
  initiatorKind: ReconciliationInitiatorKind,
  initiatorId: string | undefined,
  writes: readonly FindingWrite[],
): Promise<PersistedFindingState[]> {
  if (writes.length > RECONCILIATION_SCAN_BATCH_SIZE) {
    throw new RangeError(
      `A persisted finding batch may contain at most ${RECONCILIATION_SCAN_BATCH_SIZE} rows`,
    );
  }
  await validateFindingAssociations(transaction, writes);
  const results: PersistedFindingState[] = [];
  for (const write of writes) {
    const [inserted] = await transaction
      .insert(reconciliationFindings)
      .values({
        evidenceVersion: write.evidenceVersion,
        kind: write.kind,
        messageId: write.messageId,
        observationId: write.observationId,
        sanitizedDetails: write.sanitizedDetails,
        severity: write.severity,
        stableKey: write.stableKey,
        telegramChatId: write.telegramChatId,
      })
      .onConflictDoNothing({ target: reconciliationFindings.stableKey })
      .returning({
        evidenceVersion: reconciliationFindings.evidenceVersion,
        id: reconciliationFindings.id,
        state: reconciliationFindings.state,
      });
    if (inserted) {
      results.push(inserted);
      continue;
    }

    const [existing] = await transaction
      .select({
        evidenceVersion: reconciliationFindings.evidenceVersion,
        id: reconciliationFindings.id,
        kind: reconciliationFindings.kind,
        messageId: reconciliationFindings.messageId,
        observationId: reconciliationFindings.observationId,
        state: reconciliationFindings.state,
        telegramChatId: reconciliationFindings.telegramChatId,
      })
      .from(reconciliationFindings)
      .where(eq(reconciliationFindings.stableKey, write.stableKey))
      .limit(1)
      .for('update');
    if (!existing) {
      throw new Error('Reconciliation finding disappeared during stable-key upsert');
    }
    assertStableIdentity(existing, write);
    if (write.evidenceVersion < existing.evidenceVersion) {
      throw new RangeError('Incoming reconciliation evidence version cannot move backwards');
    }
    const reopen = write.evidenceVersion > existing.evidenceVersion;
    const [updated] = await transaction
      .update(reconciliationFindings)
      .set({
        evidenceVersion: write.evidenceVersion,
        lastSeenAt: sql`clock_timestamp()`,
        ...(reopen ? { resolvedAt: null, state: 'open' as const } : {}),
        sanitizedDetails: write.sanitizedDetails,
        severity: write.severity,
      })
      .where(eq(reconciliationFindings.id, existing.id))
      .returning({
        evidenceVersion: reconciliationFindings.evidenceVersion,
        id: reconciliationFindings.id,
        state: reconciliationFindings.state,
      });
    if (!updated) {
      throw new Error('Failed to update reconciliation finding lifecycle');
    }
    if (reopen) {
      await transaction.insert(reconciliationActions).values({
        actionKind: 'reopen_new_evidence',
        afterState: {
          evidenceVersion: updated.evidenceVersion,
          state: updated.state,
        },
        beforeState: {
          evidenceVersion: existing.evidenceVersion,
          state: existing.state,
        },
        findingId: existing.id,
        initiatorId,
        initiatorKind,
        reason: 'A newer evidence version reopened this finding',
        runId,
      });
    }
    results.push(updated);
  }
  return results;
}

async function recordSeenKeys(
  transaction: ReconciliationTransaction,
  stableKeys: readonly string[],
): Promise<void> {
  if (stableKeys.length === 0) {
    return;
  }
  const values = sql.join(
    [...new Set(stableKeys)].map((stableKey) => sql`(${stableKey})`),
    sql`, `,
  );
  await transaction.execute(sql`
    insert into pg_temp.reconciliation_seen_keys (stable_key)
    values ${values}
    on conflict (stable_key) do nothing
  `);
}

async function resolveAbsentExhaustiveFindings(
  transaction: ReconciliationTransaction,
  runId: string,
  initiatorKind: ReconciliationInitiatorKind,
  initiatorId: string | undefined,
  scope: readonly bigint[],
  assertNotAborted: () => void = () => undefined,
): Promise<{ errors: number; resolved: number; warnings: number }> {
  let cursor: string | undefined;
  let resolvedCount = 0;
  let errors = 0;
  let warnings = 0;
  while (true) {
    assertNotAborted();
    const rows = await transaction
      .select({
        evidenceVersion: reconciliationFindings.evidenceVersion,
        id: reconciliationFindings.id,
        severity: reconciliationFindings.severity,
        state: reconciliationFindings.state,
      })
      .from(reconciliationFindings)
      .where(
        and(
          eq(reconciliationFindings.state, 'open'),
          inArray(reconciliationFindings.kind, EXHAUSTIVELY_VERIFIED_KINDS),
          or(
            inArray(reconciliationFindings.telegramChatId, scope),
            and(
              isNull(reconciliationFindings.telegramChatId),
              eq(reconciliationFindings.kind, 'retention_risk'),
            ),
          ),
          cursor ? gt(reconciliationFindings.id, cursor) : undefined,
          sql`not exists (
            select 1
            from pg_temp.reconciliation_seen_keys as seen
            where seen.stable_key = ${reconciliationFindings.stableKey}
          )`,
        ),
      )
      .orderBy(asc(reconciliationFindings.id))
      .limit(RECONCILIATION_SCAN_BATCH_SIZE)
      .for('update');
    for (const finding of rows) {
      assertNotAborted();
      const [resolved] = await transaction
        .update(reconciliationFindings)
        .set({
          resolvedAt: sql`clock_timestamp()`,
          state: 'resolved',
        })
        .where(
          and(
            eq(reconciliationFindings.id, finding.id),
            eq(reconciliationFindings.evidenceVersion, finding.evidenceVersion),
            eq(reconciliationFindings.state, 'open'),
          ),
        )
        .returning({
          evidenceVersion: reconciliationFindings.evidenceVersion,
          state: reconciliationFindings.state,
        });
      if (!resolved) {
        throw new Error('Exhaustive verifier lost finding lifecycle ownership');
      }
      await transaction.insert(reconciliationActions).values({
        actionKind: 'resolve_verified_invariant',
        afterState: {
          evidenceVersion: resolved.evidenceVersion,
          state: resolved.state,
        },
        beforeState: {
          evidenceVersion: finding.evidenceVersion,
          state: finding.state,
        },
        findingId: finding.id,
        initiatorId,
        initiatorKind,
        reason: 'Exhaustive persisted scan verified that the invariant now holds',
        runId,
      });
      resolvedCount += 1;
      if (finding.severity === 'error') {
        errors += 1;
      } else {
        warnings += 1;
      }
      assertNotAborted();
    }
    if (rows.length < RECONCILIATION_SCAN_BATCH_SIZE) {
      return { errors, resolved: resolvedCount, warnings };
    }
    cursor = rows.at(-1)?.id;
  }
}

async function validateFindingAssociations(
  transaction: ReconciliationTransaction,
  writes: readonly FindingWrite[],
): Promise<void> {
  const messageIds = [
    ...new Set(writes.flatMap((write) => (write.messageId ? [write.messageId] : []))),
  ];
  const observationIds = [
    ...new Set(writes.flatMap((write) => (write.observationId ? [write.observationId] : []))),
  ];
  const messageRows =
    messageIds.length === 0
      ? []
      : await transaction
          .select({
            channelId: telegramChannels.telegramChatId,
            id: messages.id,
          })
          .from(messages)
          .innerJoin(telegramChannels, eq(telegramChannels.id, messages.channelId))
          .where(inArray(messages.id, messageIds));
  const observationRows =
    observationIds.length === 0
      ? []
      : await transaction
          .select({
            channelId: telegramChannels.telegramChatId,
            id: messageSourceObservations.id,
            messageId: messageSourceObservations.messageId,
          })
          .from(messageSourceObservations)
          .innerJoin(telegramChannels, eq(telegramChannels.id, messageSourceObservations.channelId))
          .where(inArray(messageSourceObservations.id, observationIds));
  const messageById = new Map(messageRows.map((row) => [row.id, row]));
  const observationById = new Map(observationRows.map((row) => [row.id, row]));

  for (const write of writes) {
    if (write.telegramChatId === null && (write.messageId || write.observationId)) {
      throw new Error('A global reconciliation finding cannot reference channel entities');
    }
    const message = write.messageId ? messageById.get(write.messageId) : undefined;
    if (write.messageId && !message) {
      throw new Error('Reconciliation finding message was not found');
    }
    const observation = write.observationId ? observationById.get(write.observationId) : undefined;
    if (write.observationId && !observation) {
      throw new Error('Reconciliation finding observation was not found');
    }
    if (message && message.channelId !== write.telegramChatId) {
      throw new Error('Reconciliation finding message belongs to another channel');
    }
    if (observation && observation.channelId !== write.telegramChatId) {
      throw new Error('Reconciliation finding observation belongs to another channel');
    }
    if (message && observation && observation.messageId !== message.id) {
      throw new Error('Reconciliation finding message and observation do not match');
    }
  }
}

function assertStableIdentity(existing: FindingIdentityRow, incoming: FindingWrite): void {
  if (
    existing.kind !== incoming.kind ||
    existing.telegramChatId !== incoming.telegramChatId ||
    existing.messageId !== incoming.messageId ||
    existing.observationId !== incoming.observationId
  ) {
    throw new Error('Reconciliation stable key is already bound to a different finding identity');
  }
}

function assertPositiveEvidenceVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('Evidence version must be a positive safe integer');
  }
}

function assertInitiator(kind: ReconciliationInitiatorKind, id: string | undefined): void {
  if (kind !== 'local_operator' && (!id || id.trim().length === 0)) {
    throw new TypeError(`${kind} reconciliation initiator requires a non-empty ID`);
  }
  if (id !== undefined && id.trim().length === 0) {
    throw new TypeError('Reconciliation initiator ID must not be empty');
  }
}

class ClaimedScanInterruptedError extends Error {
  constructor() {
    super('Claimed reconciliation scan was interrupted');
  }
}

function normalizeScheduledScope(channelIds: readonly string[]): {
  scope: bigint[];
  scopeStrings: string[];
} {
  const parsed = channelIds.map((channelId) => {
    if (channelId.length > 20 || !/^-[1-9]\d*$/u.test(channelId)) {
      throw new TypeError('Scheduled reconciliation scope must contain canonical channel IDs');
    }
    const telegramChannelId = BigInt(channelId);
    if (telegramChannelId < -9_223_372_036_854_775_808n) {
      throw new RangeError('Scheduled reconciliation channel ID is outside the bigint range');
    }
    return telegramChannelId;
  });
  const scope = reconciliationScope(parsed);
  const scopeStrings = scope.map(String);
  return { scope, scopeStrings };
}

function equalScope(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function auditReason(value: string): string {
  const reason = value.trim();
  if (reason.length === 0 || [...reason].length > 500) {
    throw new TypeError('Reconciliation audit reason must contain between 1 and 500 characters');
  }
  return reason;
}

function reportJson(report: ReconciliationReport): Record<string, unknown> {
  return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
}

function assertListLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new RangeError('Reconciliation list limit must be between 1 and 100');
  }
}

function page<T extends { id: string }>(
  rows: readonly T[],
  limit: number,
): ReconciliationListPage<T> {
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
  };
}
