import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalMediaBlobStore,
  MediaBlobIntegrityError,
  MediaBlobLeaseDiscardedError,
  MediaBlobTooLargeError,
} from '../src/media-cache/blob-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), 'koharu-media-cache-'));
  roots.push(root);
  const store = new LocalMediaBlobStore(root);
  await store.initialize();
  return { root, store };
}

function identifiers() {
  return {
    lease: {
      leaseToken: randomUUID(),
      planId: randomUUID(),
    },
    objectId: randomUUID(),
  };
}

function chunks(...values: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of values) {
        controller.enqueue(Buffer.from(value));
      }
      controller.close();
    },
  });
}

describe('LocalMediaBlobStore', () => {
  it('streams a staged blob into an immutable content-addressed file', async () => {
    const { root, store } = await createStore();
    const content = 'koharu-suite';
    const expectedHash = createHash('sha256').update(content).digest('hex');

    const staged = await store.stage({
      ...identifiers(),
      maxBytes: Buffer.byteLength(content),
      source: chunks('koharu', '-', 'suite'),
    });
    const published = await store.publish(staged);

    expect(staged).toMatchObject({
      byteLength: Buffer.byteLength(content),
      sha256: expectedHash,
    });
    expect(published).toEqual({
      byteLength: Buffer.byteLength(content),
      outcome: 'created',
      relativeKey: `blobs/${expectedHash.slice(0, 2)}/${expectedHash.slice(2, 4)}/${expectedHash}`,
      sha256: expectedHash,
    });
    expect(await readFile(join(root, published.relativeKey), 'utf8')).toBe(content);
    expect(await store.recoverLease(staged.lease)).toMatchObject([staged]);

    await store.settle(staged, 'db_committed');

    expect(await store.recoverLease(staged.lease)).toEqual([]);
    expect(await readFile(join(root, published.relativeKey), 'utf8')).toBe(content);
    const opened = await store.open(published);
    await expect(opened.readFile('utf8')).resolves.toBe(content);
    await opened.close();
  });

  it('cancels upstream and removes partial bytes when the stream exceeds the hard limit', async () => {
    const { store } = await createStore();
    const identity = identifiers();
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        controller.enqueue(Buffer.from('123456'));
      },
    });

    await expect(
      store.stage({
        ...identity,
        maxBytes: 5,
        source,
      }),
    ).rejects.toBeInstanceOf(MediaBlobTooLargeError);

    expect(cancelled).toBe(true);
    expect(await store.discardPartialLease(identity.lease)).toEqual({
      removedBytes: 0,
      removedFiles: 0,
    });
    expect(await store.recoverLease(identity.lease)).toEqual([]);
  });

  it('atomically deduplicates identical content staged by different leases', async () => {
    const { root, store } = await createStore();
    const first = await store.stage({
      ...identifiers(),
      maxBytes: 1024,
      source: chunks('same bytes'),
    });
    const second = await store.stage({
      ...identifiers(),
      maxBytes: 1024,
      source: chunks('same ', 'bytes'),
    });

    const [firstPublished, secondPublished] = await Promise.all([
      store.publish(first),
      store.publish(second),
    ]);

    expect([firstPublished.outcome, secondPublished.outcome].sort()).toEqual([
      'already_present',
      'created',
    ]);
    expect(secondPublished).toMatchObject({
      ...firstPublished,
      outcome: expect.any(String),
    });

    const creator = firstPublished.outcome === 'created' ? first : second;
    const loser = creator === first ? second : first;
    await store.settle(loser, 'db_rolled_back');
    expect(await readFile(join(root, firstPublished.relativeKey), 'utf8')).toBe('same bytes');
    await store.settle(creator, 'db_committed');
  });

  it('recovers and rolls back only a superseded lease before an immediate takeover', async () => {
    const { store } = await createStore();
    const planId = randomUUID();
    const supersededLease = {
      leaseToken: randomUUID(),
      planId,
    };
    const activeLease = {
      leaseToken: randomUUID(),
      planId,
    };

    const superseded = await store.stage({
      lease: supersededLease,
      maxBytes: 1024,
      objectId: randomUUID(),
      source: chunks('superseded'),
    });
    const active = await store.stage({
      lease: activeLease,
      maxBytes: 1024,
      objectId: randomUUID(),
      source: chunks('active'),
    });

    expect(await store.recoverLease(supersededLease)).toMatchObject([superseded]);
    await store.settle(superseded, 'db_rolled_back');
    expect(await store.recoverLease(supersededLease)).toEqual([]);
    expect(await store.recoverLease(activeLease)).toMatchObject([active]);

    const published = await store.publish(active);
    expect(published.byteLength).toBe(Buffer.byteLength('active'));
    await store.settle(active, 'db_committed');
  });

  it('recovers a published lease after restart and removes its owned final on DB rollback', async () => {
    const { root, store } = await createStore();
    const staged = await store.stage({
      ...identifiers(),
      maxBytes: 1024,
      source: chunks('rollback after crash'),
    });
    const published = await store.publish(staged);
    const restarted = new LocalMediaBlobStore(root);
    await restarted.initialize();
    const [recovered] = await restarted.recoverLease(staged.lease);

    expect(recovered).toMatchObject(staged);
    if (!recovered) {
      throw new Error('Expected the published staging record to be recoverable');
    }
    await restarted.settle(recovered, 'db_rolled_back');

    await expect(readFile(join(root, published.relativeKey))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await restarted.recoverLease(staged.lease)).toEqual([]);
  });

  it('recovers a published lease after restart and preserves its final on DB commit', async () => {
    const { root, store } = await createStore();
    const staged = await store.stage({
      ...identifiers(),
      maxBytes: 1024,
      source: chunks('commit after crash'),
    });
    const published = await store.publish(staged);
    const restarted = new LocalMediaBlobStore(root);
    await restarted.initialize();
    const [recovered] = await restarted.recoverLease(staged.lease);

    if (!recovered) {
      throw new Error('Expected the published staging record to be recoverable');
    }
    await restarted.settle(recovered, 'db_committed');

    expect(await readFile(join(root, published.relativeKey), 'utf8')).toBe('commit after crash');
  });

  it('aborts a pending read, cancels its source, and leaves no recoverable staging', async () => {
    const { store } = await createStore();
    const identity = identifiers();
    const abortController = new AbortController();
    const abortReason = new Error('stop media download');
    let cancelledWith: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelledWith = reason;
      },
      start(controller) {
        controller.enqueue(Buffer.from('first'));
      },
    });

    const staging = store.stage({
      ...identity,
      maxBytes: 1024,
      signal: abortController.signal,
      source,
    });
    setTimeout(() => abortController.abort(abortReason), 0);

    await expect(staging).rejects.toBe(abortReason);

    expect(cancelledWith).toBe(abortReason);
    expect(await store.recoverLease(identity.lease)).toEqual([]);
    expect(await store.discardPartialLease(identity.lease)).toEqual({
      removedBytes: 0,
      removedFiles: 0,
    });
  });

  it('does not create staging directories for invalid identifiers or limits', async () => {
    const { root, store } = await createStore();
    const identity = identifiers();

    await expect(
      store.stage({
        ...identity,
        lease: { ...identity.lease, planId: '../escape' },
        maxBytes: 1024,
        source: chunks('never read'),
      }),
    ).rejects.toThrow('planId must be a canonical lowercase UUID');
    await expect(
      store.stage({
        ...identity,
        maxBytes: 0,
        source: chunks('never read'),
      }),
    ).rejects.toThrow('maxBytes must be a positive safe integer');

    expect(await readdir(join(root, '.tmp'))).toEqual([]);
  });

  it('never overwrites a completed staging marker for the same lease and object', async () => {
    const { store } = await createStore();
    const identity = identifiers();
    const first = await store.stage({
      ...identity,
      maxBytes: 1024,
      source: chunks('first'),
    });

    await expect(
      store.stage({
        ...identity,
        maxBytes: 1024,
        source: chunks('second'),
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await store.recoverLease(identity.lease)).toMatchObject([first]);

    await store.settle(first, 'db_rolled_back');
  });

  it('cleans a crash-left partial without treating it as completed staging', async () => {
    const { root } = await createStore();
    const identity = identifiers();
    const leaseDirectory = join(root, '.tmp', identity.lease.planId, identity.lease.leaseToken);
    await mkdir(leaseDirectory, { recursive: true });
    await writeFile(join(leaseDirectory, `${identity.objectId}.part`), 'partial');
    const restarted = new LocalMediaBlobStore(root);
    await restarted.initialize();

    expect(await restarted.recoverLease(identity.lease)).toEqual([]);
    expect(await restarted.discardPartialLease(identity.lease)).toEqual({
      removedBytes: Buffer.byteLength('partial'),
      removedFiles: 1,
    });
  });

  it('aborts and awaits an active writer before partial lease cleanup returns', async () => {
    const { root, store } = await createStore();
    const identity = identifiers();
    let cancelledWith: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelledWith = reason;
      },
      start(controller) {
        controller.enqueue(Buffer.from('allocated partial bytes'));
      },
    });
    const staging = store.stage({
      ...identity,
      maxBytes: 1024,
      source,
    });
    const stagingResult = staging.then(
      () => new Error('Expected active staging to be discarded'),
      (error: unknown) => error,
    );
    const partialPath = join(
      root,
      '.tmp',
      identity.lease.planId,
      identity.lease.leaseToken,
      `${identity.objectId}.part`,
    );
    await waitForFile(partialPath);

    expect(await store.discardPartialLease(identity.lease)).toEqual({
      removedBytes: 0,
      removedFiles: 0,
    });
    expect(await stagingResult).toBeInstanceOf(MediaBlobLeaseDiscardedError);

    expect(cancelledWith).toBeInstanceOf(MediaBlobLeaseDiscardedError);
    await expect(stat(partialPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fences new writers as soon as lease cleanup begins', async () => {
    const { root, store } = await createStore();
    const identity = identifiers();

    const cleanup = store.discardPartialLease(identity.lease);
    const lateStage = store.stage({
      ...identity,
      maxBytes: 1024,
      source: chunks('must never be written'),
    });

    await expect(lateStage).rejects.toBeInstanceOf(MediaBlobLeaseDiscardedError);
    await expect(cleanup).resolves.toEqual({ removedBytes: 0, removedFiles: 0 });
    expect(await readdir(join(root, '.tmp'))).toEqual([]);
  });

  it('fails closed when an existing content-addressed path has different bytes', async () => {
    const { root, store } = await createStore();
    const staged = await store.stage({
      ...identifiers(),
      maxBytes: 1024,
      source: chunks('expected bytes'),
    });
    const relativeKey = `blobs/${staged.sha256.slice(0, 2)}/${staged.sha256.slice(2, 4)}/${staged.sha256}`;
    await mkdir(join(root, relativeKey, '..'), { recursive: true });
    await writeFile(join(root, relativeKey), 'wrong bytes');

    await expect(store.publish(staged)).rejects.toBeInstanceOf(MediaBlobIntegrityError);
    expect(await store.recoverLease(staged.lease)).toMatchObject([staged]);
  });

  it('rejects a staging directory symlink that escapes the cache root', async () => {
    const { root, store } = await createStore();
    const outside = await mkdtemp(join(tmpdir(), 'koharu-media-outside-'));
    roots.push(outside);
    const identity = identifiers();
    await symlink(outside, join(root, '.tmp', identity.lease.planId), 'dir');

    await expect(
      store.stage({
        ...identity,
        maxBytes: 1024,
        source: chunks('must stay contained'),
      }),
    ).rejects.toBeInstanceOf(MediaBlobIntegrityError);
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects a final directory symlink that escapes the cache root', async () => {
    const { root, store } = await createStore();
    const outside = await mkdtemp(join(tmpdir(), 'koharu-media-outside-'));
    roots.push(outside);
    const staged = await store.stage({
      ...identifiers(),
      maxBytes: 1024,
      source: chunks('must stay contained'),
    });
    await rm(join(root, 'blobs'), { recursive: true });
    await symlink(outside, join(root, 'blobs'), 'dir');

    await expect(store.publish(staged)).rejects.toBeInstanceOf(MediaBlobIntegrityError);
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses to open a ready path that was replaced with a symlink', async () => {
    const { root, store } = await createStore();
    const outside = await mkdtemp(join(tmpdir(), 'koharu-media-outside-'));
    roots.push(outside);
    const staged = await store.stage({
      ...identifiers(),
      maxBytes: 1024,
      source: chunks('ready bytes'),
    });
    const published = await store.publish(staged);
    await store.settle(staged, 'db_committed');
    const outsideFile = join(outside, 'replacement');
    await writeFile(outsideFile, 'ready bytes');
    const finalPath = join(root, published.relativeKey);
    await rm(finalPath);
    await symlink(outsideFile, finalPath, 'file');

    await expect(store.open(published)).rejects.toBeInstanceOf(MediaBlobIntegrityError);
  });
});

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the active staging file');
}
