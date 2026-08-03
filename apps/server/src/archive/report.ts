import {
  type ArchiveReport,
  createArchiveReport,
  finishArchiveReport,
  markArchiveReportFatal,
} from '@koharu-suite/archive-format';
import { z } from 'zod';

export const ARCHIVE_ARTIFACT_ERROR_CODES = [
  'archive_aborted',
  'artifact_not_written',
  'artifact_validation_failed',
  'artifact_write_failed',
  'finalization_durability_unknown',
  'finalization_failed',
  'input_changed',
  'input_not_regular',
  'input_unavailable',
  'output_exists',
  'output_invalid',
  'output_not_regular',
  'output_parent_unavailable',
  'output_parent_untrusted',
] as const;

export const archiveArtifactErrorCodeSchema = z.enum(ARCHIVE_ARTIFACT_ERROR_CODES);
export type ArchiveArtifactErrorCode = z.infer<typeof archiveArtifactErrorCodeSchema>;

/**
 * A stable failure boundary for archive filesystem operations.
 *
 * Messages and enumerable fields intentionally contain neither host paths nor
 * underlying OS errors. The optional cause is retained only for in-process
 * diagnostics and must never be serialized into CLI reports.
 */
export class ArchiveArtifactError extends Error {
  readonly artifactPublished: boolean;
  readonly code: ArchiveArtifactErrorCode;
  readonly validationReport: ArchiveReport | null;

  constructor(
    code: ArchiveArtifactErrorCode,
    options: ErrorOptions & {
      artifactPublished?: boolean;
      validationReport?: ArchiveReport | null;
    } = {},
  ) {
    super(`Archive artifact operation failed: ${code}`, { cause: options.cause });
    this.name = 'ArchiveArtifactError';
    this.code = archiveArtifactErrorCodeSchema.parse(code);
    this.artifactPublished = options.artifactPublished ?? false;
    this.validationReport = options.validationReport ?? null;
  }
}

export function createFatalArchiveInspectReport(
  reason: ArchiveArtifactErrorCode,
  startedAt = new Date(),
  completedAt = new Date(),
): ArchiveReport {
  const report = createArchiveReport({ mode: 'inspect', startedAt });
  markArchiveReportFatal(report, {
    code: 'archive_inspect',
    sanitizedReason: archiveArtifactErrorCodeSchema.parse(reason),
    severity: 'error',
  });
  return finishArchiveReport(report, completedAt);
}

export function archiveArtifactReason(
  error: unknown,
  fallback: ArchiveArtifactErrorCode,
  signal?: AbortSignal,
): ArchiveArtifactErrorCode {
  if (signal?.aborted) return 'archive_aborted';
  return error instanceof ArchiveArtifactError ? error.code : fallback;
}

export function renderArchiveReportText(report: ArchiveReport): string {
  const lines = [
    `Portable archive ${report.mode.toUpperCase()}: ${report.status.toUpperCase()}`,
    `Format: v${report.formatVersion}`,
    `SHA-256: ${report.artifactSha256 ?? '-'}`,
    `Bytes: ${report.artifactByteLength ?? '-'}`,
    `Channels: ${report.counts.channels}`,
    `Messages: ${report.counts.messages} (${report.counts.visibleMessages} public, ${report.counts.hiddenMessages} hidden)`,
    `Revisions: ${report.counts.revisions}`,
    `Revision media: ${report.counts.revisionMedia}`,
    `Provenance records: ${report.counts.provenanceRecords}`,
    `Media: ${report.counts.mediaPresent} present, ${report.counts.mediaMissing} missing`,
    `Issues: ${report.counts.warnings} warning(s), ${report.counts.errors} error(s)`,
  ];
  for (const issue of report.issues) {
    lines.push(
      `- [${issue.severity}] ${issue.code}: ${issue.sanitizedReason}${
        issue.archivePath === undefined ? '' : ` (${issue.archivePath})`
      }`,
    );
  }
  return lines.join('\n');
}
