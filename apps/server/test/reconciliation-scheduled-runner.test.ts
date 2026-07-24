import { describe, expect, it, vi } from 'vitest';
import {
  addReconciliationReportIssue,
  createReconciliationReport,
  finishReconciliationReport,
  type ReconciliationReport,
} from '../src/reconciliation/report.js';
import {
  type ClaimedScheduledReconciliationScanner,
  type ScheduledReconciliationLeaseRepository,
  ScheduledReconciliationRunner,
} from '../src/reconciliation/scheduled-runner.js';

const CHANNEL_IDS = ['-1001'];

function lease() {
  return {
    claimedRunId: '4df0efff-baa6-4d2a-8bf5-fdb11a468d88',
    enabled: true,
    intervalSeconds: 60,
    lastRunId: null,
    lastStatus: null,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    leaseOwner: 'worker-one',
    leaseToken: 'fe0debd9-a5a7-4e70-92ee-96109171536f',
    nextRunAt: new Date().toISOString(),
  } as const;
}

function schedule(
  overrides: Partial<ScheduledReconciliationLeaseRepository> = {},
): ScheduledReconciliationLeaseRepository {
  const claimed = lease();
  return {
    claimDue: vi
      .fn<ScheduledReconciliationLeaseRepository['claimDue']>()
      .mockResolvedValueOnce(claimed)
      .mockResolvedValue(null),
    complete: vi.fn<ScheduledReconciliationLeaseRepository['complete']>(async () => ({
      ...claimed,
      claimedRunId: null,
      lastRunId: claimed.claimedRunId,
      lastStatus: 'completed',
      leaseExpiresAt: null,
      leaseOwner: null,
      leaseToken: null,
    })),
    release: vi.fn<ScheduledReconciliationLeaseRepository['release']>(
      async (_instanceId, input) => ({
        ...claimed,
        claimedRunId: null,
        lastRunId: claimed.claimedRunId,
        lastStatus: input.status,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseToken: null,
      }),
    ),
    renew: vi.fn<ScheduledReconciliationLeaseRepository['renew']>(async () => claimed),
    ...overrides,
  };
}

function report(status: 'clean' | 'fatal' | 'interrupted' | 'partial' | 'repaired') {
  const value = createReconciliationReport({
    channelIds: CHANNEL_IDS,
    mode: 'scheduled-scan',
  });
  if (status === 'partial' || status === 'fatal') {
    addReconciliationReportIssue(value, {
      code: 'scan_issue',
      sanitizedReason: 'The scheduled scan did not complete cleanly',
    });
  }
  return finishReconciliationReport(value, {
    fatal: status === 'fatal',
    interrupted: status === 'interrupted',
    repaired: status === 'repaired' ? 1 : 0,
  });
}

function runner(
  scheduleRepository: ScheduledReconciliationLeaseRepository,
  scanner: ClaimedScheduledReconciliationScanner,
) {
  return new ScheduledReconciliationRunner(scheduleRepository, scanner, {
    getTelegramChannelIds: async () => CHANNEL_IDS,
    instanceId: 'worker-one',
    leaseDurationMs: 100,
    pollIntervalMs: 10,
    renewalIntervalMs: 5,
  });
}

