import {
  addReconciliationReportIssue,
  createReconciliationReport,
  finishReconciliationReport,
  type ReconciliationReport,
} from './report.js';
import type {
  ReconciliationScheduleLease,
  ReconciliationScheduleState,
} from './schedule-repository.js';

export interface ClaimedScheduledReconciliationScanInput {
  runId: string;
  signal: AbortSignal;
  telegramChannelIds: readonly string[];
}

export interface ClaimedScheduledReconciliationScanner {
  scanClaimedRun(input: ClaimedScheduledReconciliationScanInput): Promise<ReconciliationReport>;
}

export interface ScheduledReconciliationLeaseRepository {
  claimDue(
    instanceId: string,
    leaseDurationMs: number,
    scope: readonly string[],
  ): Promise<ReconciliationScheduleLease | null>;
  complete(
    instanceId: string,
    input: {
      leaseToken: string;
      report: ReconciliationReport;
      runId: string;
      status: 'completed' | 'partial';
    },
  ): Promise<ReconciliationScheduleState>;
  release(
    instanceId: string,
    input: {
      leaseToken: string;
      report: ReconciliationReport;
      runId: string;
      status: 'failed' | 'interrupted';
    },
  ): Promise<ReconciliationScheduleState>;
  renew(
    instanceId: string,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<ReconciliationScheduleLease>;
}

export interface ScheduledReconciliationRunnerOptions {
  getTelegramChannelIds(): Promise<readonly string[]>;
  instanceId: string;
  leaseDurationMs: number;
  pollIntervalMs: number;
  renewalIntervalMs: number;
}

const STOP_REASON = new Error('Scheduled reconciliation runner stopped');

function deferred(): {
  promise: Promise<void>;
  reject: (reason: unknown) => void;
  resolve: () => void;
} {
  let rejectPromise!: (reason: unknown) => void;
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

export class ScheduledReconciliationRunner {
  private activeScan: AbortController | undefined;
  private readonly completion = deferred();
  private idleWake: (() => void) | undefined;
  private settled = false;
  private started = false;
  private stopPromise: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly schedule: ScheduledReconciliationLeaseRepository,
    private readonly scanner: ClaimedScheduledReconciliationScanner,
    private readonly options: ScheduledReconciliationRunnerOptions,
  ) {
    assertOptions(options);
  }

  get done(): Promise<void> {
    return this.completion.promise;
  }

  start(): Promise<void> {
    if (this.started) {
      throw new Error('Scheduled reconciliation runner can only be started once');
    }
    this.started = true;
    void this.runLoop().then(
      () => this.resolveDone(),
      (error: unknown) => this.rejectDone(error),
    );
    return this.done;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      const telegramChannelIds = [...(await this.options.getTelegramChannelIds())];
      if (telegramChannelIds.length === 0) {
        await this.waitUntilNextPoll();
        continue;
      }
      const lease = await this.schedule.claimDue(
        this.options.instanceId,
        this.options.leaseDurationMs,
        telegramChannelIds,
      );
      if (this.stopping) {
        if (lease) {
          await this.releaseInterrupted(lease, telegramChannelIds);
        }
        return;
      }
      if (!lease) {
        await this.waitUntilNextPoll();
        continue;
      }
      await this.runClaimedScan(lease, telegramChannelIds);
    }
  }

  private async runClaimedScan(
    lease: ReconciliationScheduleLease,
    telegramChannelIds: readonly string[],
  ): Promise<void> {
    const scanAbort = new AbortController();
    const renewalAbort = new AbortController();
    this.activeScan = scanAbort;
    const scan = this.scanner.scanClaimedRun({
      runId: lease.claimedRunId,
      signal: scanAbort.signal,
      telegramChannelIds,
    });
    const renewal = this.renewUntilSettled(lease, renewalAbort.signal, scanAbort);

    try {
      const report = await Promise.race([scan, renewal.then(() => neverReport())]);
      if (this.stopping || scanAbort.signal.aborted) {
        await this.releaseInterrupted(lease, telegramChannelIds);
        return;
      }
      await this.finishFromReport(lease, report, telegramChannelIds);
    } catch (error) {
      if (!scanAbort.signal.aborted) {
        scanAbort.abort(error);
      }
      await scan.catch(() => undefined);
      if (this.stopping || scanAbort.signal.reason === STOP_REASON) {
        await this.releaseInterrupted(lease, telegramChannelIds);
      } else {
        await this.schedule.release(this.options.instanceId, {
          leaseToken: lease.leaseToken,
          report: failureReport(telegramChannelIds, 'scheduled_scan_failed', error),
          runId: lease.claimedRunId,
          status: 'failed',
        });
      }
    } finally {
      renewalAbort.abort();
      await renewal.catch(() => undefined);
      if (this.activeScan === scanAbort) {
        this.activeScan = undefined;
      }
    }
  }

