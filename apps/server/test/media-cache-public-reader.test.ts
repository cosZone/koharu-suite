import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalMediaBlobStore } from '../src/media-cache/blob-store.js';
import {
  LocalPublicMediaReader,
  type PublicMediaObjectRepository,
} from '../src/media-cache/public-reader.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function chunks(value: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(value));
      controller.close();
    },
  });
}

async function fixture(content = '0123456789') {
  const root = await mkdtemp(join(tmpdir(), 'koharu-public-media-'));
  roots.push(root);
  const blobStore = new LocalMediaBlobStore(root);
  await blobStore.initialize();
  const staged = await blobStore.stage({
    lease: { leaseToken: randomUUID(), planId: randomUUID() },
    maxBytes: 1024,
    objectId: randomUUID(),
    source: chunks(content),
  });
  const published = await blobStore.publish(staged);
  await blobStore.settle(staged, 'db_committed');
  const objectId = randomUUID();
  const repository: PublicMediaObjectRepository = {
    findReadyObject: vi.fn<PublicMediaObjectRepository['findReadyObject']>(async (requestedId) =>
      requestedId === objectId
        ? {
            byteLength: published.byteLength,
            detectedMime: 'image/jpeg',
            relativeKey: published.relativeKey,
            sha256: published.sha256,
            variant: 'original',
          }
        : null,
    ),
  };
  const accessObserver = { observe: vi.fn() };
  return {
    accessObserver,
    blobStore,
    objectId,
    reader: new LocalPublicMediaReader(repository, blobStore, accessObserver),
    repository,
  };
}

async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('LocalPublicMediaReader', () => {
  it('opens verified content by opaque object ID and observes shared blob access', async () => {
    const { accessObserver, objectId, reader } = await fixture();

    const opened = await reader.open(objectId);

    expect(opened).toMatchObject({
      byteLength: 10,
      contentType: 'image/jpeg',
      etag: `"media-${objectId}"`,
      variant: 'original',
    });
    expect(accessObserver.observe).toHaveBeenCalledOnce();
    await expect(read(opened?.stream() as ReadableStream<Uint8Array>)).resolves.toBe('0123456789');
  });

  it('streams an inclusive byte range from the already-open file handle', async () => {
    const { objectId, reader } = await fixture();
    const opened = await reader.open(objectId);

    await expect(
      read(opened?.stream({ end: 6, length: 4, start: 3 }) as ReadableStream<Uint8Array>),
    ).resolves.toBe('3456');
  });

  it('returns null for unknown objects and ready rows whose file is absent', async () => {
    const { blobStore, objectId, reader, repository } = await fixture();
    await expect(reader.open(randomUUID())).resolves.toBeNull();
    const object = await repository.findReadyObject(objectId);
    if (!object) {
      throw new Error('Expected a ready fixture object');
    }
    await blobStore.evict(object);

    await expect(reader.open(objectId)).resolves.toBeNull();
  });

  it('allows HEAD-style callers to close without starting a stream', async () => {
    const { objectId, reader } = await fixture();
    const opened = await reader.open(objectId);

    await expect(opened?.close()).resolves.toBeUndefined();
    expect(() => opened?.stream()).toThrow('already consumed');
  });
});
