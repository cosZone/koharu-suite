import { z } from 'zod';
import { canonicalizeArchiveEntryPath } from './entry-policy.js';
import {
  ARCHIVE_FORMAT_VERSION,
  canonicalUtcTimestampSchema,
  safeByteLengthDecimalSchema,
  sha256HexSchema,
  suiteVersionHintSchema,
  telegramChatIdSchema,
  telegramMessageIdSchema,
} from './schemas.js';

export const ARCHIVE_REPORT_SCHEMA_VERSION = 1;
export const ARCHIVE_REPORT_ISSUE_LIMIT = 20;

const sanitizedTokenSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,127}$/u, 'Expected a sanitized machine-readable token');

function isCanonicalReportPath(value: string): boolean {
  try {
    return canonicalizeArchiveEntryPath(value) === value;
  } catch {
    return false;
  }
}

export const archiveReportIssueSchema = z.strictObject({
  code: sanitizedTokenSchema,
  sanitizedReason: sanitizedTokenSchema,
  severity: z.enum(['error', 'warning']),
  archivePath: z
    .string()
    .refine(isCanonicalReportPath, 'Expected a canonical archive path')
    .optional(),
  line: z.number().int().positive().safe().optional(),
  byteOffset: z.number().int().nonnegative().safe().optional(),
  telegramChatId: telegramChatIdSchema.optional(),
  telegramMessageId: telegramMessageIdSchema.optional(),
  revisionNumber: z.number().int().positive().safe().optional(),
});

export const archiveReportCountsSchema = z.strictObject({
  channels: z.number().int().nonnegative().safe(),
  messages: z.number().int().nonnegative().safe(),
  visibleMessages: z.number().int().nonnegative().safe(),
  hiddenMessages: z.number().int().nonnegative().safe(),
  revisions: z.number().int().nonnegative().safe(),
  revisionMedia: z.number().int().nonnegative().safe(),
  provenanceRecords: z.number().int().nonnegative().safe(),
  blobs: z.number().int().nonnegative().safe(),
  mediaPresent: z.number().int().nonnegative().safe(),
  mediaMissing: z.number().int().nonnegative().safe(),
  created: z.number().int().nonnegative().safe(),
  matched: z.number().int().nonnegative().safe(),
  stale: z.number().int().nonnegative().safe(),
  conflicts: z.number().int().nonnegative().safe(),
  regenerated: z.number().int().nonnegative().safe(),
  warnings: z.number().int().nonnegative().safe(),
  errors: z.number().int().nonnegative().safe(),
});

export const archiveReportSchema = z
  .strictObject({
    schemaVersion: z.literal(ARCHIVE_REPORT_SCHEMA_VERSION),
    // Reports describe the observed archive envelope, including unsupported
    // pre-v1 version zero. Supported manifests remain strictly v1.
    formatVersion: z.number().int().nonnegative().safe(),
    mode: z.enum(['apply', 'dry-run', 'inspect']),
    status: z.enum(['clean', 'fatal', 'partial']),
    startedAt: canonicalUtcTimestampSchema,
    completedAt: canonicalUtcTimestampSchema.nullable(),
    artifactSha256: sha256HexSchema.nullable(),
    artifactByteLength: safeByteLengthDecimalSchema.nullable(),
    minimumSuiteVersion: suiteVersionHintSchema.nullable(),
    counts: archiveReportCountsSchema,
    issues: z.array(archiveReportIssueSchema).max(ARCHIVE_REPORT_ISSUE_LIMIT),
  })
  .superRefine((report, context) => {
    const sampledErrors = report.issues.filter((issue) => issue.severity === 'error').length;
    const sampledWarnings = report.issues.length - sampledErrors;
    const hasFailure = report.counts.errors > 0 || report.counts.conflicts > 0;
    if (sampledErrors > report.counts.errors || sampledWarnings > report.counts.warnings) {
      context.addIssue({
        code: 'custom',
        message: 'Sampled issue counts exceed report totals',
        path: ['issues'],
      });
    }
    if (report.status === 'clean' && hasFailure) {
      context.addIssue({
        code: 'custom',
        message: 'Clean reports cannot contain failures',
        path: ['status'],
      });
    }
    if (report.status === 'partial' && !hasFailure) {
      context.addIssue({
        code: 'custom',
        message: 'Partial reports require an error or conflict',
        path: ['status'],
      });
    }
    if (report.status === 'fatal' && report.counts.errors === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Fatal reports require an error',
        path: ['status'],
      });
    }
    if (
      report.completedAt !== null &&
      Date.parse(report.completedAt) < Date.parse(report.startedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Report completion cannot precede its start',
        path: ['completedAt'],
      });
    }
  });

