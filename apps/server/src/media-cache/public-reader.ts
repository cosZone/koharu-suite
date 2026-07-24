import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';
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
  type LocalMediaBlobStore,
  type MediaBlobIdentity,
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
    private readonly blobStore: LocalMediaBlobStore,
    private readonly accessObserver: MediaAccessObserver,
  ) {}

  async open(objectId: string): Promise<OpenedPublicMedia | null> {
    const object = await this.repository.findReadyObject(objectId);
    if (!object) {
      return null;
    }
    let file: FileHandle;
    try {
      file = await this.blobStore.open(blobIdentity(object));
    } catch (error) {
      if (error instanceof MediaBlobStoreError || hasFilesystemErrorCode(error)) {
        return null;
      }
      throw error;
    }
    this.accessObserver.observe(object.sha256);
    return openedPublicMedia(file, object, objectId);
  }
}

function openedPublicMedia(
  file: FileHandle,
  object: ReadyPublicMediaObject,
  objectId: string,
): OpenedPublicMedia {
  let availableFile: FileHandle | undefined = file;
  return {
    byteLength: object.byteLength,
    close: async () => {
      const closing = availableFile;
      availableFile = undefined;
      await closing?.close();
    },
    contentType: object.detectedMime,
    etag: `"media-${objectId}"`,
    stream: (range) => {
      const streaming = availableFile;
      if (!streaming) {
        throw new Error('Public media file handle was already consumed');
      }
      availableFile = undefined;
      const input = streaming.createReadStream({
        autoClose: true,
        ...(range ? { end: range.end, start: range.start } : { start: 0 }),
      });
      return nodeReadableToByteStream(input);
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

function nodeReadableToByteStream(input: Readable): ReadableStream<Uint8Array> {
  const iterator = input[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async cancel(reason) {
      input.destroy(reason instanceof Error ? reason : undefined);
      await iterator.return?.();
    },
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }
        if (!(result.value instanceof Uint8Array)) {
          throw new Error('Public media stream returned a non-binary chunk');
        }
        controller.enqueue(result.value);
      } catch {
        controller.error(new Error('Public media stream became unavailable'));
      }
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
