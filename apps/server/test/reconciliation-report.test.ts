import { describe, expect, it } from 'vitest';
import {
  addReconciliationFinding,
  addReconciliationReportIssue,
  createReconciliationFindingKey,
  createReconciliationReport,
  finishReconciliationReport,
  RECONCILIATION_FINDING_KEY_VERSION,
  RECONCILIATION_REPORT_FINDING_LIMIT,
  RECONCILIATION_REPORT_ISSUE_LIMIT,
  RECONCILIATION_REPORT_SCHEMA_VERSION,
  RECONCILIATION_REPORT_SCOPE_LIMIT,
  reconciliationReportExitCode,
} from '../src/reconciliation/report.js';
import {
  RECONCILIATION_EVIDENCE_CONFIDENCE,
  RECONCILIATION_EVIDENCE_KINDS,
  reconciliationFindingState,
} from '../src/reconciliation/types.js';

function finding(index: number, state: 'ignored' | 'open' | 'resolved' = 'open') {
  return {
    channelId: '-1002234260754',
    evidenceVersion: 1,
    kind: 'message_id_candidate' as const,
    messageId: String(index),
    sanitizedReason: `Message range ${index} needs review`,
    severity: 'warning' as const,
    stableKey: createReconciliationFindingKey({
      channelId: '-1002234260754',
      kind: 'message_id_candidate',
      messageId: String(index),
    }),
    state,
  };
}

describe('reconciliation evidence contracts', () => {
  it('defines confidence for every evidence kind without attaching an action policy', () => {
    expect(Object.keys(RECONCILIATION_EVIDENCE_CONFIDENCE).sort()).toEqual(
      [...RECONCILIATION_EVIDENCE_KINDS].sort(),
    );
    expect(RECONCILIATION_EVIDENCE_CONFIDENCE.transport_id_discontinuity).toBe('weak_signal');
    expect(RECONCILIATION_EVIDENCE_CONFIDENCE.desktop_absence_candidate).toBe('weak_signal');
    expect(RECONCILIATION_EVIDENCE_CONFIDENCE.observation_conflict).toBe('certain_difference');
  });

  it('creates a stable opaque key and separates evidence instances unambiguously', () => {
    const identity = {
      channelId: '-1002234260754',
      evidenceIds: ['12', '34'],
      kind: 'message_id_candidate' as const,
      rangeEnd: '34',
      rangeStart: '12',
    };

    const key = createReconciliationFindingKey(identity);
    expect(createReconciliationFindingKey(identity)).toBe(key);
    expect(key).toMatch(
      new RegExp(`^reconciliation:v${RECONCILIATION_FINDING_KEY_VERSION}:[a-f0-9]{64}$`, 'u'),
    );
    expect(key).not.toContain(identity.channelId);
    expect(
      createReconciliationFindingKey({
        ...identity,
        evidenceIds: ['34', '12', '34'],
      }),
    ).toBe(key);
    expect(
      createReconciliationFindingKey({
        ...identity,
        evidenceIds: ['1', '234'],
      }),
    ).not.toBe(key);
    expect(() =>
      createReconciliationFindingKey({
        channelId: ' ',
        kind: 'durable_pending',
      }),
    ).toThrow('channelId must not be empty');

    const globalKey = createReconciliationFindingKey({
      channelId: null,
      evidenceIds: ['101', '105'],
      kind: 'transport_id_discontinuity',
    });
    expect(globalKey).toMatch(/^reconciliation:v1:[a-f0-9]{64}$/u);
    expect(() =>
      createReconciliationFindingKey({
        channelId: '\u0000global',
        evidenceIds: ['101', '105'],
        kind: 'transport_id_discontinuity',
      }),
    ).toThrow('must use a global null channel scope');
  });

  it('preserves owner state for the same evidence version and reopens only newer evidence', () => {
    expect(reconciliationFindingState(undefined, 1)).toBe('open');
    expect(reconciliationFindingState({ evidenceVersion: 3, state: 'ignored' }, 3)).toBe('ignored');
    expect(reconciliationFindingState({ evidenceVersion: 3, state: 'resolved' }, 4)).toBe('open');
    expect(() => reconciliationFindingState({ evidenceVersion: 3, state: 'resolved' }, 2)).toThrow(
      'cannot move backwards',
    );
  });
});