export type ArchiveReportIssue = z.infer<typeof archiveReportIssueSchema>;
export type ArchiveReportCounts = z.infer<typeof archiveReportCountsSchema>;
export type ArchiveReport = z.infer<typeof archiveReportSchema>;
export type ArchiveReportMode = ArchiveReport['mode'];
export type ArchiveReportStatus = ArchiveReport['status'];

function emptyArchiveReportCounts(): ArchiveReportCounts {
  return {
    blobs: 0,
    channels: 0,
    conflicts: 0,
    created: 0,
    errors: 0,
    hiddenMessages: 0,
    matched: 0,
    mediaMissing: 0,
    mediaPresent: 0,
    messages: 0,
    provenanceRecords: 0,
    regenerated: 0,
    revisionMedia: 0,
    revisions: 0,
    stale: 0,
    visibleMessages: 0,
    warnings: 0,
  };
}

export function createArchiveReport(input: {
  artifactByteLength?: string | null;
  artifactSha256?: string | null;
  formatVersion?: number;
  mode: ArchiveReportMode;
  minimumSuiteVersion?: string | null;
  startedAt?: Date;
}): ArchiveReport {
  return archiveReportSchema.parse({
    artifactByteLength: input.artifactByteLength ?? null,
    artifactSha256: input.artifactSha256 ?? null,
    completedAt: null,
    counts: emptyArchiveReportCounts(),
    formatVersion: input.formatVersion ?? ARCHIVE_FORMAT_VERSION,
    issues: [],
    minimumSuiteVersion: input.minimumSuiteVersion ?? null,
    mode: input.mode,
    schemaVersion: ARCHIVE_REPORT_SCHEMA_VERSION,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    status: 'clean',
  });
}

export function addArchiveReportIssue(report: ArchiveReport, issue: ArchiveReportIssue): void {
  const validatedIssue = archiveReportIssueSchema.parse(issue);
  if (validatedIssue.severity === 'error') {
    report.counts.errors += 1;
    if (report.status !== 'fatal') report.status = 'partial';
  } else {
    report.counts.warnings += 1;
  }

  if (report.issues.length < ARCHIVE_REPORT_ISSUE_LIMIT) {
    report.issues.push(validatedIssue);
  }
}

export function markArchiveReportFatal(report: ArchiveReport, issue: ArchiveReportIssue): void {
  const validatedIssue = archiveReportIssueSchema.parse({ ...issue, severity: 'error' });
  report.counts.errors += 1;
  report.status = 'fatal';
  if (report.issues.length < ARCHIVE_REPORT_ISSUE_LIMIT) {
    report.issues.push(validatedIssue);
  }
}

export function finishArchiveReport(
  report: ArchiveReport,
  completedAt = new Date(),
): ArchiveReport {
  report.completedAt = completedAt.toISOString();
  if (report.status !== 'fatal' && (report.counts.conflicts > 0 || report.counts.errors > 0)) {
    report.status = 'partial';
  }
  return archiveReportSchema.parse(report);
}

export function archiveReportExitCode(report: ArchiveReport): 0 | 1 | 2 {
  if (report.status === 'fatal') return 1;
  return report.status === 'partial' ? 2 : 0;
}
