import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createThumbnailSource, ThumbnailGenerationError } from '../src/media-cache/thumbnail.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function openFixture(contents: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), 'koharu-thumbnail-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'fixture');
  await writeFile(path, contents);
  return open(path, 'r');
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

describe('bounded media cache thumbnail source', () => {
  it('streams a static WebP, auto-orients it, and strips input metadata', async () => {
    const orientedJpeg = await sharp({
      create: {
        background: { b: 30, g: 20, r: 10 },
        channels: 3,
        height: 1,
        width: 2,
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const file = await openFixture(orientedJpeg);

    const thumbnail = createThumbnailSource(file, { mimeType: 'image/jpeg' });
    const output = await readAll(thumbnail.stream);
    const result = await thumbnail.result;
    const metadata = await sharp(output).metadata();

    expect(result).toMatchObject({
      byteLength: output.byteLength,
      format: 'webp',
      height: 2,
      width: 1,
    });
    expect(metadata).toMatchObject({
      format: 'webp',
      height: 2,
      width: 1,
    });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    await expect(file.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('keeps a small image within its original dimensions and returns bounded output metadata', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const file = await openFixture(png);

    const thumbnail = createThumbnailSource(file, { mimeType: 'image/png' });
    const output = await readAll(thumbnail.stream);

    await expect(thumbnail.result).resolves.toMatchObject({
      byteLength: output.byteLength,
      format: 'webp',
      height: 1,
      width: 1,
    });
    expect(output.byteLength).toBeLessThanOrEqual(1024 * 1024);
  });

  it('rejects a video before starting Sharp and leaves ownership with the caller', async () => {
    const file = await openFixture(Buffer.from('not read'));

    expect(() => createThumbnailSource(file, { mimeType: 'video/mp4' })).toThrow(
      ThumbnailGenerationError,
    );
    await expect(file.stat()).resolves.toMatchObject({ size: 8 });
    await file.close();
  });

  it('rejects corrupt raster input with a stable sanitized code and closes the file', async () => {
    const file = await openFixture(Buffer.from('corrupt image'));
    const thumbnail = createThumbnailSource(file, { mimeType: 'image/jpeg' });

    await expect(readAll(thumbnail.stream)).rejects.toMatchObject({
      code: 'thumbnail_unavailable',
      name: 'ThumbnailGenerationError',
    });
    await expect(thumbnail.result).rejects.toMatchObject({
      code: 'thumbnail_unavailable',
      name: 'ThumbnailGenerationError',
    });
    await expect(file.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('normalizes aborts on both the stream and result channels', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const file = await openFixture(png);
    const abortController = new AbortController();
    abortController.abort(new Error('private worker shutdown detail'));
    const thumbnail = createThumbnailSource(file, {
      mimeType: 'image/png',
      signal: abortController.signal,
    });

    await expect(readAll(thumbnail.stream)).rejects.toMatchObject({
      code: 'thumbnail_aborted',
      message: 'Thumbnail generation was aborted',
    });
    await expect(thumbnail.result).rejects.toMatchObject({
      code: 'thumbnail_aborted',
      message: 'Thumbnail generation was aborted',
    });
  });
});
