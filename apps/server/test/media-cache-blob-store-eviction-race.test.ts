import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lstatRace = vi.hoisted(() => ({
  active: false,
  reached: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      if (lstatRace.active) {
        lstatRace.active = false;
        lstatRace.reached?.();
        await lstatRace.wait;
      }
      return actual.lstat(path);
    },
  };
});

import { LocalMediaBlobStore } from '../src/media-cache/blob-store.js';

const roots: string[] = [];

afterEach(async () => {
  lstatRace.active = false;
  lstatRace.reached = undefined;
  lstatRace.wait = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('LocalMediaBlobStore eviction races', () => {
  it('durably succeeds when another worker removes the canonical file after open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'koharu-media-eviction-race-'));
    roots.push(root);
    const store = new LocalMediaBlobStore(root);
    await store.initialize();
    const staged = await store.stage({
      lease: {
        leaseToken: randomUUID(),
        planId: randomUUID(),
      },
      maxBytes: 1024,
      objectId: randomUUID(),
      source: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('two workers, one canonical blob'));
          controller.close();
        },
      }),
    });
    const published = await store.publish(staged);
    await store.settle(staged, 'db_committed');
    const blobPath = join(root, published.relativeKey);
    let releaseLstat: (() => void) | undefined;
    const lstatReached = new Promise<void>((resolve) => {
      lstatRace.reached = resolve;
    });
    lstatRace.wait = new Promise<void>((resolve) => {
      releaseLstat = resolve;
    });
    lstatRace.active = true;

    const eviction = store.evict(published);
    await lstatReached;
    await rm(blobPath);
    releaseLstat?.();

    await expect(eviction).resolves.toBe('absent');
    await expect(readFile(blobPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
