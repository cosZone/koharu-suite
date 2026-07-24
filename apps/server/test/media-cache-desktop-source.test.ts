import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DesktopMediaSource,
  DesktopMediaSourceTooLargeError,
  DesktopMediaSourceUnavailableError,
} from '../src/media-cache/desktop-source.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createFixture() {
  const parent = await mkdtemp(join(tmpdir(), 'koharu-desktop-source-'));
  temporaryDirectories.push(parent);
  const root = join(parent, 'export');
  const outside = join(parent, 'outside');
  await mkdir(join(root, 'photos'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, 'photos', 'photo 1.jpg'), 'desktop bytes');
  return { outside, parent, root };
}

async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('DesktopMediaSource', () => {
  it('opens a contained export file as a bounded stream without returning its path', async () => {
    const { root } = await createFixture();
    const source = new DesktopMediaSource();

    const opened = await source.open({
      desktopRoot: root,
      maxBytes: 1024,
      sourcePath: 'photos/photo 1.jpg',
    });

    expect(opened.declaredBytes).toBe(BigInt(Buffer.byteLength('desktop bytes')));
    expect(Object.keys(opened).sort()).toEqual(['declaredBytes', 'stream']);
    expect(opened).not.toHaveProperty('path');
    expect(opened).not.toHaveProperty('desktopRoot');
    await expect(read(opened.stream)).resolves.toBe('desktop bytes');
  });

  it('rejects a symlink that escapes the canonical export root', async () => {
    const { outside, root } = await createFixture();
    const secretPath = join(outside, 'secret.jpg');
    await writeFile(secretPath, 'outside secret');
    await symlink(secretPath, join(root, 'photos', 'escape.jpg'));
    const source = new DesktopMediaSource();

    const opened = source.open({
      desktopRoot: root,
      maxBytes: 1024,
      sourcePath: 'photos/escape.jpg',
    });

    await expect(opened).rejects.toBeInstanceOf(DesktopMediaSourceUnavailableError);
    await expect(opened).rejects.toMatchObject({ code: 'desktop_media_source_unavailable' });
    await expect(opened).rejects.not.toHaveProperty('message', expect.stringContaining(root));
    await expect(opened).rejects.not.toHaveProperty('message', expect.stringContaining(outside));
  });

  it.each([
    '',
    '.',
    '..',
    '../photo.jpg',
    'photos/../photo.jpg',
    '/tmp/photo.jpg',
    String.raw`C:\photo.jpg`,
    String.raw`photos\photo.jpg`,
    'file:///tmp/photo.jpg',
    'https://example.com/photo.jpg',
  ])('rejects unsafe Desktop source path %j before filesystem access', async (sourcePath) => {
    const { root } = await createFixture();
    const source = new DesktopMediaSource();

    await expect(
      source.open({
        desktopRoot: root,
        maxBytes: 1024,
        sourcePath,
      }),
    ).rejects.toBeInstanceOf(DesktopMediaSourceUnavailableError);
  });

  it('rejects an oversized Desktop file before returning its stream', async () => {
    const { root } = await createFixture();
    const source = new DesktopMediaSource();

    await expect(
      source.open({
        desktopRoot: root,
        maxBytes: 3,
        sourcePath: 'photos/photo 1.jpg',
      }),
    ).rejects.toMatchObject({
      code: 'desktop_media_source_too_large',
      declaredBytes: BigInt(Buffer.byteLength('desktop bytes')),
      maxBytes: 3,
    });
    await expect(
      source.open({
        desktopRoot: root,
        maxBytes: 3,
        sourcePath: 'photos/photo 1.jpg',
      }),
    ).rejects.toBeInstanceOf(DesktopMediaSourceTooLargeError);
  });

  it('propagates cancellation without exposing the local path', async () => {
    const { root } = await createFixture();
    const source = new DesktopMediaSource();
    const abortController = new AbortController();
    const reason = new DOMException('stop local import', 'AbortError');
    abortController.abort(reason);

    await expect(
      source.open({
        desktopRoot: root,
        maxBytes: 1024,
        signal: abortController.signal,
        sourcePath: 'photos/photo 1.jpg',
      }),
    ).rejects.toBe(reason);
  });
});
