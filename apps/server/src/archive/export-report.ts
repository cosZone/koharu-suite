import {
  ARCHIVE_FORMAT_VERSION,
  type ArchiveManifest,
  archiveManifestCountsSchema,
  archiveSelectionSchema,
  canonicalUtcTimestampSchema,
  safeByteLengthDecimalSchema,
  sha256HexSchema,
} from '@koharu-suite/archive-format';
import { z } from 'zod';

export const ARCHIVE_EXPORT_REPORT_SCHEMA_VERSION = 1;

const issueCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,127}$/u, 'Expected a sanitized archive export issue code');

export const archiveExportReportSchema = z.strictObject({
  artifactByteLength: safeByteLengthDecimalSchema.nullable(),
  artifactPublished: z.boolean(),
  artifactSha256: sha256HexSchema.nullable(),
  completedAt: canonicalUtcTimestampSchema,
  counts: archiveManifestCountsSchema,
  formatVersion: z.literal(ARCHIVE_FORMAT_VERSION),
  includeProvenance: z.boolean(),
  issues: z
    .array(
      z.strictObject({
        code: issueCodeSchema,
        severity: z.enum(['error', 'warning']),
      }),
    )
    .max(20),
  schemaVersion: z.literal(ARCHIVE_EXPORT_REPORT_SCHEMA_VERSION),
  selection: archiveSelectionSchema,
  snapshotAt: canonicalUtcTimestampSchema.nullable(),
  startedAt: canonicalUtcTimestampSchema,
  status: z.enum(['clean', 'fatal', 'interrupted']),
});

export type ArchiveExportReport = z.infer<typeof archiveExportReportSchema>;

export class ArchiveExportError extends Error {
  constructor(
    readonly code: string,
    readonly report: ArchiveExportReport,
    options: ErrorOptions = {},
  ) {
    super(`Archive export failed: ${issueCodeSchema.parse(code)}`, options);
    this.name = 'ArchiveExportError';
  }
}

function emptyCounts(): ArchiveManifest['counts'] {
  return {
    blobs: 0,
    channels: 0,
    hiddenMessages: 0,
    messages: 0,
    provenanceMedia: 0,
    provenanceObservations: 0,
    revisionMedia: 0,
    revisions: 0,
    visibleMessages: 0,
  };
}

export function createFatalArchiveExportReport(input: {
  artifactPublished?: boolean;
  code: string;
  counts?: ArchiveManifest['counts'];
  includeProvenance: boolean;
  selection: ArchiveManifest['selection'];
  snapshotAt?: string | null;
  startedAt: Date;
  status?: 'fatal' | 'interrupted';
}): ArchiveExportReport {
  return archiveExportReportSchema.parse({
    artifactByteLength: null,
    artifactPublished: input.artifactPublished ?? false,
    artifactSha256: null,
    completedAt: new Date().toISOString(),
    counts: input.counts ?? emptyCounts(),
    formatVersion: ARCHIVE_FORMAT_VERSION,
    includeProvenance: input.includeProvenance,
    issues: [{ code: issueCodeSchema.parse(input.code), severity: 'error' }],
    schemaVersion: ARCHIVE_EXPORT_REPORT_SCHEMA_VERSION,
    selection: input.selection,
    snapshotAt: input.snapshotAt ?? null,
    startedAt: input.startedAt.toISOString(),
    status: input.status ?? 'fatal',
  });
}

export function createCleanArchiveExportReport(input: {
  artifactByteLength: string;
  artifactSha256: string;
  counts: ArchiveManifest['counts'];
  includeProvenance: boolean;
  selection: ArchiveManifest['selection'];
  snapshotAt: string;
  startedAt: Date;
}): ArchiveExportReport {
  return archiveExportReportSchema.parse({
    artifactByteLength: input.artifactByteLength,
    artifactPublished: true,
    artifactSha256: input.artifactSha256,
    completedAt: new Date().toISOString(),
    counts: input.counts,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    includeProvenance: input.includeProvenance,
    issues: [],
    schemaVersion: ARCHIVE_EXPORT_REPORT_SCHEMA_VERSION,
    selection: input.selection,
    snapshotAt: input.snapshotAt,
    startedAt: input.startedAt.toISOString(),
    status: 'clean',
  });
}

export function archiveExportReportExitCode(report: ArchiveExportReport): 0 | 1 {
  return report.status === 'clean' ? 0 : 1;
}

export function renderArchiveExportReportText(report: ArchiveExportReport): string {
  const lines = [
    `Portable archive EXPORT: ${report.status.toUpperCase()}`,
    `Format: v${report.formatVersion}`,
    `Published: ${report.artifactPublished ? 'yes' : 'no'}`,
    `SHA-256: ${report.artifactSha256 ?? '-'}`,
    `Bytes: ${report.artifactByteLength ?? '-'}`,
    `Channels: ${report.counts.channels}`,
    `Messages: ${report.counts.messages} (${report.counts.visibleMessages} public, ${report.counts.hiddenMessages} hidden)`,
    `Revisions: ${report.counts.revisions}`,
    `Revision media: ${report.counts.revisionMedia}`,
    `Provenance records: ${report.counts.provenanceObservations + report.counts.provenanceMedia}`,
  ];
  for (const issue of report.issues) lines.push(`- [${issue.severity}] ${issue.code}`);
  return `${lines.join('\n')}\n`;
}
