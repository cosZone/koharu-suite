import { randomUUID } from 'node:crypto';
import {
  type LocalMediaBlobStore,
  type MediaBlobIdentity,
  MediaBlobIntegrityError,
  type MediaBlobReadHandle,
} from './blob-store.js';
import type {
  DeleteS3BlobResult,
  PutS3BlobResult,
  S3BlobHead,
  S3MediaBlobBackend,
} from './s3-blob-backend.js';

export type PersistentStorageBackendId = 'local' | 's3-default';

export interface PersistentBlobOperationOptions {
  signal?: AbortSignal;
}

export interface PersistentBlobPutInput extends PersistentBlobOperationOptions {
  identity: MediaBlobIdentity;
  source: ReadableStream<Uint8Array>;
}

export interface PersistentBlobHead {
  byteLength: number;
  sha256: string;
}

export interface PersistentBlobPutResult {
  outcome: 'already_present' | 'created';
}

export interface PersistentBlobBackend {
  readonly id: PersistentStorageBackendId;
  delete(
    identity: MediaBlobIdentity,
    options?: PersistentBlobOperationOptions,
  ): Promise<'absent_or_deleted'>;
  head?(
    identity: MediaBlobIdentity,
    options?: PersistentBlobOperationOptions,
  ): Promise<PersistentBlobHead | null>;
  put(input: PersistentBlobPutInput): Promise<PersistentBlobPutResult>;
  read(
    identity: MediaBlobIdentity,
    options?: PersistentBlobOperationOptions,
  ): Promise<MediaBlobReadHandle>;
}

export async function copyPersistentBlob(input: {
  identity: MediaBlobIdentity;
  signal?: AbortSignal;
  source: PersistentBlobBackend;
  target: PersistentBlobBackend;
}): Promise<PersistentBlobPutResult> {
  input.signal?.throwIfAborted();
  let handle: MediaBlobReadHandle | undefined;
  let operationError: unknown;
  let result: PersistentBlobPutResult | undefined;
  try {
    handle = await input.source.read(input.identity, input.signal ? { signal: input.signal } : {});
    result = await input.target.put({
      identity: input.identity,
      ...(input.signal ? { signal: input.signal } : {}),
      source: handle.stream(),
    });
  } catch (error) {
    operationError = error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        operationError ??= error;
      }
    }
  }
  if (operationError) throw operationError;
  if (!result) throw new Error('Persistent media blob copy produced no result');
  return result;
}

export class LocalPersistentBlobBackend implements PersistentBlobBackend {
  readonly id = 'local' as const;

  constructor(private readonly store: LocalMediaBlobStore) {}

  async delete(identity: MediaBlobIdentity): Promise<'absent_or_deleted'> {
    await this.store.evict(identity);
    return 'absent_or_deleted';
  }

  async put(input: PersistentBlobPutInput): Promise<PersistentBlobPutResult> {
    const staged = await this.store.stage({
      lease: { leaseToken: randomUUID(), planId: randomUUID() },
      maxBytes: input.identity.byteLength,
      objectId: randomUUID(),
      ...(input.signal ? { signal: input.signal } : {}),
      source: input.source,
    });
    if (
      staged.byteLength !== input.identity.byteLength ||
      staged.sha256 !== input.identity.sha256
    ) {
      await this.store.settle(staged, 'db_rolled_back');
      throw new MediaBlobIntegrityError('Copied media blob does not match its expected identity');
    }

    let published = false;
    try {
      const result = await this.store.publish(staged);
      published = true;
      if (
        result.byteLength !== input.identity.byteLength ||
        result.sha256 !== input.identity.sha256 ||
        result.relativeKey !== input.identity.relativeKey
      ) {
        throw new MediaBlobIntegrityError(
          'Published media blob does not match its expected identity',
        );
      }
      await this.store.settle(staged, 'db_committed');
      return { outcome: result.outcome };
    } catch (error) {
      if (!published) {
        await this.store.settle(staged, 'db_rolled_back').catch(() => undefined);
      }
      throw error;
    }
  }

  read(
    identity: MediaBlobIdentity,
    _options: PersistentBlobOperationOptions = {},
  ): Promise<MediaBlobReadHandle> {
    return this.store.read(identity);
  }
}

export class S3PersistentBlobBackend implements PersistentBlobBackend {
  readonly id = 's3-default' as const;

  constructor(private readonly backend: S3MediaBlobBackend) {}

  delete(
    identity: MediaBlobIdentity,
    options: PersistentBlobOperationOptions = {},
  ): Promise<DeleteS3BlobResult> {
    return this.backend.delete(identity, options);
  }

  head(
    identity: MediaBlobIdentity,
    options: PersistentBlobOperationOptions = {},
  ): Promise<S3BlobHead | null> {
    return this.backend.head(identity, options);
  }

  put(input: PersistentBlobPutInput): Promise<PutS3BlobResult> {
    return this.backend.put(input);
  }

  read(
    identity: MediaBlobIdentity,
    options: PersistentBlobOperationOptions = {},
  ): Promise<MediaBlobReadHandle> {
    return this.backend.read(identity, options);
  }
}

export class PersistentBlobBackendRegistry {
  readonly #backends = new Map<PersistentStorageBackendId, PersistentBlobBackend>();

  constructor(backends: readonly PersistentBlobBackend[]) {
    for (const backend of backends) {
      if (this.#backends.has(backend.id)) {
        throw new TypeError(`Duplicate persistent media backend: ${backend.id}`);
      }
      this.#backends.set(backend.id, backend);
    }
  }

  find(id: string): PersistentBlobBackend | undefined {
    if (id !== 'local' && id !== 's3-default') {
      return undefined;
    }
    return this.#backends.get(id);
  }

  get(id: string): PersistentBlobBackend {
    if (id !== 'local' && id !== 's3-default') {
      throw new TypeError('Unsupported persistent media backend');
    }
    const backend = this.find(id);
    if (!backend) {
      throw new Error(`Persistent media backend ${id} is unavailable`);
    }
    return backend;
  }

  pair(
    sourceBackendId: string,
    targetBackendId: string,
  ): {
    source: PersistentBlobBackend;
    target: PersistentBlobBackend;
  } {
    if (
      sourceBackendId === targetBackendId ||
      !(
        (sourceBackendId === 'local' && targetBackendId === 's3-default') ||
        (sourceBackendId === 's3-default' && targetBackendId === 'local')
      )
    ) {
      throw new TypeError('Only local and s3-default media copies are supported');
    }
    return {
      source: this.get(sourceBackendId),
      target: this.get(targetBackendId),
    };
  }
}
