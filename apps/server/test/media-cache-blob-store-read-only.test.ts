import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalMediaBlobStore, MediaBlobIntegrityError } from '../src/media-cache/blob-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }),
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('LocalMediaBlobStore read-only initialization', () => {
  it('validates a prepared read-only layout without changing it', async () => {
    const root = await temporaryRoot('koharu-media-reader-');
    await Promise.all([mkdir(join(root, '.tmp')), mkdir(join(root, 'blobs'))]);
    await Promise.all([
      chmod(root, 0o500),
      chmod(join(root, '.tmp'), 0o500),
      chmod(join(root, 'blobs'), 0o500),
    ]);
    const before = await Promise.all(
      [root, join(root, '.tmp'), join(root, 'blobs')].map(async (path) => {
        const metadata = await stat(path);
        return { mode: metadata.mode, mtimeMs: metadata.mtimeMs };
      }),
    );

    await expect(new LocalMediaBlobStore(root).initializeReadOnly()).resolves.toBeUndefined();

    expect((await readdir(root)).sort()).toEqual(['.tmp', 'blobs']);
    const after = await Promise.all(
      [root, join(root, '.tmp'), join(root, 'blobs')].map(async (path) => {
        const metadata = await stat(path);
        return { mode: metadata.mode, mtimeMs: metadata.mtimeMs };
      }),
    );
    expect(after).toEqual(before);
  });

  it('fails closed instead of creating a missing required directory', async () => {
    const root = await temporaryRoot('koharu-media-reader-missing-');
    await mkdir(join(root, 'blobs'));
    await Promise.all([chmod(root, 0o500), chmod(join(root, 'blobs'), 0o500)]);

    await expect(new LocalMediaBlobStore(root).initializeReadOnly()).rejects.toBeInstanceOf(
      MediaBlobIntegrityError,
    );
    await expect(stat(join(root, '.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a required directory that resolves outside the cache root', async () => {
    const root = await temporaryRoot('koharu-media-reader-escape-');
    const outside = await temporaryRoot('koharu-media-reader-outside-');
    await mkdir(join(root, '.tmp'));
    await symlink(outside, join(root, 'blobs'));

    await expect(new LocalMediaBlobStore(root).initializeReadOnly()).rejects.toBeInstanceOf(
      MediaBlobIntegrityError,
    );
  });
});
