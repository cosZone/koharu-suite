import { describe, expect, it, vi } from 'vitest';
import { ReconciliationApplyService } from '../src/reconciliation/apply-service.js';
import {
  createReconciliationReport,
  finishReconciliationReport,
} from '../src/reconciliation/report.js';

describe('reconciliation apply service', () => {
  it('persists a fresh scan before applying deterministic findings', async () => {
    const report = createReconciliationReport({
      channelIds: ['-1001'],
      mode: 'persisted-scan',
    });
    report.counts.findings = 1;
    report.counts.open = 1;
    report.counts.warnings = 1;
    report.findings.push({
      channelId: '-1001',
      evidenceVersion: 1,
      kind: 'derived_html_drift',
      messageId: '8b1133f6-c7fa-4374-bc69-5f3709348421',
      sanitizedReason: 'Derived output differs',
      severity: 'warning',
      stableKey: 'reconciliation:v1:test',
      state: 'open',
    });
    finishReconciliationReport(report);
    const persistence = {
      persistScan: vi.fn(async () => ({ report, runId: 'scan-run' })),
    };
    const repair = {
      apply: vi.fn(async () => ({
        actionKind: 'derived_html.rerender' as const,
        changed: true,
        findingId: 'finding-one',
        replayed: false,
        runId: 'apply-run',
      })),
    };
    const database = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [
                {
                  evidenceVersion: 1,
                  id: 'finding-one',
                  stableKey: 'reconciliation:v1:test',
                },
              ],
            }),
          }),
        }),
      })),
    };
    const service = new ReconciliationApplyService(
      database as never,
      persistence as never,
      repair as never,
    );

    const applied = await service.apply({
      channelIds: [-1001n],
      initiatorId: null,
      initiatorKind: 'local_operator',
      reason: 'Approved deterministic repair',
    });

    expect(persistence.persistScan).toHaveBeenCalledWith({
      initiatorKind: 'local_operator',
      telegramChannelIds: [-1001n],
    });
    expect(repair.apply).toHaveBeenCalledWith({
      expectedEvidenceVersion: 1,
      findingId: 'finding-one',
      initiatorId: null,
      initiatorKind: 'local_operator',
      reason: 'Approved deterministic repair',
    });
    expect(applied).toMatchObject({
      counts: { open: 0, repaired: 1, resolved: 1 },
      findings: [{ state: 'resolved' }],
      mode: 'apply',
      status: 'repaired',
    });
  });
});
