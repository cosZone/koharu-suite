import { describe, expect, it, vi } from 'vitest';
import {
  BackendAwareCommittedBlobReader,
  type CommittedBlobLocationRepository,
} from '../src/media-cache/backend-aware-reader.js';
import type {
  MediaBlobIdentity,
  MediaBlobReadHandle,
  MediaBlobReadRange,
} from '../src/media-cache/blob-store.js';
import {
  type PersistentBlobBackend,
  PersistentBlobBackendRegistry,
} from '../src/media-cache/local-persistent-blob-backend.js';

const identity: MediaBlobIdentity = {
  byteLength: 6,
  relativeKey: `blobs/${'a'.repeat(2)}/${'a'.repeat(2)}/${'a'.repeat(64)}`,
  sha256: 'a'.repeat(64),
};

function repository(...backendIds: string[]): CommittedBlobLocationRepository {
  return {
    async findReadableBackendIds(received) {
      expect(received).toEqual(identity);
      return backendIds;
    },
  };
}

function stream(chunks: readonly (Uint8Array | Error)[]): ReadableStream<Uint8Array> {
  const pending = [...chunks];
  return new ReadableStream({
    pull(controller) {
      const next = pending.shift();
      if (!next) {
        controller.close();
      } else if (next instanceof Error) {
        controller.error(next);
      } else {
        controller.enqueue(next);
      }
    },
  });
}

function backend(input: {
  close?: ReturnType<typeof vi.fn<() => Promise<void>>>;
  id: PersistentBlobBackend['id'];
  open?: (range?: MediaBlobReadRange) => ReadableStream<Uint8Array>;
  read?: () => Promise<MediaBlobReadHandle>;
}): PersistentBlobBackend {
  return {
    id: input.id,
    async delete() {
      return 'absent_or_deleted';
    },
    async put() {
      return { outcome: 'created' };
    },
    read:
      input.read ??
      (async () => ({
        byteLength: identity.byteLength,
        close: input.close ?? vi.fn(async () => undefined),
        stream: input.open ?? (() => stream([new TextEncoder().encode('koharu')])),
      })),
  };
}

