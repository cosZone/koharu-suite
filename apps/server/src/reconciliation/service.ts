import {
  addReconciliationFinding,
  addReconciliationReportIssue,
  createReconciliationFindingKey,
  createReconciliationReport,
  finishReconciliationReport,
  RECONCILIATION_REPORT_SCOPE_LIMIT,
  type ReconciliationReport,
} from './report.js';
import { type ReconciliationScanner, ReconciliationScopeError } from './repository.js';

export interface ReconciliationDryRunInput {
  now?: Date;
  telegramChannelIds: readonly bigint[];
}

export class ReconciliationService {
  constructor(private readonly repository: ReconciliationScanner) {}

  async scan(input: ReconciliationDryRunInput): Promise<ReconciliationReport> {
    const now = input.now ?? new Date();
    const telegramChannelIds = boundedUniqueTelegramChannelIds(input.telegramChannelIds);
    const channelIds = telegramChannelIds
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map(String);
    const report = createReconciliationReport({
      channelIds,
      mode: 'dry-run',
      startedAt: now,
    });
    if (telegramChannelIds.length > RECONCILIATION_REPORT_SCOPE_LIMIT) {
      addReconciliationReportIssue(report, {
        code: 'invalid_scope',
        sanitizedReason: `A scan may include at most ${RECONCILIATION_REPORT_SCOPE_LIMIT} channels`,
      });
      return finishReconciliationReport(report, {
        completedAt: now,
        fatal: true,
      });
    }

    try {
      const snapshot = await this.repository.scanDryRun(telegramChannelIds, now, (candidate) => {
        addReconciliationFinding(report, {
          channelId: candidate.channelId,
          evidenceVersion: candidate.evidenceVersion,
          kind: candidate.kind,
          ...(candidate.messageId === undefined ? {} : { messageId: candidate.messageId }),
          ...(candidate.observationId === undefined
            ? {}
            : { observationId: candidate.observationId }),
          sanitizedReason: candidate.sanitizedReason,
          severity: candidate.severity,
          stableKey: createReconciliationFindingKey({
            channelId: candidate.channelId,
            kind: candidate.kind,
            ...(candidate.evidenceIds === undefined ? {} : { evidenceIds: candidate.evidenceIds }),
            ...(candidate.messageId === undefined ? {} : { messageId: candidate.messageId }),
            ...(candidate.observationId === undefined
              ? {}
              : { observationId: candidate.observationId }),
          }),
          state: 'open',
        });
      });
      report.counts.scanned = snapshot.scanned;
      return finishReconciliationReport(report, { completedAt: now });
    } catch (error) {
      addReconciliationReportIssue(report, {
        code: error instanceof ReconciliationScopeError ? 'invalid_scope' : 'scan_failed',
        sanitizedReason:
          error instanceof ReconciliationScopeError
            ? error.message
            : 'The reconciliation scan could not be completed',
      });
      return finishReconciliationReport(report, {
        completedAt: now,
        fatal: true,
      });
    }
  }
}

function boundedUniqueTelegramChannelIds(values: readonly bigint[]): bigint[] {
  const unique = new Set<bigint>();
  for (const value of values) {
    unique.add(value);
    if (unique.size > RECONCILIATION_REPORT_SCOPE_LIMIT) {
      break;
    }
  }
  return [...unique];
}
