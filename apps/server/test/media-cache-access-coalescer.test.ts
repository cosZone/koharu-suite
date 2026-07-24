import { describe, expect, it, vi } from 'vitest';
import {
  MediaCacheAccessCoalescer,
  type MediaCacheAccessWriter,
} from '../src/media-cache/access-coalescer.js';

const FIRST_HASH = 'a'.repeat(64);
const SECOND_HASH = 'b'.repeat(64);

describe('MediaCacheAccessCoalescer', () => {
  it('writes only the newest observed access for each shared blob', async () => {
    let now = new Date('2026-07-24T10:00:00.000Z');
    const write = vi.fn<MediaCacheAccessWriter['writeAccesses']>(async () => undefined);
    const coalescer = new MediaCacheAccessCoalescer({ writeAccesses: write }, () => now);

    coalescer.observe(FIRST_HASH, new Date('2026-07-24T09:59:00.000Z'));
    coalescer.observe(FIRST_HASH, new Date('2026-07-24T10:00:01.000Z'));
    coalescer.observe(FIRST_HASH, new Date('2026-07-24T09:59:30.000Z'));
    coalescer.observe(SECOND_HASH, new Date('2026-07-24T10:00:00.000Z'));
    await coalescer.flush();

    expect(write).toHaveBeenCalledWith([
      { observedAt: new Date('2026-07-24T10:00:01.000Z'), sha256: FIRST_HASH },
      { observedAt: new Date('2026-07-24T10:00:00.000Z'), sha256: SECOND_HASH },
    ]);

    now = new Date('2026-07-24T10:04:59.999Z');
    coalescer.observe(FIRST_HASH, now);
    await coalescer.flush();
    expect(write).toHaveBeenCalledOnce();

    now = new Date('2026-07-24T10:05:00.000Z');
    coalescer.observe(FIRST_HASH, now);
    await coalescer.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith([{ observedAt: now, sha256: FIRST_HASH }]);
  });

  it('keeps pending accesses after a write failure and retries them', async () => {
    const write = vi
      .fn<MediaCacheAccessWriter['writeAccesses']>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(undefined);
    const coalescer = new MediaCacheAccessCoalescer(
      { writeAccesses: write },
      () => new Date('2026-07-24T10:00:00.000Z'),
    );
    const observedAt = new Date('2026-07-24T09:59:00.000Z');
    coalescer.observe(FIRST_HASH, observedAt);

    await expect(coalescer.flush()).rejects.toThrow('database unavailable');
    await expect(coalescer.flush()).resolves.toBeUndefined();

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith([{ observedAt, sha256: FIRST_HASH }]);
  });

  it('does not lose a newer access observed while a flush is in flight', async () => {
    let releaseWrite: (() => void) | undefined;
    let now = new Date('2026-07-24T10:00:00.000Z');
    const write = vi.fn<MediaCacheAccessWriter['writeAccesses']>(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );
    const coalescer = new MediaCacheAccessCoalescer({ writeAccesses: write }, () => now);
    coalescer.observe(FIRST_HASH, now);
    const flushing = coalescer.flush();

    const newer = new Date('2026-07-24T10:01:00.000Z');
    coalescer.observe(FIRST_HASH, newer);
    releaseWrite?.();
    await flushing;

    now = new Date('2026-07-24T10:05:00.000Z');
    write.mockResolvedValue(undefined);
    await coalescer.flush();

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith([{ observedAt: newer, sha256: FIRST_HASH }]);
  });
});
