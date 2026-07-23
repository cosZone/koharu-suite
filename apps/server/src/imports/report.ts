import { TELEGRAM_DESKTOP_PARSER_VERSION } from './telegram-desktop-normalize.js';

export const TELEGRAM_DESKTOP_REPORT_SCHEMA_VERSION = 1;
export const IMPORT_REPORT_ISSUE_LIMIT = 20;

export type TelegramDesktopImportMode = 'apply' | 'dry-run';
export type TelegramDesktopImportStatus = 'clean' | 'fatal' | 'partial';
export type TelegramDesktopIssueSeverity = 'error' | 'warning';

export interface TelegramDesktopImportIssue {
  code: string;
  sanitizedReason: string;
  severity: TelegramDesktopIssueSeverity;
  sourceChatId: string;
  sourceMessageId?: string;
}

export interface TelegramDesktopImportCounts {
  conflicts: number;
  createdMessages: number;
  createdRevisions: number;
  eligible: number;
  itemErrors: number;
  matchedExisting: number;
  mediaMetadata: number;
  scanned: number;
  skippedService: number;
  skippedUnsupported: number;
  stale: number;
  warnings: number;
}

export interface TelegramDesktopImportChat {
  canonicalChannelId: string;
  name: string;
  source: 'chats' | 'left_chats' | 'root';
  sourceChatId: string;
}

export interface TelegramDesktopImportReport {
  completedAt: string | null;
  counts: TelegramDesktopImportCounts;
  fileSha256: string;
  issues: TelegramDesktopImportIssue[];
  mode: TelegramDesktopImportMode;
  parserVersion: number;
  runId?: string;
  schemaVersion: number;
  selectedChats: TelegramDesktopImportChat[];
  startedAt: string;
  status: TelegramDesktopImportStatus;
}

export function createTelegramDesktopImportReport(input: {
  fileSha256: string;
  mode: TelegramDesktopImportMode;
  selectedChats: TelegramDesktopImportChat[];
  startedAt?: Date;
}): TelegramDesktopImportReport {
  return {
    completedAt: null,
    counts: {
      conflicts: 0,
      createdMessages: 0,
      createdRevisions: 0,
      eligible: 0,
      itemErrors: 0,
      matchedExisting: 0,
      mediaMetadata: 0,
      scanned: 0,
      skippedService: 0,
      skippedUnsupported: 0,
      stale: 0,
      warnings: 0,
    },
    fileSha256: input.fileSha256,
    issues: [],
    mode: input.mode,
    parserVersion: TELEGRAM_DESKTOP_PARSER_VERSION,
    schemaVersion: TELEGRAM_DESKTOP_REPORT_SCHEMA_VERSION,
    selectedChats: input.selectedChats,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    status: 'clean',
  };
}

export function addTelegramDesktopImportIssue(
  report: TelegramDesktopImportReport,
  issue: TelegramDesktopImportIssue,
): void {
  if (issue.severity === 'error') {
    report.counts.itemErrors += 1;
    report.status = 'partial';
  } else {
    report.counts.warnings += 1;
  }

  sampleTelegramDesktopImportIssue(report, issue);
}

export function sampleTelegramDesktopImportIssue(
  report: TelegramDesktopImportReport,
  issue: TelegramDesktopImportIssue,
): void {
  if (report.issues.length < IMPORT_REPORT_ISSUE_LIMIT) {
    report.issues.push(issue);
  }
}

export function finishTelegramDesktopImportReport(
  report: TelegramDesktopImportReport,
  completedAt = new Date(),
): TelegramDesktopImportReport {
  report.completedAt = completedAt.toISOString();
  if (report.status !== 'fatal' && (report.counts.conflicts > 0 || report.counts.itemErrors > 0)) {
    report.status = 'partial';
  }
  return report;
}

export function telegramDesktopImportExitCode(report: TelegramDesktopImportReport): 0 | 1 | 2 {
  if (report.status === 'fatal') {
    return 1;
  }
  return report.status === 'partial' ? 2 : 0;
}

export function renderTelegramDesktopImportReport(
  report: TelegramDesktopImportReport,
  json: boolean,
): string {
  if (json) {
    return `${JSON.stringify(report)}\n`;
  }

  const mode = report.mode === 'apply' ? 'APPLY' : 'DRY RUN';
  const status = report.status.toUpperCase();
  const lines = [
    `Telegram Desktop import ${mode}: ${status}`,
    `File SHA-256: ${report.fileSha256}`,
    `Selected channels: ${report.selectedChats.length}`,
    `Scanned: ${report.counts.scanned}`,
    `Eligible: ${report.counts.eligible}`,
    `Created messages: ${report.counts.createdMessages}`,
    `Created revisions: ${report.counts.createdRevisions}`,
    `Matched existing: ${report.counts.matchedExisting}`,
    `Stale: ${report.counts.stale}`,
    `Conflicts: ${report.counts.conflicts}`,
    `Skipped service: ${report.counts.skippedService}`,
    `Skipped unsupported: ${report.counts.skippedUnsupported}`,
    `Warnings: ${report.counts.warnings}`,
    `Item errors: ${report.counts.itemErrors}`,
    `Media metadata: ${report.counts.mediaMetadata}`,
  ];

  if (report.runId) {
    lines.splice(2, 0, `Run ID: ${report.runId}`);
  }
  if (report.issues.length > 0) {
    lines.push('Issues (bounded):');
    for (const issue of report.issues) {
      const messageId = issue.sourceMessageId ? ` message=${issue.sourceMessageId}` : '';
      lines.push(
        `- [${issue.severity}] ${issue.code} channel=${issue.sourceChatId}${messageId}: ${issue.sanitizedReason}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}
