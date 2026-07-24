import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  mediaCacheBlobs,
  mediaCacheObjects,
  messageMedia,
  messageRevisions,
  messages,
} from '../db/schema.js';
import {
  type MediaBlobIdentity,
  type MediaBlobReadHandle,
  MediaBlobStoreError,
} from './blob-store.js';
import type { MediaByteRange } from './http-range.js';

type PublicMediaMime =
  | 'image/avif'
  | 'image/gif'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'video/mp4'
  | 'video/webm';

export interface ReadyPublicMediaObject {
  byteLength: number;
  detectedMime: PublicMediaMime;
  relativeKey: string;
  sha256: string;
  variant: 'original' | 'thumbnail';
}

export interface PublicMediaObjectRepository {
  findReadyObject(objectId: string): Promise<ReadyPublicMediaObject | null>;
}

export interface MediaAccessObserver {
  observe(sha256: string, observedAt?: Date): void;
}

export interface OpenedPublicMedia {
  byteLength: number;
  close(): Promise<void>;
  contentType: PublicMediaMime;
  etag: string;
  stream(range?: MediaByteRange): ReadableStream<Uint8Array>;
  variant: 'original' | 'thumbnail';
}

export interface PublicMediaReader {
  open(objectId: string): Promise<OpenedPublicMedia | null>;
}

export interface PublicMediaBlobReader {
  read(blob: MediaBlobIdentity): Promise<MediaBlobReadHandle>;
}

export class PostgresPublicMediaObjectRepository implements PublicMediaObjectRepository {
  constructor(private readonly database: Database) {}

  async findReadyObject(objectId: string): Promise<ReadyPublicMediaObject | null> {
    const [row] = await this.database
      .select({
        byteLength: mediaCacheBlobs.byteLength,
        detectedMime: mediaCacheBlobs.detectedMime,
        relativeKey: mediaCacheBlobs.relativeKey,
        sha256: mediaCacheBlobs.sha256,
        variant: mediaCacheObjects.variant,
      })
      .from(mediaCacheObjects)
      .innerJoin(
        mediaCacheBlobs,
        and(
          eq(mediaCacheBlobs.sha256, mediaCacheObjects.blobSha256),
          eq(mediaCacheBlobs.state, 'ready'),
        ),
      )
      .innerJoin(messageMedia, eq(messageMedia.id, mediaCacheObjects.canonicalMediaId))
      .innerJoin(messageRevisions, eq(messageRevisions.id, mediaCacheObjects.revisionId))
      .innerJoin(
        messages,
        and(
          eq(messages.id, messageRevisions.messageId),
          eq(messages.currentRevisionNumber, messageRevisions.revisionNumber),
          isNull(messages.tombstonedAt),
        ),
      )
      .where(and(eq(mediaCacheObjects.id, objectId), eq(mediaCacheObjects.state, 'ready')))
      .limit(1);
    if (!row) {
      return null;
    }
    const byteLength = Number(row.byteLength);
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0 ||
      !isPublicMediaMime(row.detectedMime)
    ) {
      return null;
    }
    return {
      byteLength,
      detectedMime: row.detectedMime,
      relativeKey: row.relativeKey,
      sha256: row.sha256,
      variant: row.variant,
    };
  }
}

export class LocalPublicMediaReader implements PublicMediaReader {
  constructor(
    private readonly repository: PublicMediaObjectRepository,
    private readonly blobStore: PublicMediaBlobReader,
    private readonly accessObserver: MediaAccessObserver,
  ) {}

  async open(objectId: string): Promise<OpenedPublicMedia | null> {
    const object = await this.repository.findReadyObject(objectId);
    if (!object) {
      return null;
    }
    let blob: MediaBlobReadHandle;
    try {
      blob = await this.blobStore.read(blobIdentity(object));
    } catch (error) {
      if (error instanceof MediaBlobStoreError || hasFilesystemErrorCode(error)) {
        return null;
      }
      throw error;
    }
    this.accessObserver.observe(object.sha256);
    return openedPublicMedia(blob, object, objectId);
  }
}

function openedPublicMedia(
  blob: MediaBlobReadHandle,
  object: ReadyPublicMediaObject,
  objectId: string,
): OpenedPublicMedia {
  let availableBlob: MediaBlobReadHandle | undefined = blob;
  return {
    byteLength: object.byteLength,
    close: async () => {
      const closing = availableBlob;
      availableBlob = undefined;
      await closing?.close();
    },
    contentType: object.detectedMime,
    etag: `"media-${objectId}"`,
    stream: (range) => {
      const streaming = availableBlob;
      if (!streaming) {
        throw new Error('Public media blob was already consumed');
      }
      availableBlob = undefined;
      return publicMediaStream(streaming, range);
    },
    variant: object.variant,
  };
}

function blobIdentity(object: ReadyPublicMediaObject): MediaBlobIdentity {
  return {
    byteLength: object.byteLength,
    relativeKey: object.relativeKey,
    sha256: object.sha256,
  };
}

function publicMediaStream(
  blob: MediaBlobReadHandle,
  range: MediaByteRange | undefined,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = blob.stream(range ? { end: range.end, start: range.start } : undefined).getReader();
  } catch {
    return closeThenError(blob);
  }
  return new ReadableStream<Uint8Array>({
    async cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
      await blob.close().catch(() => undefined);
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          await blob.close();
          controller.close();
          return;
        }
        if (!(result.value instanceof Uint8Array)) {
          throw new TypeError('Public media backend returned a non-binary chunk');
        }
        controller.enqueue(result.value);
      } catch {
        await blob.close().catch(() => undefined);
        controller.error(new Error('Public media stream became unavailable'));
      }
    },
  });
}

function closeThenError(blob: MediaBlobReadHandle): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      await blob.close().catch(() => undefined);
      controller.error(new Error('Public media stream became unavailable'));
    },
  });
}

function isPublicMediaMime(value: string): value is PublicMediaMime {
  return (
    value === 'image/avif' ||
    value === 'image/gif' ||
    value === 'image/jpeg' ||
    value === 'image/png' ||
    value === 'image/webp' ||
    value === 'video/mp4' ||
    value === 'video/webm'
  );
}

function hasFilesystemErrorCode(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
  );
}
