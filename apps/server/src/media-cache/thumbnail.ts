import type { FileHandle } from 'node:fs/promises';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp, { type OutputInfo, type Sharp } from 'sharp';

const THUMBNAIL_INPUT_PIXEL_LIMIT = 33_554_432;
const THUMBNAIL_INPUT_CHANNEL_LIMIT = 4;

sharp.concurrency(1);
sharp.cache({ files: 0, items: 32, memory: 16 });

export type ThumbnailInputMime =
  | 'image/avif'
  | 'image/gif'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp';

export interface ThumbnailSourceOptions {
  mimeType: string;
  signal?: AbortSignal;
}

export interface ThumbnailResult {
  byteLength: number;
  format: 'webp';
  height: number;
  width: number;
}

export type ThumbnailGenerationErrorCode =
  | 'thumbnail_aborted'
  | 'thumbnail_timeout'
  | 'thumbnail_unavailable';

export class ThumbnailGenerationError extends Error {
  constructor(readonly code: ThumbnailGenerationErrorCode) {
    super(thumbnailErrorMessage(code));
    this.name = 'ThumbnailGenerationError';
  }
}

export interface ThumbnailSource {
  result: Promise<ThumbnailResult>;
  stream: ReadableStream<Uint8Array>;
}

export function createThumbnailSource(
  input: FileHandle,
  options: ThumbnailSourceOptions,
): ThumbnailSource {
  if (!isThumbnailInputMime(options.mimeType)) {
    throw new ThumbnailGenerationError('thumbnail_unavailable');
  }

  const transformer = sharp({
    failOn: 'warning',
    limitInputChannels: THUMBNAIL_INPUT_CHANNEL_LIMIT,
    limitInputPixels: THUMBNAIL_INPUT_PIXEL_LIMIT,
    pages: 1,
    sequentialRead: true,
  })
    .autoOrient()
    .resize({
      fit: 'inside',
      height: 1280,
      width: 1280,
      withoutEnlargement: true,
    })
    .webp({ effort: 4, quality: 82 })
    .timeout({ seconds: 5 });
  const output = new PassThrough();
  const info = sharpOutputInfo(transformer);
  const processing = pipeline(
    input.createReadStream({ autoClose: false, start: 0 }),
    transformer,
    output,
    ...(options.signal ? [{ signal: options.signal }] : []),
  );
  const result = Promise.all([processing, info])
    .then(([, outputInfo]) => thumbnailResult(outputInfo))
    .catch((error: unknown) => {
      throw normalizeThumbnailError(error, options.signal);
    })
    .finally(() => input.close());

  return {
    result,
    stream: nodeReadableToByteStream(output, options.signal),
  };
}

function sharpOutputInfo(transformer: Sharp): Promise<OutputInfo> {
  return new Promise((resolve) => {
    transformer.once('info', resolve);
  });
}

function nodeReadableToByteStream(
  input: Readable,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
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
          throw new TypeError('Sharp emitted a non-binary output chunk');
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(normalizeThumbnailError(error, signal));
      }
    },
  });
}

function thumbnailResult(info: OutputInfo): ThumbnailResult {
  if (
    info.format !== 'webp' ||
    !Number.isSafeInteger(info.width) ||
    info.width <= 0 ||
    !Number.isSafeInteger(info.height) ||
    info.height <= 0 ||
    !Number.isSafeInteger(info.size) ||
    info.size <= 0
  ) {
    throw new ThumbnailGenerationError('thumbnail_unavailable');
  }
  return {
    byteLength: info.size,
    format: 'webp',
    height: info.height,
    width: info.width,
  };
}

function normalizeThumbnailError(
  error: unknown,
  signal: AbortSignal | undefined,
): ThumbnailGenerationError {
  if (error instanceof ThumbnailGenerationError) {
    return error;
  }
  if (signal?.aborted) {
    return new ThumbnailGenerationError('thumbnail_aborted');
  }
  if (error instanceof Error && /\btimeout\b/iu.test(error.message)) {
    return new ThumbnailGenerationError('thumbnail_timeout');
  }
  return new ThumbnailGenerationError('thumbnail_unavailable');
}

function isThumbnailInputMime(value: string): value is ThumbnailInputMime {
  return (
    value === 'image/avif' ||
    value === 'image/gif' ||
    value === 'image/jpeg' ||
    value === 'image/png' ||
    value === 'image/webp'
  );
}

function thumbnailErrorMessage(code: ThumbnailGenerationErrorCode): string {
  switch (code) {
    case 'thumbnail_aborted':
      return 'Thumbnail generation was aborted';
    case 'thumbnail_timeout':
      return 'Thumbnail generation timed out';
    case 'thumbnail_unavailable':
      return 'Thumbnail generation is unavailable for this media';
  }
}
