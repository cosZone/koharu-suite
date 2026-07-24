import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { mediaBlobLocations, mediaStorageBackends } from '../db/schema.js';
import {
  type MediaBlobIdentity,
  type MediaBlobReadHandle,
  type MediaBlobReadRange,
  MediaBlobStoreError,
} from './blob-store.js';
import type {
  PersistentBlobBackend,
  PersistentBlobBackendRegistry,
} from './local-persistent-blob-backend.js';

export interface CommittedBlobLocationRepository {
  findReadableBackendIds(identity: MediaBlobIdentity): Promise<string[]>;
}

export type BackendReadObserver = (backendId: string) => void;

export interface CommittedBlobReadOptions {
  observeBackend?: BackendReadObserver;
}

export class PostgresCommittedBlobLocationRepository implements CommittedBlobLocationRepository {
  constructor(private readonly database: Database) {}

  async findReadableBackendIds(identity: MediaBlobIdentity): Promise<string[]> {
    const rows = await this.database
      .select({ backendId: mediaBlobLocations.backendId })
      .from(mediaBlobLocations)
      .innerJoin(mediaStorageBackends, eq(mediaStorageBackends.id, mediaBlobLocations.backendId))
      .where(
        and(
          eq(mediaBlobLocations.blobSha256, identity.sha256),
          eq(mediaBlobLocations.storageKey, identity.relativeKey),
          eq(mediaBlobLocations.state, 'ready'),
          eq(mediaBlobLocations.verifiedByteLength, BigInt(identity.byteLength)),
          eq(mediaBlobLocations.verifiedSha256, identity.sha256),
          eq(mediaStorageBackends.enabled, true),
          eq(mediaStorageBackends.readable, true),
        ),
      )
      .orderBy(asc(mediaStorageBackends.readPriority), asc(mediaStorageBackends.id));
    return rows.map((row) => row.backendId);
  }
}

export class BackendAwareCommittedBlobReader {
  constructor(
    private readonly repository: CommittedBlobLocationRepository,
    private readonly backends: PersistentBlobBackendRegistry,
    private readonly observeBackend?: BackendReadObserver,
  ) {}

  async read(
    identity: MediaBlobIdentity,
    options: CommittedBlobReadOptions = {},
  ): Promise<MediaBlobReadHandle> {
    let backendIds: string[];
    try {
      backendIds = await this.repository.findReadableBackendIds(identity);
    } catch {
      throw unavailableBlob();
    }

    const candidates = backendIds.flatMap((id) => {
      const backend = this.backends.find(id);
      return backend ? [backend] : [];
    });
    const opened = await openNextCandidate(candidates, identity, 0);
    if (!opened) {
      throw unavailableBlob();
    }
    return fallbackReadHandle({
      candidates,
      identity,
      observeBackend: (backendId) => {
        this.observeBackend?.(backendId);
        options.observeBackend?.(backendId);
      },
      opened,
    });
  }
}

interface OpenedCandidate {
  backend: PersistentBlobBackend;
  handle: MediaBlobReadHandle;
  index: number;
}

async function openNextCandidate(
  candidates: readonly PersistentBlobBackend[],
  identity: MediaBlobIdentity,
  startIndex: number,
  signal?: AbortSignal,
): Promise<OpenedCandidate | undefined> {
  for (let index = startIndex; index < candidates.length; index += 1) {
    if (signal?.aborted) return undefined;
    const backend = candidates[index];
    if (!backend) continue;
    let handle: MediaBlobReadHandle;
    try {
      handle = await backend.read(identity, signal ? { signal } : {});
    } catch {
      if (signal?.aborted) return undefined;
      continue;
    }
    if (signal?.aborted) {
      await handle.close().catch(() => undefined);
      return undefined;
    }
    if (handle.byteLength === identity.byteLength) {
      return { backend, handle, index };
    }
    await handle.close().catch(() => undefined);
  }
  return undefined;
}