async function consume(source: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

describe('backend-aware committed blob reader', () => {
  it('uses a local-only committed location and reports the successful backend', async () => {
    const observe = vi.fn();
    const local = backend({ id: 'local' });
    const reader = new BackendAwareCommittedBlobReader(
      repository('local'),
      new PersistentBlobBackendRegistry([local]),
      observe,
    );

    const handle = await reader.read(identity);
    await expect(consume(handle.stream())).resolves.toBe('koharu');
    expect(observe).toHaveBeenCalledExactlyOnceWith('local');
  });

  it('skips committed locations whose runtime backend is not loaded', async () => {
    const local = backend({ id: 'local' });
    const reader = new BackendAwareCommittedBlobReader(
      repository('s3-default', 'local'),
      new PersistentBlobBackendRegistry([local]),
    );

    await expect(consume((await reader.read(identity)).stream())).resolves.toBe('koharu');
  });

  it('falls back when read or stream initialization fails before the first byte', async () => {
    const failedClose = vi.fn(async () => undefined);
    const s3 = backend({
      close: failedClose,
      id: 's3-default',
      open() {
        throw new Error('endpoint=https://secret.example bucket=private');
      },
    });
    const local = backend({ id: 'local' });
    const observer = vi.fn();
    const readObserver = vi.fn();
    const reader = new BackendAwareCommittedBlobReader(
      repository('s3-default', 'local'),
      new PersistentBlobBackendRegistry([s3, local]),
      observer,
    );

    await expect(
      consume((await reader.read(identity, { observeBackend: readObserver })).stream()),
    ).resolves.toBe('koharu');
    expect(failedClose).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledExactlyOnceWith('local');
    expect(readObserver).toHaveBeenCalledExactlyOnceWith('local');

    const readFailure = backend({
      id: 's3-default',
      async read() {
        throw new Error('access key was rejected');
      },
    });
    const fallback = new BackendAwareCommittedBlobReader(
      repository('s3-default', 'local'),
      new PersistentBlobBackendRegistry([readFailure, local]),
    );
    await expect(consume((await fallback.read(identity)).stream())).resolves.toBe('koharu');
  });

  it('reuses the exact requested range for a fallback backend', async () => {
    const range = { end: 3, start: 1 };
    const firstRange = vi.fn((_range?: MediaBlobReadRange) =>
      stream([new Error('initial response failed')]),
    );
    const secondRange = vi.fn((_range?: MediaBlobReadRange) =>
      stream([new TextEncoder().encode('oha')]),
    );
    const reader = new BackendAwareCommittedBlobReader(
      repository('local', 's3-default'),
      new PersistentBlobBackendRegistry([
        backend({ id: 'local', open: firstRange }),
        backend({ id: 's3-default', open: secondRange }),
      ]),
    );

    await expect(consume((await reader.read(identity)).stream(range))).resolves.toBe('oha');
    expect(firstRange).toHaveBeenCalledExactlyOnceWith(range);
    expect(secondRange).toHaveBeenCalledExactlyOnceWith(range);
  });

  it('fails closed after emitting bytes and closes the failed handle', async () => {
    const firstClose = vi.fn(async () => undefined);
    const fallbackRead = vi.fn(async () => ({
      byteLength: identity.byteLength,
      close: vi.fn(async () => undefined),
      stream: () => stream([new TextEncoder().encode('koharu')]),
    }));
    const reader = new BackendAwareCommittedBlobReader(
      repository('s3-default', 'local'),
      new PersistentBlobBackendRegistry([
        backend({
          close: firstClose,
          id: 's3-default',
          open: () => stream([new TextEncoder().encode('ko'), new Error('socket failed')]),
        }),
        backend({ id: 'local', read: fallbackRead }),
      ]),
    );

    await expect(consume((await reader.read(identity)).stream())).rejects.toThrow(
      'Committed media blob is unavailable',
    );
    expect(firstClose).toHaveBeenCalledOnce();
    expect(fallbackRead).not.toHaveBeenCalled();
  });

  it('closes mismatched and failed handles before trying the next candidate', async () => {
    const mismatchedClose = vi.fn(async () => undefined);
    const streamFailureClose = vi.fn(async () => undefined);
    const reader = new BackendAwareCommittedBlobReader(
      repository('s3-default', 'local', 's3-default'),
      new PersistentBlobBackendRegistry([
        backend({
          id: 's3-default',
          async read() {
            return {
              byteLength: identity.byteLength - 1,
              close: mismatchedClose,
              stream: () => stream([]),
            };
          },
        }),
        backend({
          close: streamFailureClose,
          id: 'local',
          open: () => stream([new Error('read failed')]),
        }),
      ]),
    );

    const handle = await reader.read(identity);
    await expect(consume(handle.stream())).rejects.toThrow('Committed media blob is unavailable');
    expect(mismatchedClose).toHaveBeenCalledTimes(2);
    expect(streamFailureClose).toHaveBeenCalledOnce();
  });

  it('close is idempotent and never opens a fallback backend', async () => {
    const firstClose = vi.fn(async () => undefined);
    const fallbackRead = vi.fn(async () => {
      throw new Error('must not be called');
    });
    const reader = new BackendAwareCommittedBlobReader(
      repository('local', 's3-default'),
      new PersistentBlobBackendRegistry([
        backend({ close: firstClose, id: 'local' }),
        backend({ id: 's3-default', read: fallbackRead }),
      ]),
    );

    const handle = await reader.read(identity);
    await handle.close();
    await handle.close();
    expect(firstClose).toHaveBeenCalledOnce();
    expect(fallbackRead).not.toHaveBeenCalled();
    expect(() => handle.stream()).toThrow('already consumed or closed');
  });

  it('closes a deferred fallback handle when close races backend.read', async () => {
    const late = deferred<MediaBlobReadHandle>();
    const lateClose = vi.fn(async () => undefined);
    const firstRead = vi.fn(async () => ({
      byteLength: identity.byteLength,
      close: vi.fn(async () => undefined),
      stream: () => stream([new Error('first backend failed')]),
    }));
    const fallbackRead = vi.fn(() => late.promise);
    const reader = new BackendAwareCommittedBlobReader(
      repository('local', 's3-default', 'local'),
      new PersistentBlobBackendRegistry([
        backend({ id: 'local', read: firstRead }),
        backend({ id: 's3-default', read: fallbackRead }),
      ]),
    );
    const handle = await reader.read(identity);
    const read = handle.stream().getReader().read();
    await vi.waitFor(() => expect(fallbackRead).toHaveBeenCalledOnce());

    const closing = handle.close();
    late.resolve({
      byteLength: identity.byteLength,
      close: lateClose,
      stream: () => stream([new TextEncoder().encode('koharu')]),
    });

    await closing;
    await expect(read).rejects.toThrow('Committed media blob is unavailable');
    expect(lateClose).toHaveBeenCalledOnce();
    expect(firstRead).toHaveBeenCalledOnce();
    expect(fallbackRead).toHaveBeenCalledOnce();
  });

  it('closes a deferred fallback handle when stream cancel races backend.read', async () => {
    const late = deferred<MediaBlobReadHandle>();
    const lateClose = vi.fn(async () => undefined);
    const firstRead = vi.fn(async () => ({
      byteLength: identity.byteLength,
      close: vi.fn(async () => undefined),
      stream: () => stream([new Error('first backend failed')]),
    }));
    const fallbackRead = vi.fn(() => late.promise);
    const reader = new BackendAwareCommittedBlobReader(
      repository('local', 's3-default', 'local'),
      new PersistentBlobBackendRegistry([
        backend({ id: 'local', read: firstRead }),
        backend({ id: 's3-default', read: fallbackRead }),
      ]),
    );
    const handle = await reader.read(identity);
    const streamReader = handle.stream().getReader();
    void streamReader.read();
    await vi.waitFor(() => expect(fallbackRead).toHaveBeenCalledOnce());

    const cancelling = streamReader.cancel('consumer stopped');
    late.resolve({
      byteLength: identity.byteLength,
      close: lateClose,
      stream: () => stream([new TextEncoder().encode('koharu')]),
    });

    await cancelling;
    expect(lateClose).toHaveBeenCalledOnce();
    expect(firstRead).toHaveBeenCalledOnce();
    expect(fallbackRead).toHaveBeenCalledOnce();
  });

  it('sanitizes repository and provider failures', async () => {
    const brokenRepository: CommittedBlobLocationRepository = {
      async findReadableBackendIds() {
        throw new Error('postgres://owner:secret@db.example/private');
      },
    };
    const noBackend = new BackendAwareCommittedBlobReader(
      brokenRepository,
      new PersistentBlobBackendRegistry([]),
    );
    await expect(noBackend.read(identity)).rejects.toMatchObject({
      code: 'media_blob_unavailable',
      message: 'Committed media blob is unavailable',
    });

    const failedProvider = new BackendAwareCommittedBlobReader(
      repository('s3-default'),
      new PersistentBlobBackendRegistry([
        backend({
          id: 's3-default',
          async read() {
            throw new Error('secret provider endpoint');
          },
        }),
      ]),
    );
    await expect(failedProvider.read(identity)).rejects.toMatchObject({
      code: 'media_blob_unavailable',
      message: 'Committed media blob is unavailable',
    });
  });
});
