import { describe, expect, it, vi } from 'vitest';
import { MediaCacheWorkerRuntime } from '../src/media-cache/runtime.js';

describe('media cache worker runtime lifecycle', () => {
  it('initializes once, stays alive, aborts in-flight work, and waits for it during stop', async () => {
    const initialize = vi.fn(async () => undefined);
    let inFlightFinished = false;
    const runOnce = vi.fn(
      async (signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          const abort = () => {
            inFlightFinished = true;
            reject(signal?.reason);
          };
          signal?.addEventListener('abort', abort, { once: true });
        }),
    );
    const runtime = new MediaCacheWorkerRuntime({
      capacity: {
        initialize,
        pruneConfiguredExcess: vi.fn(async () => undefined),
      },
      idleIntervalMs: 1_000,
      runner: { runOnce },
    });

    await Promise.all([runtime.initialize(), runtime.initialize()]);
    const lifetime = runtime.start();
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledOnce());
    let lifetimeSettled = false;
    void lifetime.finally(() => {
      lifetimeSettled = true;
    });
    await Promise.resolve();
    expect(lifetimeSettled).toBe(false);

    await runtime.stop();
    await expect(runtime.done).resolves.toBeUndefined();
    expect(inFlightFinished).toBe(true);
    expect(initialize).toHaveBeenCalledOnce();
  });

  it('isolates one steady-state cache failure and retries without ending its parent lifetime', async () => {
    const failure = new Error('database unavailable');
    const runOnce = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({
      completedPlans: 0,
      discovered: 0,
      failedPlans: 0,
      recoveredPlans: 0,
      scannedEvidence: 0,
      thumbnailsCompleted: 0,
      thumbnailsSkipped: 0,
    });
    const runtime = new MediaCacheWorkerRuntime({
      capacity: {
        initialize: vi.fn(async () => undefined),
        pruneConfiguredExcess: vi.fn(async () => undefined),
      },
      idleIntervalMs: 1,
      runner: { runOnce },
    });

    let lifetimeSettled = false;
    void runtime.start().finally(() => {
      lifetimeSettled = true;
    });
    await vi.waitFor(() => expect(runOnce.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(lifetimeSettled).toBe(false);

    await runtime.stop();
    await expect(runtime.done).resolves.toBeUndefined();
  });

  it('polls one bounded maintenance command from the worker-owned runtime loop', async () => {
    const commandRunOnce = vi.fn(async () => false);
    const workerRunOnce = vi.fn(async () => ({
      completedPlans: 0,
      discovered: 0,
      failedPlans: 0,
      recoveredPlans: 0,
      scannedEvidence: 0,
      thumbnailsCompleted: 0,
      thumbnailsSkipped: 0,
    }));
    const runtime = new MediaCacheWorkerRuntime({
      capacity: {
        initialize: vi.fn(async () => undefined),
        pruneConfiguredExcess: vi.fn(async () => undefined),
      },
      commands: { runOnce: commandRunOnce },
      idleIntervalMs: 1,
      runner: { runOnce: workerRunOnce },
    });

    void runtime.start();
    await vi.waitFor(() => expect(commandRunOnce).toHaveBeenCalled());
    expect(workerRunOnce).toHaveBeenCalled();
    await runtime.stop();
  });

  it('isolates prune, command, and runner failures within the same runtime pass', async () => {
    const prune = vi.fn().mockRejectedValue(new Error('capacity unavailable'));
    const command = vi.fn().mockRejectedValue(new Error('poison maintenance command'));
    const runner = vi.fn().mockRejectedValue(new Error('worker unavailable'));
    const runtime = new MediaCacheWorkerRuntime({
      capacity: {
        initialize: vi.fn(async () => undefined),
        pruneConfiguredExcess: prune,
      },
      commands: { runOnce: command },
      idleIntervalMs: 1,
      runner: { runOnce: runner },
    });

    void runtime.start();
    await vi.waitFor(() => expect(runner.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(prune.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(command.mock.calls.length).toBeGreaterThanOrEqual(2);

    await runtime.stop();
    await expect(runtime.done).resolves.toBeUndefined();
  });

  it('waits for initialization if stopped before the loop starts', async () => {
    let finishInitialization: (() => void) | undefined;
    const initialize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishInitialization = resolve;
        }),
    );
    const runtime = new MediaCacheWorkerRuntime({
      capacity: {
        initialize,
        pruneConfiguredExcess: vi.fn(async () => undefined),
      },
      runner: { runOnce: vi.fn(() => new Promise<never>(() => {})) },
    });

    void runtime.initialize();
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishInitialization?.();
    await stopping;
    await expect(runtime.done).resolves.toBeUndefined();
  });
});