function fallbackReadHandle(input: {
  candidates: readonly PersistentBlobBackend[];
  identity: MediaBlobIdentity;
  observeBackend: BackendReadObserver | undefined;
  opened: OpenedCandidate;
}): MediaBlobReadHandle {
  let active: OpenedCandidate | undefined = input.opened;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closePromise: Promise<void> | undefined;
  let pendingFallback: Promise<OpenedCandidate | undefined> | undefined;
  let consumed = false;
  let closed = false;
  const fallbackAbortController = new AbortController();

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    consumed = true;
    fallbackAbortController.abort();
    const closingReader = activeReader;
    const closingHandle = active?.handle;
    const closingFallback = pendingFallback;
    activeReader = undefined;
    active = undefined;
    closePromise = (async () => {
      await closingReader?.cancel().catch(() => undefined);
      await closingHandle?.close();
      await closingFallback?.catch(() => undefined);
    })();
    return closePromise;
  };

  return {
    byteLength: input.identity.byteLength,
    close,
    stream(range) {
      if (consumed || closed) {
        throw new MediaBlobStoreError(
          'media_blob_read_handle_consumed',
          'Media blob read handle was already consumed or closed',
        );
      }
      assertRange(range, input.identity.byteLength);
      consumed = true;
      const expectedBytes = range ? range.end - range.start + 1 : input.identity.byteLength;
      let emittedBytes = 0;
      let observed = false;
      let streamCancelled = false;

      return new ReadableStream<Uint8Array>({
        async cancel(reason) {
          streamCancelled = true;
          closed = true;
          fallbackAbortController.abort();
          const cancellingReader = activeReader;
          const cancellingHandle = active?.handle;
          const cancellingFallback = pendingFallback;
          activeReader = undefined;
          active = undefined;
          await cancellingReader?.cancel(reason).catch(() => undefined);
          await cancellingHandle?.close().catch(() => undefined);
          await cancellingFallback?.catch(() => undefined);
        },
        async pull(controller) {
          while (true) {
            if (closed || !active) {
              controller.error(unavailableBlob());
              return;
            }
            try {
              activeReader ??= active.handle.stream(range).getReader();
              const result = await activeReader.read();
              if (result.done) {
                if (emittedBytes !== expectedBytes) {
                  throw unavailableBlob();
                }
                const completedHandle = active.handle;
                activeReader = undefined;
                active = undefined;
                await completedHandle.close();
                closed = true;
                controller.close();
                return;
              }
              const chunk = result.value;
              if (!(chunk instanceof Uint8Array)) {
                throw unavailableBlob();
              }
              if (chunk.byteLength === 0) continue;
              if (emittedBytes + chunk.byteLength > expectedBytes) {
                throw unavailableBlob();
              }
              emittedBytes += chunk.byteLength;
              if (!observed) {
                observed = true;
                try {
                  input.observeBackend?.(active.backend.id);
                } catch {
                  // Observation is best-effort and must not interrupt a successful read.
                }
              }
              controller.enqueue(chunk);
              return;
            } catch {
              const failed = active;
              if (!failed) {
                closed = true;
                controller.error(unavailableBlob());
                return;
              }
              const failedReader = activeReader;
              activeReader = undefined;
              active = undefined;
              await failedReader?.cancel().catch(() => undefined);
              await failed.handle.close().catch(() => undefined);
              if (closed || emittedBytes > 0) {
                closed = true;
                controller.error(unavailableBlob());
                return;
              }
              const opening = (async () => {
                const opened = await openNextCandidate(
                  input.candidates,
                  input.identity,
                  failed.index + 1,
                  fallbackAbortController.signal,
                );
                if (closed && opened) {
                  await opened.handle.close().catch(() => undefined);
                  return undefined;
                }
                return opened;
              })();
              pendingFallback = opening;
              const opened = await opening;
              if (pendingFallback === opening) pendingFallback = undefined;
              if (closed) {
                if (!streamCancelled) controller.error(unavailableBlob());
                return;
              }
              if (!opened) {
                closed = true;
                controller.error(unavailableBlob());
                return;
              }
              active = opened;
            }
          }
        },
      });
    },
  };
}

function assertRange(range: MediaBlobReadRange | undefined, byteLength: number): void {
  if (
    range &&
    (!Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end >= byteLength)
  ) {
    throw new RangeError('Invalid media blob read range');
  }
}

function unavailableBlob(): MediaBlobStoreError {
  return new MediaBlobStoreError('media_blob_unavailable', 'Committed media blob is unavailable');
}
