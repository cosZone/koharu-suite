import { describe, expect, it, vi } from 'vitest';
import {
  closeImportResources,
  registerImportCancellation,
} from '../src/imports/import-lifecycle.js';

describe('Telegram Desktop import lifecycle', () => {
  it('aborts on a process signal and removes both listeners during cleanup', () => {
    const existingSigint = new Set(process.listeners('SIGINT'));
    const existingSigterm = new Set(process.listeners('SIGTERM'));
    const cancellation = registerImportCancellation();
    const sigterm = process.listeners('SIGTERM').find((listener) => !existingSigterm.has(listener));
    if (!sigterm) {
      throw new Error('SIGTERM import cancellation handler was not registered');
    }

    sigterm('SIGTERM');
    expect(cancellation.signal.aborted).toBe(true);
    cancellation.cleanup();
    expect(process.listeners('SIGINT').filter((listener) => !existingSigint.has(listener))).toEqual(
      [],
    );
    expect(
      process.listeners('SIGTERM').filter((listener) => !existingSigterm.has(listener)),
    ).toEqual([]);
  });

  it('attempts every resource cleanup even when more than one fails', async () => {
    const first = vi.fn(async () => {
      throw new Error('first close failed');
    });
    const second = vi.fn(async () => {
      throw new Error('second close failed');
    });

    await expect(closeImportResources(first, second)).rejects.toBeInstanceOf(AggregateError);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});