describe('scheduled reconciliation runner', () => {
  it('idles without claiming when no channels are configured', async () => {
    const scheduleRepository = schedule();
    const scanner: ClaimedScheduledReconciliationScanner = {
      scanClaimedRun: vi.fn(async () => report('clean')),
    };
    const service = new ScheduledReconciliationRunner(scheduleRepository, scanner, {
      getTelegramChannelIds: async () => [],
      instanceId: 'worker-one',
      leaseDurationMs: 100,
      pollIntervalMs: 10,
      renewalIntervalMs: 5,
    });
    const lifetime = service.start();

    await new Promise((resolve) => setTimeout(resolve, 15));
    await service.stop();
    await expect(lifetime).resolves.toBeUndefined();
    expect(scheduleRepository.claimDue).not.toHaveBeenCalled();
    expect(scanner.scanClaimedRun).not.toHaveBeenCalled();
  });

  it('claims a due run, invokes only the claimed scan interface, and completes cleanly', async () => {
    const scheduleRepository = schedule();
    const scanner: ClaimedScheduledReconciliationScanner = {
      scanClaimedRun: vi.fn(async () => report('clean')),
    };
    const service = runner(scheduleRepository, scanner);
    const lifetime = service.start();

    await vi.waitFor(() => expect(scheduleRepository.complete).toHaveBeenCalledOnce());
    await service.stop();
    await expect(lifetime).resolves.toBeUndefined();

    expect(scanner.scanClaimedRun).toHaveBeenCalledWith({
      runId: lease().claimedRunId,
      signal: expect.any(AbortSignal),
      telegramChannelIds: CHANNEL_IDS,
    });
    expect(scheduleRepository.complete).toHaveBeenCalledWith(
      'worker-one',
      expect.objectContaining({
        leaseToken: lease().leaseToken,
        report: expect.objectContaining({
          mode: 'scheduled-scan',
          status: 'clean',
        }),
        runId: lease().claimedRunId,
        status: 'completed',
      }),
    );
    expect(scheduleRepository.release).not.toHaveBeenCalled();
  });

  it('renews the token-bound lease while a scan is active', async () => {
    let resolveScan!: (value: ReconciliationReport) => void;
    const scan = new Promise<ReconciliationReport>((resolve) => {
      resolveScan = resolve;
    });
    const scheduleRepository = schedule();
    const scanner: ClaimedScheduledReconciliationScanner = {
      scanClaimedRun: vi.fn(() => scan),
    };
    const service = runner(scheduleRepository, scanner);
    const lifetime = service.start();

    await vi.waitFor(() => expect(scheduleRepository.renew).toHaveBeenCalled());
    expect(scheduleRepository.renew).toHaveBeenCalledWith('worker-one', lease().leaseToken, 100);
    resolveScan(report('clean'));
    await vi.waitFor(() => expect(scheduleRepository.complete).toHaveBeenCalledOnce());
    await service.stop();
    await expect(lifetime).resolves.toBeUndefined();
  });

  it('cooperatively interrupts the active scan and releases its claim on stop', async () => {
    const scheduleRepository = schedule();
    const scanner: ClaimedScheduledReconciliationScanner = {
      scanClaimedRun: vi.fn(
        ({ signal }) =>
          new Promise<ReconciliationReport>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    };
    const service = runner(scheduleRepository, scanner);
    const lifetime = service.start();
    await vi.waitFor(() => expect(scanner.scanClaimedRun).toHaveBeenCalledOnce());

    await service.stop();
    await expect(lifetime).resolves.toBeUndefined();
    expect(scheduleRepository.release).toHaveBeenCalledWith(
      'worker-one',
      expect.objectContaining({
        report: expect.objectContaining({
          mode: 'scheduled-scan',
          status: 'interrupted',
        }),
        status: 'interrupted',
      }),
    );
    expect(scheduleRepository.complete).not.toHaveBeenCalled();
  });

  it('records a failed run for scan errors and rejects any repaired mutation report', async () => {
    const scanError = new Error('scan exploded at /private/export');
    const failedSchedule = schedule();
    const failed = runner(failedSchedule, {
      scanClaimedRun: vi.fn(async () => {
        throw scanError;
      }),
    });
    const failedLifetime = failed.start();
    await vi.waitFor(() => expect(failedSchedule.release).toHaveBeenCalledOnce());
    await failed.stop();
    await expect(failedLifetime).resolves.toBeUndefined();
    expect(failedSchedule.release).toHaveBeenCalledWith(
      'worker-one',
      expect.objectContaining({
        report: expect.objectContaining({
          issues: [
            expect.objectContaining({
              code: 'scheduled_scan_failed',
              sanitizedReason: expect.not.stringContaining('/private/export'),
            }),
          ],
          status: 'fatal',
        }),
        status: 'failed',
      }),
    );

    const repairedSchedule = schedule();
    const repaired = runner(repairedSchedule, {
      scanClaimedRun: vi.fn(async () => report('repaired')),
    });
    const repairedLifetime = repaired.start();
    await vi.waitFor(() => expect(repairedSchedule.release).toHaveBeenCalledOnce());
    await repaired.stop();
    await expect(repairedLifetime).resolves.toBeUndefined();
    expect(repairedSchedule.complete).not.toHaveBeenCalled();
    expect(repairedSchedule.release).toHaveBeenCalledWith(
      'worker-one',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('fails closed when lease renewal and token-bound release both lose ownership', async () => {
    const leaseLost = new Error('Reconciliation schedule lease ownership was lost');
    const scheduleRepository = schedule({
      release: vi.fn(async () => {
        throw leaseLost;
      }),
      renew: vi.fn(async () => {
        throw leaseLost;
      }),
    });
    const scanner: ClaimedScheduledReconciliationScanner = {
      scanClaimedRun: vi.fn(
        ({ signal }) =>
          new Promise<ReconciliationReport>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    };
    const service = runner(scheduleRepository, scanner);

    await expect(service.start()).rejects.toBe(leaseLost);
    expect(scheduleRepository.complete).not.toHaveBeenCalled();
    expect(scheduleRepository.release).toHaveBeenCalledWith(
      'worker-one',
      expect.objectContaining({
        leaseToken: lease().leaseToken,
        runId: lease().claimedRunId,
        status: 'failed',
      }),
    );
  });
});
