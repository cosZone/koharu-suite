import { describe, expect, it, vi } from 'vitest';
import {
  RECONCILIATION_APPLY_UNAVAILABLE_ERROR_CODE,
  RECONCILIATION_APPLY_UNAVAILABLE_ERROR_MESSAGE,
  renderReconciliationReport,
  runReconciliationCli,
} from '../src/reconciliation/cli.js';
import {
  addReconciliationFinding,
  createReconciliationFindingKey,
  createReconciliationReport,
  finishReconciliationReport,
} from '../src/reconciliation/report.js';

describe('reconciliation CLI', () => {
  it('defaults to the injected dry-run scanner and returns the bounded report exit code', async () => {
    const report = finishReconciliationReport(
      createReconciliationReport({
        channelIds: ['-1002234260754'],
        mode: 'dry-run',
      }),
    );
    const scan = vi.fn(async () => report);
    const write = vi.fn();

    await expect(
      runReconciliationCli(
        {
          apply: false,
          channelIds: [-1002234260754n],
          json: true,
        },
        { scan, write },
      ),
    ).resolves.toBe(0);
    expect(scan).toHaveBeenCalledWith([-1002234260754n]);
    expect(JSON.parse(write.mock.calls[0]?.[0] ?? '{}')).toMatchObject({
      mode: 'dry-run',
      schemaVersion: 1,
      status: 'clean',
    });
  });

  it('injects an accepted apply with a trimmed reason and local operator identity', async () => {
    const report = finishReconciliationReport(
      createReconciliationReport({
        channelIds: ['-1002234260754', '-1002234260755'],
        mode: 'apply',
      }),
      { repaired: 2 },
    );
    const apply = vi.fn(async () => report);
    const scan = vi.fn();
    let output = '';

    await expect(
      runReconciliationCli(
        {
          apply: true,
          channelIds: [-1002234260754n, -1002234260755n],
          json: true,
          reason: '  operator approved  ',
        },
        {
          apply,
          scan,
          write: (value) => {
            output += value;
          },
        },
      ),
    ).resolves.toBe(0);

    expect(scan).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith({
      channelIds: [-1002234260754n, -1002234260755n],
      initiatorId: null,
      initiatorKind: 'local_operator',
      reason: 'operator approved',
    });
    expect(JSON.parse(output)).toMatchObject({
      counts: { repaired: 2 },
      mode: 'apply',
      schemaVersion: 1,
      status: 'repaired',
    });
  });

  it.each([
    [{ apply: true, reason: undefined }, 'invalid_apply_reason'],
    [{ apply: true, reason: '   ' }, 'invalid_apply_reason'],
    [{ apply: false, reason: 'operator approved' }, 'reason_without_apply'],
  ])(
    'rejects invalid apply arguments without invoking either dependency',
    async (override, code) => {
      const apply = vi.fn();
      const scan = vi.fn();
      let output = '';

      await expect(
        runReconciliationCli(
          {
            apply: override.apply,
            channelIds: [-1002234260754n],
            json: true,
            ...(override.reason === undefined ? {} : { reason: override.reason }),
          },
          {
            apply,
            scan,
            write: (value) => {
              output += value;
            },
          },
        ),
      ).resolves.toBe(1);
      expect(apply).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(JSON.parse(output)).toMatchObject({
        issues: [{ code }],
        status: 'fatal',
      });
    },
  );

  it('returns a versioned unavailable report when an apply runtime is not wired', async () => {
    let output = '';
    await expect(
      runReconciliationCli(
        {
          apply: true,
          channelIds: [-1002234260754n],
          json: true,
          reason: 'operator approved',
        },
        {
          write: (value) => {
            output += value;
          },
        },
      ),
    ).resolves.toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      issues: [
        {
          code: RECONCILIATION_APPLY_UNAVAILABLE_ERROR_CODE,
          sanitizedReason: RECONCILIATION_APPLY_UNAVAILABLE_ERROR_MESSAGE,
        },
      ],
      mode: 'apply',
      schemaVersion: 1,
      status: 'fatal',
    });
  });

  it('converts an injected apply failure into a privacy-safe versioned fatal report', async () => {
    let output = '';
    await expect(
      runReconciliationCli(
        {
          apply: true,
          channelIds: [-1002234260754n],
          json: true,
          reason: 'operator approved',
        },
        {
          apply: async () => {
            throw new Error('postgresql://owner:secret@localhost/archive');
          },
          write: (value) => {
            output += value;
          },
        },
      ),
    ).resolves.toBe(1);
    expect(output).not.toContain('secret');
    expect(JSON.parse(output)).toMatchObject({
      issues: [{ code: 'reconciliation_apply_failed' }],
      schemaVersion: 1,
      status: 'fatal',
    });
  });

  it('returns exit 2 when the injected report contains an open finding', async () => {
    const report = createReconciliationReport({
      channelIds: ['-1002234260754'],
      mode: 'dry-run',
    });
    addReconciliationFinding(report, {
      channelId: '-1002234260754',
      evidenceVersion: 1,
      kind: 'message_id_candidate',
      messageId: '17',
      sanitizedReason: 'A message ID gap needs operator review',
      severity: 'warning',
      stableKey: createReconciliationFindingKey({
        channelId: '-1002234260754',
        kind: 'message_id_candidate',
        messageId: '17',
      }),
      state: 'open',
    });
    finishReconciliationReport(report);

    await expect(
      runReconciliationCli(
        {
          apply: false,
          channelIds: [-1002234260754n],
          json: false,
        },
        {
          scan: async () => report,
          write: vi.fn(),
        },
      ),
    ).resolves.toBe(2);
  });

  it('renders Desktop export/import recovery guidance for gap evidence', () => {
    const report = createReconciliationReport({
      channelIds: ['-1002234260754'],
      mode: 'dry-run',
    });
    addReconciliationFinding(report, {
      channelId: '-1002234260754',
      evidenceVersion: 1,
      kind: 'message_id_candidate',
      messageId: '17',
      sanitizedReason: 'A message ID gap needs operator review',
      severity: 'warning',
      stableKey: createReconciliationFindingKey({
        channelId: '-1002234260754',
        kind: 'message_id_candidate',
        messageId: '17',
      }),
      state: 'open',
    });
    finishReconciliationReport(report);

    const human = renderReconciliationReport(report, false);
    expect(human).toContain('Telegram reconciliation DRY RUN: PARTIAL');
    expect(human).toContain(
      'kodama import telegram-desktop --input ./result.json --channel -1002234260754',
    );
    expect(JSON.parse(renderReconciliationReport(report, true))).toMatchObject({
      recoveryGuidance: {
        desktopExportRecommended: true,
        importArguments: [
          'import',
          'telegram-desktop',
          '--input',
          './result.json',
          '--channel',
          '-1002234260754',
        ],
      },
    });
  });
});
