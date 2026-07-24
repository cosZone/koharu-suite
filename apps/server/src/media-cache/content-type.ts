import type { FileHandle } from 'node:fs/promises';
import { fileTypeFromBuffer } from 'file-type';

export type CacheableMediaKind = 'animation' | 'photo' | 'video';

const DETECTION_PREFIX_BYTES = 4100;

export type ValidatedMediaContentType =
  | { extension: 'avif'; mimeType: 'image/avif' }
  | { extension: 'gif'; mimeType: 'image/gif' }
  | { extension: 'jpg'; mimeType: 'image/jpeg' }
  | { extension: 'mp4'; mimeType: 'video/mp4' }
  | { extension: 'png'; mimeType: 'image/png' }
  | { extension: 'webm'; mimeType: 'video/webm' }
  | { extension: 'webp'; mimeType: 'image/webp' };

export type MediaContentTypeErrorCode =
  | 'media_content_type_mismatch'
  | 'media_content_type_unknown';

export class MediaContentTypeError extends Error {
  constructor(
    readonly code: MediaContentTypeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MediaContentTypeError';
  }
}

const SUPPORTED_CONTENT_TYPES = [
  { contentType: { extension: 'avif', mimeType: 'image/avif' }, kinds: ['photo'] },
  { contentType: { extension: 'gif', mimeType: 'image/gif' }, kinds: ['animation'] },
  { contentType: { extension: 'jpg', mimeType: 'image/jpeg' }, kinds: ['photo'] },
  {
    contentType: { extension: 'mp4', mimeType: 'video/mp4' },
    kinds: ['animation', 'video'],
  },
  { contentType: { extension: 'png', mimeType: 'image/png' }, kinds: ['photo'] },
  { contentType: { extension: 'webm', mimeType: 'video/webm' }, kinds: ['video'] },
  {
    contentType: { extension: 'webp', mimeType: 'image/webp' },
    kinds: ['animation', 'photo'],
  },
] as const satisfies readonly {
  contentType: ValidatedMediaContentType;
  kinds: readonly CacheableMediaKind[];
}[];

export async function validateMediaContentType(
  file: FileHandle,
  expectedKind: CacheableMediaKind,
): Promise<ValidatedMediaContentType> {
  const prefix = new Uint8Array(DETECTION_PREFIX_BYTES);
  const { bytesRead } = await file.read(prefix, 0, prefix.byteLength, 0);
  return validateDetectedContentType(prefix.subarray(0, bytesRead), expectedKind);
}

export async function validateMediaContentTypeStream(
  stream: ReadableStream<Uint8Array>,
  expectedKind: CacheableMediaKind,
): Promise<ValidatedMediaContentType> {
  const prefix = new Uint8Array(DETECTION_PREFIX_BYTES);
  const reader = stream.getReader();
  let bytesRead = 0;
  let complete = false;
  try {
    while (bytesRead < prefix.byteLength) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new TypeError('Media content stream yielded a non-Uint8Array chunk');
      }
      const remaining = prefix.byteLength - bytesRead;
      const chunk = result.value.subarray(0, remaining);
      prefix.set(chunk, bytesRead);
      bytesRead += chunk.byteLength;
      if (result.value.byteLength > remaining) {
        break;
      }
    }
    if (!complete) {
      void reader.cancel().catch(() => undefined);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return validateDetectedContentType(prefix.subarray(0, bytesRead), expectedKind);
}

async function validateDetectedContentType(
  prefix: Uint8Array,
  expectedKind: CacheableMediaKind,
): Promise<ValidatedMediaContentType> {
  const detected = await fileTypeFromBuffer(prefix);

  if (detected === undefined) {
    throw new MediaContentTypeError(
      'media_content_type_unknown',
      'Media content type could not be recognized from its magic number',
    );
  }

  const supported = SUPPORTED_CONTENT_TYPES.find(
    ({ contentType, kinds }) =>
      contentType.extension === detected.ext &&
      contentType.mimeType === detected.mime &&
      kinds.some((kind) => kind === expectedKind),
  );

  if (supported === undefined) {
    throw new MediaContentTypeError(
      'media_content_type_mismatch',
      `Detected media content type ${detected.mime} is not allowed for ${expectedKind}`,
    );
  }

  return supported.contentType;
}
