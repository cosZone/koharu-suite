import { createHash } from 'node:crypto';
import type {
  ReconciliationEvidenceKind,
  ReconciliationFindingIdentity,
  ReconciliationFindingSeverity,
  ReconciliationFindingState,
  ReconciliationReportMode,
  ReconciliationReportStatus,
} from './types.js';
import { assertReconciliationFindingScope } from './types.js';

export const RECONCILIATION_REPORT_SCHEMA_VERSION = 1;
export const RECONCILIATION_FINDING_KEY_VERSION = 1;
export const RECONCILIATION_REPORT_FINDING_LIMIT = 20;
export const RECONCILIATION_REPORT_ISSUE_LIMIT = 20;
export const RECONCILIATION_REPORT_SCOPE_LIMIT = 100;
export const RECONCILIATION_REPORT_TEXT_LIMIT = 240;

const REDACTED = '[redacted]';
const POSIX_ABSOLUTE_PATH = /(^|[\s("'=])\/(?!\/)[^\s"',)]+/gu;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Z]:\\(?:[^\\\s]+\\)*[^\\\s"',)]*/giu;
const TELEGRAM_BOT_TOKEN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu;
const SENSITIVE_ASSIGNMENT =
  /["']?(desktop_source_path|file_id|file_unique_id|raw|source_locator|source_path|telegram_file_id|telegram_file_unique_id)["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/giu;

export interface ReconciliationFindingSample {
  channelId: string | null;
  evidenceVersion: number;
  kind: ReconciliationEvidenceKind;
  messageId?: string;
  observationId?: string;
  sanitizedReason: string;
  severity: ReconciliationFindingSeverity;
  stableKey: string;
  state: ReconciliationFindingState;
}

export interface ReconciliationReportIssue {
  code: string;
  sanitizedReason: string;
}

export interface ReconciliationReportCounts {
  errors: number;
  findings: number;
  ignored: number;
  itemErrors: number;
  open: number;
  repaired: number;
  resolved: number;
  scanned: number;
  warnings: number;
}

export interface ReconciliationReport {
  completedAt: string | null;
  counts: ReconciliationReportCounts;
  findings: ReconciliationFindingSample[];
  findingsTruncated: boolean;
  issues: ReconciliationReportIssue[];
  issuesTruncated: boolean;
  mode: ReconciliationReportMode;
  schemaVersion: number;
  scope: {
    channelIds: string[];
    channelIdsTruncated: boolean;
  };
  startedAt: string;
  status: ReconciliationReportStatus;
}

export interface ReconciliationFindingReportInput {
  channelId: string | null;
  evidenceVersion: number;
  kind: ReconciliationEvidenceKind;
  messageId?: string;
  observationId?: string;
  sanitizedReason: string;
  severity: ReconciliationFindingSeverity;
  stableKey: string;
  state: ReconciliationFindingState;
}

export function createReconciliationReport(input: {
  channelIds: readonly string[];
  mode: ReconciliationReportMode;
  scanned?: number;
  startedAt?: Date;
}): ReconciliationReport {
  const channelIds = [...new Set(input.channelIds)].sort(compareIds);
  return {
    completedAt: null,
    counts: {
      errors: 0,
      findings: 0,
      ignored: 0,
      itemErrors: 0,
      open: 0,
      repaired: 0,
      resolved: 0,
      scanned: input.scanned ?? 0,
      warnings: 0,
    },
    findings: [],
    findingsTruncated: false,
    issues: [],
    issuesTruncated: false,
    mode: input.mode,
    schemaVersion: RECONCILIATION_REPORT_SCHEMA_VERSION,
    scope: {
      channelIds: channelIds.slice(0, RECONCILIATION_REPORT_SCOPE_LIMIT),
      channelIdsTruncated: channelIds.length > RECONCILIATION_REPORT_SCOPE_LIMIT,
    },
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    status: 'clean',
  };
}

export function addReconciliationFinding(
  report: ReconciliationReport,
  finding: ReconciliationFindingReportInput,
): void {
  assertReconciliationFindingScope(finding.kind, finding.channelId);
  report.counts.findings += 1;
  report.counts[finding.state] += 1;
  report.counts[finding.severity === 'error' ? 'errors' : 'warnings'] += 1;

  if (report.findings.length >= RECONCILIATION_REPORT_FINDING_LIMIT) {
    report.findingsTruncated = true;
    return;
  }

  report.findings.push({
    channelId: finding.channelId,
    evidenceVersion: finding.evidenceVersion,
    kind: finding.kind,
    ...(finding.messageId === undefined ? {} : { messageId: finding.messageId }),
    ...(finding.observationId === undefined ? {} : { observationId: finding.observationId }),
    sanitizedReason: sanitizeReconciliationReportText(finding.sanitizedReason),
    severity: finding.severity,
    stableKey: finding.stableKey,
    state: finding.state,
  });
}

export function addReconciliationReportIssue(
  report: ReconciliationReport,
  issue: ReconciliationReportIssue,
): void {
  report.counts.itemErrors += 1;
  if (report.issues.length >= RECONCILIATION_REPORT_ISSUE_LIMIT) {
    report.issuesTruncated = true;
    return;
  }

  report.issues.push({
    code: issue.code,
    sanitizedReason: sanitizeReconciliationReportText(issue.sanitizedReason),
  });
}

export function finishReconciliationReport(
  report: ReconciliationReport,
  input: {
    completedAt?: Date;
    interrupted?: boolean;
    repaired?: number;
    fatal?: boolean;
  } = {},
): ReconciliationReport {
  report.completedAt = (input.completedAt ?? new Date()).toISOString();
  report.counts.repaired = input.repaired ?? report.counts.repaired;

  if (input.fatal) {
    report.status = 'fatal';
  } else if (input.interrupted) {
    report.status = 'interrupted';
  } else if (report.counts.open > 0 || report.counts.itemErrors > 0) {
    report.status = 'partial';
  } else if (report.counts.repaired > 0) {
    report.status = 'repaired';
  } else {
    report.status = 'clean';
  }

  return report;
}

export function reconciliationReportExitCode(report: ReconciliationReport): 0 | 1 | 2 {
  if (report.status === 'fatal' || report.status === 'interrupted') {
    return 1;
  }
  return report.status === 'partial' ? 2 : 0;
}

export function createReconciliationFindingKey(identity: ReconciliationFindingIdentity): string {
  assertReconciliationFindingScope(identity.kind, identity.channelId);
  if (identity.channelId !== null) {
    assertFindingKeyPart('channelId', identity.channelId);
  }
  assertOptionalFindingKeyPart('messageId', identity.messageId);
  assertOptionalFindingKeyPart('observationId', identity.observationId);
  assertOptionalFindingKeyPart('rangeStart', identity.rangeStart);
  assertOptionalFindingKeyPart('rangeEnd', identity.rangeEnd);
  for (const evidenceId of identity.evidenceIds ?? []) {
    assertFindingKeyPart('evidenceId', evidenceId);
  }

  const payload = [
    identity.kind,
    identity.channelId === null ? 'scope:global' : `scope:channel:${identity.channelId}`,
    identity.messageId ?? '',
    identity.observationId ?? '',
    identity.rangeStart ?? '',
    identity.rangeEnd ?? '',
    ...[...new Set(identity.evidenceIds ?? [])].sort(compareIds),
  ];
  const hash = createHash('sha256');
  for (const part of payload) {
    hash.update(String(Buffer.byteLength(part)));
    hash.update(':');
    hash.update(part);
    hash.update(';');
  }
  return `reconciliation:v${RECONCILIATION_FINDING_KEY_VERSION}:${hash.digest('hex')}`;
}

export function sanitizeReconciliationReportText(value: string): string {
  const sanitized = value
    .replace(TELEGRAM_BOT_TOKEN, REDACTED)
    .replace(SENSITIVE_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(POSIX_ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(WINDOWS_ABSOLUTE_PATH, REDACTED)
    .replaceAll(/\s+/gu, ' ')
    .trim();

  if (sanitized.length <= RECONCILIATION_REPORT_TEXT_LIMIT) {
    return sanitized;
  }
  return `${sanitized.slice(0, RECONCILIATION_REPORT_TEXT_LIMIT - 1)}…`;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertFindingKeyPart(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function assertOptionalFindingKeyPart(label: string, value: string | undefined): void {
  if (value !== undefined) {
    assertFindingKeyPart(label, value);
  }
}