describe('reconciliation report', () => {
  it('is versioned, bounded, and keeps complete finding counts', () => {
    const report = createReconciliationReport({
      channelIds: ['-1002', '-1001', '-1002'],
      mode: 'dry-run',
      scanned: 50,
      startedAt: new Date('2026-07-24T00:00:00.000Z'),
    });
    for (let index = 0; index < RECONCILIATION_REPORT_FINDING_LIMIT + 5; index += 1) {
      addReconciliationFinding(report, finding(index));
    }
    finishReconciliationReport(report, {
      completedAt: new Date('2026-07-24T00:01:00.000Z'),
    });

    expect(report.schemaVersion).toBe(RECONCILIATION_REPORT_SCHEMA_VERSION);
    expect(report.scope.channelIds).toEqual(['-1001', '-1002']);
    expect(report.scope.channelIdsTruncated).toBe(false);
    expect(report.findings).toHaveLength(RECONCILIATION_REPORT_FINDING_LIMIT);
    expect(report.findingsTruncated).toBe(true);
    expect(report.counts).toMatchObject({
      findings: RECONCILIATION_REPORT_FINDING_LIMIT + 5,
      open: RECONCILIATION_REPORT_FINDING_LIMIT + 5,
      scanned: 50,
    });
    expect(report.status).toBe('partial');
    expect(reconciliationReportExitCode(report)).toBe(2);
  });

  it('bounds and explicitly marks an oversized report scope', () => {
    const report = createReconciliationReport({
      channelIds: Array.from(
        { length: RECONCILIATION_REPORT_SCOPE_LIMIT + 5 },
        (_, index) => `-${index + 1}`,
      ),
      mode: 'dry-run',
    });

    expect(report.scope.channelIds).toHaveLength(RECONCILIATION_REPORT_SCOPE_LIMIT);
    expect(report.scope.channelIdsTruncated).toBe(true);
  });

  it('projects allowlisted fields and redacts common sensitive report text', () => {
    const report = createReconciliationReport({
      channelIds: ['-1002234260754'],
      mode: 'persisted-scan',
    });
    addReconciliationFinding(report, {
      ...finding(7),
      raw: 'message body must not be copied',
      sanitizedReason:
        'source_path=/Users/nahida/export/result.json file_id=secret-file 123456789:abcdefghijklmnopqrstuvwxyz',
    } as Parameters<typeof addReconciliationFinding>[1] & { raw: string });
    addReconciliationReportIssue(report, {
      code: 'path_probe',
      sanitizedReason:
        'Paths /Volumes/archive/export.json /opt/koharu/state.json /srv/koharu/raw.json, URL https://example.test/export stays',
    });
    addReconciliationReportIssue(report, {
      code: 'structured_locator',
      sanitizedReason:
        '{"desktop_source_path":"ChatExport/photos/x.jpg","telegram_file_unique_id":"secret-unique","source_locator":"relative/media.mov"}',
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('message body must not be copied');
    expect(serialized).not.toContain('/Users/nahida');
    expect(serialized).not.toContain('secret-file');
    expect(serialized).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(serialized).not.toContain('/Volumes/archive');
    expect(serialized).not.toContain('/opt/koharu');
    expect(serialized).not.toContain('/srv/koharu');
    expect(serialized).not.toContain('ChatExport/photos');
    expect(serialized).not.toContain('secret-unique');
    expect(serialized).not.toContain('relative/media.mov');
    expect(serialized).toContain('https://example.test/export');
    expect(serialized).toContain('[redacted]');
  });

  it('reports Bot-global evidence without inventing a channel scope', () => {
    const report = createReconciliationReport({
      channelIds: ['-1002234260754'],
      mode: 'dry-run',
    });
    addReconciliationFinding(report, {
      channelId: null,
      evidenceVersion: 1,
      kind: 'transport_id_discontinuity',
      sanitizedReason: 'Bot update IDs have a discontinuity from 101 to 105',
      severity: 'warning',
      stableKey: createReconciliationFindingKey({
        channelId: null,
        evidenceIds: ['101', '105'],
        kind: 'transport_id_discontinuity',
      }),
      state: 'open',
    });

    expect(report.findings[0]).toMatchObject({
      channelId: null,
      kind: 'transport_id_discontinuity',
    });
  });

  it('bounds issues and maps clean, repaired, partial, fatal, and interrupted to 0/1/2', () => {
    const clean = finishReconciliationReport(
      createReconciliationReport({ channelIds: ['-1001'], mode: 'dry-run' }),
    );
    const repaired = finishReconciliationReport(
      createReconciliationReport({ channelIds: ['-1001'], mode: 'apply' }),
      { repaired: 1 },
    );
    const partial = createReconciliationReport({
      channelIds: ['-1001'],
      mode: 'dry-run',
    });
    for (let index = 0; index < RECONCILIATION_REPORT_ISSUE_LIMIT + 3; index += 1) {
      addReconciliationReportIssue(partial, {
        code: 'scan_item_failed',
        sanitizedReason: `Item ${index} could not be inspected`,
      });
    }
    finishReconciliationReport(partial);
    const fatal = finishReconciliationReport(
      createReconciliationReport({ channelIds: ['-1001'], mode: 'dry-run' }),
      { fatal: true },
    );
    const interrupted = finishReconciliationReport(
      createReconciliationReport({ channelIds: ['-1001'], mode: 'dry-run' }),
      { interrupted: true },
    );

    expect(reconciliationReportExitCode(clean)).toBe(0);
    expect(reconciliationReportExitCode(repaired)).toBe(0);
    expect(reconciliationReportExitCode(partial)).toBe(2);
    expect(reconciliationReportExitCode(fatal)).toBe(1);
    expect(reconciliationReportExitCode(interrupted)).toBe(1);
    expect(partial.issues).toHaveLength(RECONCILIATION_REPORT_ISSUE_LIMIT);
    expect(partial.issuesTruncated).toBe(true);
    expect(partial.counts.itemErrors).toBe(RECONCILIATION_REPORT_ISSUE_LIMIT + 3);
  });
});
