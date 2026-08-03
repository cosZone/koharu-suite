import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_REPORT_ISSUE_LIMIT,
  addArchiveReportIssue,
  archiveReportExitCode,
  archiveReportSchema,
  createArchiveReport,
  finishArchiveReport,
  markArchiveReportFatal,
} from '../src/report.js';

const HASH = 'a'.repeat(64);

describe('archive reports', () => {
  it('creates and finishes a versioned strict report', () => {
    const report = createArchiveReport({
      artifactByteLength: '42',
      artifactSha256: HASH,
      mode: 'inspect',
      minimumSuiteVersion: '0.9.0-beta.1',
      startedAt: new Date('2026-08-03T00:00:00.000Z'),
    });
    finishArchiveReport(report, new Date('2026-08-03T00:01:00.000Z'));

    expect(archiveReportSchema.parse(report)).toMatchObject({
      artifactByteLength: '42',
      artifactSha256: HASH,
      completedAt: '2026-08-03T00:01:00.000Z',
      formatVersion: 1,
      mode: 'inspect',
      minimumSuiteVersion: '0.9.0-beta.1',
      schemaVersion: 1,
      status: 'clean',
    });
    expect(archiveReportExitCode(report)).toBe(0);
  });

  it('retains complete counts while bounding sanitized issue samples', () => {
    const report = createArchiveReport({ mode: 'dry-run' });
    for (let index = 0; index < ARCHIVE_REPORT_ISSUE_LIMIT + 5; index += 1) {
      addArchiveReportIssue(report, {
        code: 'invalid_record',
        sanitizedReason: 'schema_mismatch',
        severity: 'error',
        archivePath: 'data/messages/000000.jsonl',
        byteOffset: index,
        line: index + 1,
      });
    }

    expect(report.counts.errors).toBe(ARCHIVE_REPORT_ISSUE_LIMIT + 5);
    expect(report.issues).toHaveLength(ARCHIVE_REPORT_ISSUE_LIMIT);
    expect(report.status).toBe('partial');
    expect(archiveReportExitCode(report)).toBe(2);
  });

  it('rejects unsanitized reasons and host paths without echoing content', () => {
    const report = createArchiveReport({ mode: 'apply' });
    try {
      addArchiveReportIssue(report, {
        code: 'invalid_record',
        sanitizedReason: 'private message contents',
        severity: 'error',
        archivePath: '/Users/owner/private-export.json',
      });
      throw new Error('Expected issue validation to fail');
    } catch (error) {
      expect((error as Error).message).not.toContain('/Users/owner/private-export.json');
      expect((error as Error).message).not.toContain('private message contents');
    }
    expect(report.counts.errors).toBe(0);
  });

  it('marks fatal failures distinctly with deterministic exit status', () => {
    const report = createArchiveReport({ mode: 'inspect' });
    markArchiveReportFatal(report, {
      code: 'checksum_mismatch',
      sanitizedReason: 'digest_mismatch',
      severity: 'warning',
    });
    expect(report.status).toBe('fatal');
    expect(report.counts.errors).toBe(1);
    expect(report.issues[0]?.severity).toBe('error');
    expect(archiveReportExitCode(report)).toBe(1);
  });

  it('rejects impossible status/count and timestamp combinations', () => {
    const cleanWithConflict = createArchiveReport({ mode: 'inspect' });
    cleanWithConflict.counts.conflicts = 1;
    expect(archiveReportSchema.safeParse(cleanWithConflict).success).toBe(false);

    const fatalWithoutError = createArchiveReport({ mode: 'inspect' });
    fatalWithoutError.status = 'fatal';
    expect(archiveReportSchema.safeParse(fatalWithoutError).success).toBe(false);

    const completedBeforeStart = createArchiveReport({
      mode: 'inspect',
      startedAt: new Date('2026-08-03T00:01:00.000Z'),
    });
    completedBeforeStart.completedAt = '2026-08-03T00:00:00.000Z';
    expect(archiveReportSchema.safeParse(completedBeforeStart).success).toBe(false);

    const uncountedIssue = createArchiveReport({ mode: 'inspect' });
    uncountedIssue.issues.push({
      code: 'checksum_mismatch',
      sanitizedReason: 'digest_mismatch',
      severity: 'warning',
    });
    expect(archiveReportSchema.safeParse(uncountedIssue).success).toBe(false);
  });
});
