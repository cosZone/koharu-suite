import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalMediaBlobStore,
  type MediaBlobIdentity,
  type MediaBlobReadHandle,
} from '../src/media-cache/blob-store.js';
import {
  copyPersistentBlob,
  LocalPersistentBlobBackend,
  type PersistentBlobBackend,
  PersistentBlobBackendRegistry,
  type PersistentBlobPutInput,
} from '../src/media-cache/local-persistent-blob-backend.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function identity(content: Buffer): MediaBlobIdentity {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    byteLength: content.byteLength,
    relativeKey: `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`,
    sha256,
  };
}

function stream(content: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(content);
      controller.close();
    },
  });
}

async function consume(source: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function localBackend(): Promise<LocalPersistentBlobBackend> {
  const root = await mkdtemp(join(tmpdir(), 'koharu-persistent-blob-'));
  roots.push(root);
  const store = new LocalMediaBlobStore(root);
  await store.initialize();
  return new LocalPersistentBlobBackend(store);
}

function fakeBackend(input: {
  close?: () => Promise<void>;
  content?: Buffer;
  id: PersistentBlobBackend['id'];
  put?: (input: PersistentBlobPutInput) => Promise<{ outcome: 'already_present' | 'created' }>;
}): PersistentBlobBackend {
  const content = input.content ?? Buffer.from('fake persistent content');
  return {
    id: input.id,
    async delete() {
      return 'absent_or_deleted';
    },
    put:
      input.put ??
      (async (putInput) => {
        await consume(putInput.source);
        return { outcome: 'created' };
      }),
    async read(): Promise<MediaBlobReadHandle> {
      let streamed = false;
      return {
        byteLength: content.byteLength,
        close: input.close ?? (async () => undefined),
        stream() {
          if (streamed) throw new Error('single-use fake handle');
          streamed = true;
          return stream(content);
        },
      };
    },
  };
}

describe('persistent media blob backends', () => {
  it('copies a verified local blob to a persistent target', async () => {
    const content = Buffer.from('local to fake S3');
    const blob = identity(content);
    const local = await localBackend();
    await local.put({ identity: blob, source: stream(content) });
    const put = vi.fn(async (input: PersistentBlobPutInput) => {
      expect(await consume(input.source)).toEqual(content);
      return { outcome: 'created' as const };
    });
    const s3 = fakeBackend({ id: 's3-default', put });

    await expect(
      copyPersistentBlob({ identity: blob, source: local, target: s3 }),
    ).resolves.toEqual({ outcome: 'created' });
    expect(put).toHaveBeenCalledOnce();
  });

  it('restores a verified persistent blob into the local store idempotently', async () => {
    const content = Buffer.from('fake S3 to local');
    const blob = identity(content);
    const local = await localBackend();
    const s3 = fakeBackend({ content, id: 's3-default' });

    await expect(
      copyPersistentBlob({ identity: blob, source: s3, target: local }),
    ).resolves.toEqual({ outcome: 'created' });
    await expect(
      copyPersistentBlob({ identity: blob, source: s3, target: local }),
    ).resolves.toEqual({ outcome: 'already_present' });
    const restored = await local.read(blob);
    try {
      await expect(consume(restored.stream())).resolves.toEqual(content);
    } finally {
      await restored.close();
    }
  });

  it('rejects a copied body that does not match the expected identity', async () => {
    const expected = identity(Buffer.from('expected'));
    const local = await localBackend();
    const wrongSource = fakeBackend({
      content: Buffer.from('wrong!!!'),
      id: 's3-default',
    });

    await expect(
      copyPersistentBlob({ identity: expected, source: wrongSource, target: local }),
    ).rejects.toThrow('expected identity');
    await expect(local.read(expected)).rejects.toThrow();
  });

  it('always closes source handles after target success and failure', async () => {
    const content = Buffer.from('handle ownership');
    const blob = identity(content);
    const closeAfterSuccess = vi.fn(async () => undefined);
    const closeAfterFailure = vi.fn(async () => undefined);
    const target = fakeBackend({ id: 'local' });

    await copyPersistentBlob({
      identity: blob,
      source: fakeBackend({ close: closeAfterSuccess, content, id: 's3-default' }),
      target,
    });
    await expect(
      copyPersistentBlob({
        identity: blob,
        source: fakeBackend({ close: closeAfterFailure, content, id: 's3-default' }),
        target: fakeBackend({
          id: 'local',
          put: async () => {
            throw new Error('target unavailable');
          },
        }),
      }),
    ).rejects.toThrow('target unavailable');

    expect(closeAfterSuccess).toHaveBeenCalledOnce();
    expect(closeAfterFailure).toHaveBeenCalledOnce();
  });

  it('surfaces a close failure after a provider reports success', async () => {
    const content = Buffer.from('close failure');
    const blob = identity(content);
    const source = fakeBackend({
      close: async () => {
        throw new Error('close failed');
      },
      content,
      id: 's3-default',
    });

    await expect(
      copyPersistentBlob({
        identity: blob,
        source,
        target: fakeBackend({ id: 'local' }),
      }),
    ).rejects.toThrow('close failed');
  });

  it('fails closed for duplicate, unknown, and same-backend registry routes', () => {
    const local = fakeBackend({ id: 'local' });
    const s3 = fakeBackend({ id: 's3-default' });
    const registry = new PersistentBlobBackendRegistry([local, s3]);

    expect(registry.pair('local', 's3-default')).toEqual({ source: local, target: s3 });
    expect(() => registry.pair('local', 'local')).toThrow('Only local and s3-default');
    expect(() => registry.get('provider-private')).toThrow('Unsupported');
    expect(() => new PersistentBlobBackendRegistry([local, local])).toThrow('Duplicate');
  });
});
