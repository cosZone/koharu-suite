import { describe, expect, it, vi } from 'vitest';
import type { PostgresMediaCacheCommandQueue } from '../src/media-cache/command-queue.js';
import { DurableMediaRecacheObserver } from '../src/media-cache/recache-on-access.js';

describe('DurableMediaRecacheObserver', () => {
  it('ignores local reads and schedules non-local reads without awaiting PostgreSQL', () => {
    const pending = new Promise<boolean>(() => undefined);
    const enqueueRecacheOnAccess = vi.fn(() => pending);
    const observer = new DurableMediaRecacheObserver({
      enqueueRecacheOnAccess,
    } as unknown as PostgresMediaCacheCommandQueue);

    expect(observer.observe('object-1', 'local')).toBeUndefined();
    expect(observer.observe('object-1', 's3-default')).toBeUndefined();

    expect(enqueueRecacheOnAccess).toHaveBeenCalledTimes(1);
    expect(enqueueRecacheOnAccess).toHaveBeenCalledWith({
      objectId: 'object-1',
      sourceBackendId: 's3-default',
    });
  });

  it('contains a scheduler rejection after public delivery succeeds', async () => {
    const enqueueRecacheOnAccess = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    const observer = new DurableMediaRecacheObserver({
      enqueueRecacheOnAccess,
    } as unknown as PostgresMediaCacheCommandQueue);

    expect(observer.observe('object-1', 's3-default')).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(enqueueRecacheOnAccess).toHaveBeenCalledOnce();
  });
});
