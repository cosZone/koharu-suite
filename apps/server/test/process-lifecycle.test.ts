import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerProcessLifecycle } from '../src/process-lifecycle.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('process lifecycle', () => {
  it('forces a failed exit when graceful shutdown exceeds its deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const existingHandlers = new Set(process.listeners('SIGTERM'));
    const forceExit = vi.fn();
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const cleanup = registerProcessLifecycle(
      {
        done: new Promise<void>(() => {}),
        stop,
      },
      {
        forceExit,
        shutdownDeadlineMs: 25_000,
      },
    );
    const shutdown = process
      .listeners('SIGTERM')
      .find((listener) => !existingHandlers.has(listener));
    if (!shutdown) {
      throw new Error('SIGTERM lifecycle handler was not registered');
    }

    shutdown('SIGTERM');
    expect(stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(24_999);
    expect(forceExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(forceExit).toHaveBeenCalledWith(1);

    cleanup();
  });
});
