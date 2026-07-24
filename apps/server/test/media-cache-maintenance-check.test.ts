import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  type MediaBlobIdentity,
  MediaBlobIntegrityError,
  type MediaBlobReadHandle,
} from '../src/media-cache/blob-store.js';
import { checkMediaCacheBlob } from '../src/media-cache/maintenance-service.js';

function identity(content: Uint8Array): MediaBlobIdentity {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    byteLength: content.byteLength,
    relativeKey: `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`,
    sha256,
  };
}

function handle(stream: ReadableStream<Uint8Array>, byteLength: number) {
  const close = vi.fn(async () => undefined);
  return {
    close,
    value: {
      byteLength,
      close,
      stream: () => stream,
    } satisfies MediaBlobReadHandle,
  };
}

describe('media cache maintenance blob checks', () => {
  it('accepts a complete blob and closes its backend handle', async () => {
    const content = Buffer.from('verified');
    const opened = handle(
      new ReadableStream({
        start(controller) {
          controller.enqueue(content);
          controller.close();
        },
      }),
      content.byteLength,
    );

    await expect(
      checkMediaCacheBlob({ read: vi.fn(async () => opened.value) }, identity(content)),
    ).resolves.toBeNull();
    expect(opened.close).toHaveBeenCalledOnce();
  });

  it('classifies a short backend body as a checksum mismatch instead of aborting reconcile', async () => {
    const content = Buffer.from('expected bytes');
    const opened = handle(
      new ReadableStream({
        start(controller) {
          controller.error(
            new MediaBlobIntegrityError('Media blob ended before its expected byte length'),
          );
        },
      }),
      content.byteLength,
    );

    await expect(
      checkMediaCacheBlob({ read: vi.fn(async () => opened.value) }, identity(content)),
    ).resolves.toBe('checksum_mismatch');
    expect(opened.close).toHaveBeenCalledOnce();
  });

  it('classifies an absent backend object as missing', async () => {
    const content = Buffer.from('missing');
    const missing = Object.assign(new Error('not found'), { code: 'ENOENT' });

    await expect(
      checkMediaCacheBlob(
        {
          read: vi.fn(async () => {
            throw missing;
          }),
        },
        identity(content),
      ),
    ).resolves.toBe('missing');
  });
});
