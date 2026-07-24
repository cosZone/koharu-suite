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
      persistScanInLockedTransaction: vi.fn(async () => ({ report, runId: 'scan-run' })),
    };
    const repair = {
      applyInTransaction: vi.fn(async () => ({
        actionKind: 'derived_html.rerender' as const,
        changed: true,
        findingId: 'finding-one',
        replayed: false,
        runId: 'batch-apply-run',
      })),
    };
    const transaction = {
      execute: vi.fn(async () => undefined),
      insert: vi.fn(() => ({
        values: () => ({
          returning: async () => [{ id: 'batch-apply-run' }],
        }),
      })),
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
      transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback({}),
      ),
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: 'batch-apply-run' }],
          }),
        }),
      })),
    };
    const database = {
      transaction: vi.fn(
        async (callback: (activeTransaction: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
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

    expect(persistence.persistScanInLockedTransaction).toHaveBeenCalledWith(transaction, {
      initiatorKind: 'local_operator',
      telegramChannelIds: [-1001n],
    });
    expect(repair.applyInTransaction).toHaveBeenCalledWith(
      {},
      {
        expectedEvidenceVersion: 1,
        findingId: 'finding-one',
        initiatorId: null,
        initiatorKind: 'local_operator',
        reason: 'Approved deterministic repair',
      },
      { runId: 'batch-apply-run' },
    );
    expect(transaction.execute).toHaveBeenCalledOnce();
    expect(transaction.transaction).toHaveBeenCalledOnce();
    expect(applied).toMatchObject({
      counts: { open: 0, repaired: 1, resolved: 1 },
      findings: [{ state: 'resolved' }],
      mode: 'apply',
      status: 'repaired',
    });
  });
});
