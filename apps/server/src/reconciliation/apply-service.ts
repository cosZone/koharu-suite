import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { reconciliationFindings, reconciliationRuns } from '../db/schema.js';
import { lockSourceEvidenceDiscovery } from '../messages/source-evidence-coordination.js';
import type { ReconciliationCliApplyInput } from './cli.js';
import type { PostgresReconciliationPersistenceRepository } from './persistence-repository.js';
import { validateReconciliationRepairInput } from './repair.js';
import type { PostgresDeterministicRepairRepository } from './repair-repository.js';
import {
  addReconciliationReportIssue,
  finishReconciliationReport,
  type ReconciliationReport,
} from './report.js';
import { RECONCILIATION_ADVISORY_LOCK, reconciliationScope } from './repository.js';
import type { ReconciliationEvidenceKind } from './types.js';

const RECONCILIATION_APPLY_BATCH_LIMIT = 500;
const DETERMINISTIC_REPAIR_KINDS = [
  'current_pointer_invalid',
  'derived_html_drift',
  'import_lineage_missing',
  'media_evidence_missing',
] as const satisfies readonly ReconciliationEvidenceKind[];

export class ReconciliationApplyService {
  constructor(
    private readonly database: Database,
    private readonly persistence: Pick<
      PostgresReconciliationPersistenceRepository,
      'persistScanInLockedTransaction'
    >,
    private readonly repair: Pick<PostgresDeterministicRepairRepository, 'applyInTransaction'>,
  ) {}

  async apply(input: ReconciliationCliApplyInput): Promise<ReconciliationReport> {
    return this.database.transaction(
      async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${RECONCILIATION_ADVISORY_LOCK})`,
        );
        await lockSourceEvidenceDiscovery(transaction);
        const startedAt = new Date();
        const scope = reconciliationScope(input.channelIds);
        const persisted = await this.persistence.persistScanInLockedTransaction(transaction, {
          initiatorKind: input.initiatorKind,
          telegramChannelIds: scope,
        });
        const report = applyReportFromPersisted(persisted.report, startedAt);
        const [applyRun] = await transaction
          .insert(reconciliationRuns)
          .values({
            initiatorId: input.initiatorId,
            initiatorKind: input.initiatorKind,
            mode: 'apply',
            report: {},
            scope: report.scope.channelIds,
            startedAt,
            status: 'running',
          })
          .returning({ id: reconciliationRuns.id });
        if (!applyRun) {
          throw new Error('Failed to create reconciliation batch apply run');
        }

        const candidates = await transaction
          .select({
            evidenceVersion: reconciliationFindings.evidenceVersion,
            id: reconciliationFindings.id,
            stableKey: reconciliationFindings.stableKey,
          })
          .from(reconciliationFindings)
          .where(
            and(
              eq(reconciliationFindings.state, 'open'),
              inArray(reconciliationFindings.kind, DETERMINISTIC_REPAIR_KINDS),
              inArray(reconciliationFindings.telegramChatId, scope),
            ),
          )
          .orderBy(asc(reconciliationFindings.telegramChatId), asc(reconciliationFindings.id))
          .limit(RECONCILIATION_APPLY_BATCH_LIMIT + 1);

        if (candidates.length > RECONCILIATION_APPLY_BATCH_LIMIT) {
          addReconciliationReportIssue(report, {
            code: 'repair_batch_truncated',
            sanitizedReason:
              'The bounded repair batch limit was reached; rerun apply to continue verified repairs',
          });
        }

        let repaired = 0;
        for (const candidate of candidates.slice(0, RECONCILIATION_APPLY_BATCH_LIMIT)) {
          try {
            const repairInput = validateReconciliationRepairInput({
              expectedEvidenceVersion: candidate.evidenceVersion,
              findingId: candidate.id,
              initiatorId: input.initiatorId,
              initiatorKind: input.initiatorKind,
              reason: input.reason,
            });
            const result = await transaction.transaction((savepoint) =>
              this.repair.applyInTransaction(savepoint, repairInput, {
                runId: applyRun.id,
              }),
            );
            resolveReportFinding(report, candidate.stableKey);
            if (result.changed) {
              repaired += 1;
            }
          } catch {
            addReconciliationReportIssue(report, {
              code: 'deterministic_repair_failed',
              sanitizedReason:
                'A finding changed or could not be uniquely repaired; it remains open for review',
            });
          }
        }

        finishReconciliationReport(report, { repaired });
        const [completed] = await transaction
          .update(reconciliationRuns)
          .set({
            completedAt: new Date(report.completedAt ?? Date.now()),
            report: reportJson(report),
            status: report.status === 'partial' ? 'partial' : 'completed',
          })
          .where(
            and(eq(reconciliationRuns.id, applyRun.id), eq(reconciliationRuns.status, 'running')),
          )
          .returning({ id: reconciliationRuns.id });
        if (!completed) {
          throw new Error('Reconciliation batch apply run lost its running state');
        }
        return report;
      },
      { isolationLevel: 'repeatable read' },
    );
  }
}

function reportJson(report: ReconciliationReport): Record<string, unknown> {
  return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
}

function applyReportFromPersisted(
  persisted: ReconciliationReport,
  startedAt: Date,
): ReconciliationReport {
  return {
    ...persisted,
    completedAt: null,
    counts: { ...persisted.counts, repaired: 0 },
    findings: persisted.findings.map((finding) => ({ ...finding })),
    issues: persisted.issues.map((issue) => ({ ...issue })),
    mode: 'apply',
    scope: {
      channelIds: [...persisted.scope.channelIds],
      channelIdsTruncated: persisted.scope.channelIdsTruncated,
    },
    startedAt: startedAt.toISOString(),
    status: 'clean',
  };
}

function resolveReportFinding(report: ReconciliationReport, stableKey: string): void {
  if (report.counts.open > 0) {
    report.counts.open -= 1;
    report.counts.resolved += 1;
  }
  const sample = report.findings.find((finding) => finding.stableKey === stableKey);
  if (sample?.state === 'open') {
    sample.state = 'resolved';
  }
}
