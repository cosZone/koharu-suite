import { describe, expect, it, vi } from 'vitest';
import { reconciliationReportExitCode } from '../src/reconciliation/report.js';
import {
  type ReconciliationScanner,
  ReconciliationScopeError,
} from '../src/reconciliation/repository.js';
import { ReconciliationService } from '../src/reconciliation/service.js';

describe('reconciliation dry-run service', () => {
  it('keeps Bot-global evidence global and numeric gaps as findings only', async () => {
    const scanner: ReconciliationScanner = {
      scanDryRun: vi.fn<ReconciliationScanner['scanDryRun']>(async (_channels, _now, visit) => {
        visit({
          channelId: null,
          evidenceIds: ['101', '105'],
          evidenceVersion: 1,
          kind: 'transport_id_discontinuity',
          sanitizedReason: 'Bot update IDs jump from 101 to 105',
          severity: 'warning',
        });
        visit({
          channelId: '-1002234260754',
          evidenceIds: ['20', '23'],
          evidenceVersion: 1,
          kind: 'message_id_candidate',
          sanitizedReason: 'Channel message IDs jump from 20 to 23',
          severity: 'warning',
        });
        return { scanned: 12 };
      }),
    };
    const report = await new ReconciliationService(scanner).scan({
      now: new Date('2026-07-24T00:00:00.000Z'),
      telegramChannelIds: [-1_002_234_260_754n],
    });

    expect(report.counts).toMatchObject({ findings: 2, open: 2, scanned: 12 });
    expect(report.findings).toEqual([
      expect.objectContaining({
        channelId: null,
        kind: 'transport_id_discontinuity',
        state: 'open',
      }),
      expect.objectContaining({
        channelId: '-1002234260754',
        kind: 'message_id_candidate',
        state: 'open',
      }),
    ]);
    expect(reconciliationReportExitCode(report)).toBe(2);
    expect(scanner.scanDryRun).toHaveBeenCalledOnce();
  });

  it('turns invalid explicit scope into a bounded fatal report', async () => {
    const scanner: ReconciliationScanner = {
      scanDryRun: vi.fn<ReconciliationScanner['scanDryRun']>(async () => {
        throw new ReconciliationScopeError('Every scan channel must exist in the allowlist');
      }),
    };
    const report = await new ReconciliationService(scanner).scan({
      telegramChannelIds: [-1_001n],
    });

    expect(report.status).toBe('fatal');
    expect(report.issues).toEqual([
      {
        code: 'invalid_scope',
        sanitizedReason: 'Every scan channel must exist in the allowlist',
      },
    ]);
    expect(reconciliationReportExitCode(report)).toBe(1);
  });

  it('rejects oversized scope before invoking the scanner and bounds the fatal report', async () => {
    const scanner: ReconciliationScanner = {
      scanDryRun: vi.fn<ReconciliationScanner['scanDryRun']>(async () => ({ scanned: 0 })),
    };
    const report = await new ReconciliationService(scanner).scan({
      telegramChannelIds: Array.from({ length: 101 }, (_, index) => BigInt(-index - 1)),
    });

    expect(report.status).toBe('fatal');
    expect(report.scope.channelIds).toHaveLength(100);
    expect(report.scope.channelIdsTruncated).toBe(true);
    expect(report.issues).toEqual([
      {
        code: 'invalid_scope',
        sanitizedReason: 'A scan may include at most 100 channels',
      },
    ]);
    expect(scanner.scanDryRun).not.toHaveBeenCalled();
  });
});
