import {
  addReconciliationReportIssue,
  createReconciliationReport,
  finishReconciliationReport,
  type ReconciliationReport,
  reconciliationReportExitCode,
} from './report.js';
import type { ReconciliationEvidenceKind } from './types.js';

const DESKTOP_RECOVERY_KINDS = new Set<ReconciliationEvidenceKind>([
  'desktop_absence_candidate',
  'disabled_window',
  'message_id_candidate',
  'retention_risk',
  'transport_id_discontinuity',
]);

export const RECONCILIATION_APPLY_UNAVAILABLE_ERROR_CODE = 'reconciliation_apply_unavailable';
export const RECONCILIATION_APPLY_UNAVAILABLE_ERROR_MESSAGE =
  'Reconciliation apply is unavailable in this runtime';

export interface ReconciliationCliInput {
  apply: boolean;
  channelIds: readonly bigint[];
  json: boolean;
  reason?: string;
}

export interface ReconciliationCliApplyInput {
  channelIds: readonly bigint[];
  initiatorId: null;
  initiatorKind: 'local_operator';
  reason: string;
}

export interface ReconciliationCliDependencies {
  apply?: (input: ReconciliationCliApplyInput) => Promise<ReconciliationReport>;
  scan?: (channelIds: readonly bigint[]) => Promise<ReconciliationReport>;
  write: (output: string) => void;
}

interface ReconciliationRecoveryGuidance {
  desktopExportRecommended: boolean;
  importArguments: string[] | null;
  steps: string[];
}

export async function runReconciliationCli(
  input: ReconciliationCliInput,
  dependencies: ReconciliationCliDependencies,
): Promise<0 | 1 | 2> {
  let report: ReconciliationReport;
  if (input.apply) {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 1 || reason.length > 500) {
      report = createFatalReconciliationReport(input.channelIds, 'apply', {
        code: 'invalid_apply_reason',
        message: 'Reconciliation --apply requires a reason containing between 1 and 500 characters',
      });
    } else if (!dependencies.apply) {
      report = createFatalReconciliationReport(input.channelIds, 'apply', {
        code: RECONCILIATION_APPLY_UNAVAILABLE_ERROR_CODE,
        message: RECONCILIATION_APPLY_UNAVAILABLE_ERROR_MESSAGE,
      });
    } else {
      try {
        report = await dependencies.apply({
          channelIds: input.channelIds,
          initiatorId: null,
          initiatorKind: 'local_operator',
          reason,
        });
      } catch {
        report = createFatalReconciliationReport(input.channelIds, 'apply', {
          code: 'reconciliation_apply_failed',
          message: 'The reconciliation apply could not be completed',
        });
      }
    }
  } else if (input.reason !== undefined) {
    report = createFatalReconciliationReport(input.channelIds, 'dry-run', {
      code: 'reason_without_apply',
      message: 'Reconciliation --reason requires --apply',
    });
  } else {
    if (!dependencies.scan) {
      throw new TypeError('A reconciliation dry-run scanner is required');
    }
    report = await dependencies.scan(input.channelIds);
  }

  dependencies.write(renderReconciliationReport(report, input.json));
  return reconciliationReportExitCode(report);
}

function createFatalReconciliationReport(
  channelIds: readonly bigint[],
  mode: 'apply' | 'dry-run',
  issue: { code: string; message: string },
): ReconciliationReport {
  const report = createReconciliationReport({
    channelIds: channelIds.map(String),
    mode,
  });
  addReconciliationReportIssue(report, {
    code: issue.code,
    sanitizedReason: issue.message,
  });
  return finishReconciliationReport(report, { fatal: true });
}

export function renderReconciliationReport(report: ReconciliationReport, json: boolean): string {
  const recoveryGuidance = createRecoveryGuidance(report);
  if (json) {
    return `${JSON.stringify({
      ...report,
      recoveryGuidance,
    })}\n`;
  }

  const lines = [
    `Telegram reconciliation ${report.mode === 'apply' ? 'APPLY' : 'DRY RUN'}: ${report.status.toUpperCase()}`,
    `Schema version: ${report.schemaVersion}`,
    `Selected channels: ${report.scope.channelIds.length}${report.scope.channelIdsTruncated ? '+' : ''}`,
    `Scanned: ${report.counts.scanned}`,
    `Findings: ${report.counts.findings}`,
    `Open: ${report.counts.open}`,
    `Warnings: ${report.counts.warnings}`,
    `Errors: ${report.counts.errors}`,
    `Item errors: ${report.counts.itemErrors}`,
  ];

  if (report.findings.length > 0) {
    lines.push('Findings (bounded):');
    for (const finding of report.findings) {
      const channel = finding.channelId === null ? 'global' : finding.channelId;
      const message = finding.messageId === undefined ? '' : ` message=${finding.messageId}`;
      const observation =
        finding.observationId === undefined ? '' : ` observation=${finding.observationId}`;
      lines.push(
        `- [${finding.severity}] ${finding.kind} channel=${channel}${message}${observation}: ${finding.sanitizedReason}`,
      );
    }
    if (report.findingsTruncated) {
      lines.push('- Additional findings were omitted from this bounded report.');
    }
  }

  if (report.issues.length > 0) {
    lines.push('Issues (bounded):');
    for (const issue of report.issues) {
      lines.push(`- ${issue.code}: ${issue.sanitizedReason}`);
    }
    if (report.issuesTruncated) {
      lines.push('- Additional issues were omitted from this bounded report.');
    }
  }

  if (recoveryGuidance.desktopExportRecommended) {
    lines.push(
      'Recovery guidance:',
      '1. Export the affected channel history with Telegram Desktop.',
      `2. Dry-run the bounded import: kodama ${recoveryGuidance.importArguments?.join(' ')}`,
      '3. Review the versioned import report before deciding whether to apply it.',
      '4. Rerun this reconciliation dry-run after any approved import.',
    );
  }

  return `${lines.join('\n')}\n`;
}

function createRecoveryGuidance(report: ReconciliationReport): ReconciliationRecoveryGuidance {
  const desktopExportRecommended = report.findings.some((finding) =>
    DESKTOP_RECOVERY_KINDS.has(finding.kind),
  );
  if (!desktopExportRecommended) {
    return {
      desktopExportRecommended: false,
      importArguments: null,
      steps: [],
    };
  }

  const affectedChannelIds = [
    ...new Set(
      report.findings.flatMap((finding) =>
        DESKTOP_RECOVERY_KINDS.has(finding.kind) && finding.channelId !== null
          ? [finding.channelId]
          : [],
      ),
    ),
  ];
  const channelIds = affectedChannelIds.length > 0 ? affectedChannelIds : report.scope.channelIds;
  const importArguments = [
    'import',
    'telegram-desktop',
    '--input',
    './result.json',
    ...channelIds.flatMap((channelId) => ['--channel', channelId]),
  ];

  return {
    desktopExportRecommended: true,
    importArguments,
    steps: [
      'Export the affected channel history with Telegram Desktop.',
      'Run the generated import command as a dry-run.',
      'Review the versioned import report before deciding whether to apply it.',
      'Rerun reconciliation after any approved import.',
    ],
  };
}
