import { describe, expect, it, vi } from 'vitest';
import {
  MediaCacheAccessCoalescer,
  type MediaCacheAccessWriter,
} from '../src/media-cache/access-coalescer.js';

const FIRST_HASH = 'a'.repeat(64);
const SECOND_HASH = 'b'.repeat(64);

function hashFor(index: number): string {
  return index.toString(16).padStart(64, '0');
}

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

  it('flushes more than 100 shared blobs in stable SHA batches', async () => {
    const observedAt = new Date('2026-07-24T10:00:00.000Z');
    const write = vi.fn<MediaCacheAccessWriter['writeAccesses']>(async () => undefined);
    const coalescer = new MediaCacheAccessCoalescer({ writeAccesses: write }, () => observedAt);
    const hashes = Array.from({ length: 205 }, (_, index) => hashFor(204 - index));
    for (const sha256 of hashes) {
      coalescer.observe(sha256, observedAt);
    }

    await coalescer.flush();

    expect(write.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 5]);
    expect(write.mock.calls.flatMap(([batch]) => batch.map((access) => access.sha256))).toEqual(
      hashes.sort(),
    );
  });

  it('retries only the failed and later access batches', async () => {
    const observedAt = new Date('2026-07-24T10:00:00.000Z');
    const write = vi
      .fn<MediaCacheAccessWriter['writeAccesses']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second batch unavailable'))
      .mockResolvedValue(undefined);
    const coalescer = new MediaCacheAccessCoalescer({ writeAccesses: write }, () => observedAt);
    for (let index = 0; index < 150; index += 1) {
      coalescer.observe(hashFor(index), observedAt);
    }

    await expect(coalescer.flush()).rejects.toThrow('second batch unavailable');
    await expect(coalescer.flush()).resolves.toBeUndefined();

    expect(write.mock.calls.map(([batch]) => batch.length)).toEqual([100, 50, 50]);
    expect(write.mock.calls[2]?.[0].map((access) => access.sha256)).toEqual(
      Array.from({ length: 50 }, (_, index) => hashFor(index + 100)),
    );
  });
});
