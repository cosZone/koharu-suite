import { describe, expect, it } from 'vitest';
import { closeIteratorBestEffort, runWithAbort } from '../src/async-control.js';

describe('async control', () => {
  it('does not start an operation when abort happens during subscription', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((
      ...args: Parameters<AbortSignal['addEventListener']>
    ) => {
      originalAdd(...args);
      controller.abort(reason);
    }) as AbortSignal['addEventListener'];
    let started = false;

    await expect(
      runWithAbort(() => {
        started = true;
        return 'unexpected';
      }, controller.signal),
    ).rejects.toBe(reason);
    expect(started).toBe(false);
  });

  it('bounds stalled cleanup and swallows synchronous cleanup failures', async () => {
    const startedAt = Date.now();
    await closeIteratorBestEffort({
      next: async () => ({ done: true, value: undefined }),
      return: () => new Promise<IteratorResult<undefined>>(() => undefined),
    });
    expect(Date.now() - startedAt).toBeLessThan(500);

    await expect(
      closeIteratorBestEffort({
        next: async () => ({ done: true, value: undefined }),
        return: () => {
          throw new Error('cleanup failed');
        },
      }),
    ).resolves.toBeUndefined();
  });
});