  private async finishFromReport(
    lease: ReconciliationScheduleLease,
    report: ReconciliationReport,
    telegramChannelIds: readonly string[],
  ): Promise<void> {
    assertScheduledScanReport(report, telegramChannelIds);
    if (report.status === 'clean') {
      await this.schedule.complete(this.options.instanceId, {
        leaseToken: lease.leaseToken,
        report,
        runId: lease.claimedRunId,
        status: 'completed',
      });
      return;
    }
    if (report.status === 'partial') {
      await this.schedule.complete(this.options.instanceId, {
        leaseToken: lease.leaseToken,
        report,
        runId: lease.claimedRunId,
        status: 'partial',
      });
      return;
    }
    if (report.status === 'interrupted') {
      await this.schedule.release(this.options.instanceId, {
        leaseToken: lease.leaseToken,
        report,
        runId: lease.claimedRunId,
        status: 'interrupted',
      });
      return;
    }
    if (report.status === 'fatal') {
      await this.schedule.release(this.options.instanceId, {
        leaseToken: lease.leaseToken,
        report,
        runId: lease.claimedRunId,
        status: 'failed',
      });
      return;
    }
    throw new Error('Scheduled reconciliation scans cannot report repaired mutations');
  }

  private async renewUntilSettled(
    lease: ReconciliationScheduleLease,
    signal: AbortSignal,
    scanAbort: AbortController,
  ): Promise<void> {
    while (!signal.aborted) {
      await abortableDelay(this.options.renewalIntervalMs, signal);
      if (signal.aborted) {
        return;
      }
      try {
        await this.schedule.renew(
          this.options.instanceId,
          lease.leaseToken,
          this.options.leaseDurationMs,
        );
      } catch (error) {
        scanAbort.abort(error);
        throw error;
      }
    }
  }

  private releaseInterrupted(
    lease: ReconciliationScheduleLease,
    telegramChannelIds: readonly string[],
  ): Promise<ReconciliationScheduleState> {
    return this.schedule.release(this.options.instanceId, {
      leaseToken: lease.leaseToken,
      report: interruptedReport(telegramChannelIds),
      runId: lease.claimedRunId,
      status: 'interrupted',
    });
  }

  private waitUntilNextPoll(): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.idleWake = undefined;
        resolve();
      }, this.options.pollIntervalMs);
      timer.unref();
      this.idleWake = () => {
        clearTimeout(timer);
        this.idleWake = undefined;
        resolve();
      };
    });
  }

  private async stopOnce(): Promise<void> {
    this.stopping = true;
    this.activeScan?.abort(STOP_REASON);
    this.idleWake?.();
    if (!this.started) {
      this.resolveDone();
    }
    return this.done;
  }

  private rejectDone(error: unknown): void {
    if (!this.settled) {
      this.settled = true;
      this.completion.reject(error);
    }
  }

  private resolveDone(): void {
    if (!this.settled) {
      this.settled = true;
      this.completion.resolve();
    }
  }
}

function assertOptions(options: ScheduledReconciliationRunnerOptions): void {
  if (options.instanceId.trim().length === 0) {
    throw new TypeError('Scheduled reconciliation instanceId must not be empty');
  }
  for (const [label, value] of [
    ['leaseDurationMs', options.leaseDurationMs],
    ['pollIntervalMs', options.pollIntervalMs],
    ['renewalIntervalMs', options.renewalIntervalMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${label} must be a positive safe integer`);
    }
  }
  if (options.renewalIntervalMs >= options.leaseDurationMs) {
    throw new RangeError('renewalIntervalMs must be shorter than leaseDurationMs');
  }
}

function assertScheduledScanReport(
  report: ReconciliationReport,
  expectedChannelIds: readonly string[],
): void {
  if (report.mode !== 'scheduled-scan' || report.completedAt === null) {
    throw new TypeError('Scheduled reconciliation scanner returned an invalid report');
  }
  const expected = [...new Set(expectedChannelIds)].sort();
  if (
    report.scope.channelIdsTruncated ||
    report.scope.channelIds.length !== expected.length ||
    report.scope.channelIds.some((channelId, index) => channelId !== expected[index])
  ) {
    throw new TypeError('Scheduled reconciliation report scope does not match the claimed scope');
  }
}

function failureReport(
  channelIds: readonly string[],
  code: string,
  error: unknown,
): ReconciliationReport {
  const report = createReconciliationReport({ channelIds, mode: 'scheduled-scan' });
  addReconciliationReportIssue(report, {
    code,
    sanitizedReason: error instanceof Error ? error.message : 'Scheduled reconciliation failed',
  });
  return finishReconciliationReport(report, { fatal: true });
}

function interruptedReport(channelIds: readonly string[]): ReconciliationReport {
  const report = createReconciliationReport({ channelIds, mode: 'scheduled-scan' });
  addReconciliationReportIssue(report, {
    code: 'scheduled_scan_interrupted',
    sanitizedReason: 'Scheduled reconciliation stopped before the scan completed',
  });
  return finishReconciliationReport(report, { interrupted: true });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function neverReport(): Promise<ReconciliationReport> {
  return new Promise(() => {});
}
