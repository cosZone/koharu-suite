import { afterEach, describe, expect, it, vi } from 'vitest';
import { startStatusPoller } from './status-poller';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('startStatusPoller', () => {
  it('schedules the next request only after the current request settles', async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const fetchStatus = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce('stale');
    const onStatus = vi.fn();
    const stop = startStatusPoller({
      fetchStatus,
      intervalMs: 10_000,
      onStatus,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    first.resolve('running');
    await vi.runAllTicks();
    expect(onStatus).toHaveBeenCalledWith('running');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith('stale');
    stop();
  });

  it('aborts an active request and ignores a late result after stop', async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const observedSignal: { current: AbortSignal | null } = { current: null };
    const onStatus = vi.fn();
    const stop = startStatusPoller({
      fetchStatus(signal) {
        observedSignal.current = signal;
        return pending.promise;
      },
      intervalMs: 10_000,
      onStatus,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    stop();

    expect(observedSignal.current?.aborted).toBe(true);
    pending.resolve('stale');
    await vi.runAllTicks();
    expect(onStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onStatus).not.toHaveBeenCalled();
  });
});
