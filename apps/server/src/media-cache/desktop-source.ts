import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

export interface OpenDesktopMediaInput {
  desktopRoot: string;
  maxBytes: number;
  signal?: AbortSignal;
  sourcePath: string;
}

export interface OpenedDesktopMedia {
  declaredBytes: bigint;
  stream: ReadableStream<Uint8Array>;
}

export class DesktopMediaSourceUnavailableError extends Error {
  readonly code = 'desktop_media_source_unavailable';

  constructor() {
    super('Desktop media source is unavailable');
    this.name = 'DesktopMediaSourceUnavailableError';
  }
}

export class DesktopMediaSourceTooLargeError extends Error {
  readonly code = 'desktop_media_source_too_large';

  constructor(
    readonly maxBytes: number,
    readonly declaredBytes: bigint,
  ) {
    super(`Desktop media source exceeds the ${maxBytes}-byte caller limit`);
    this.name = 'DesktopMediaSourceTooLargeError';
  }
}

interface DesktopMediaSourceFileSystem {
  open(path: string, flags: number): Promise<FileHandle>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<BigIntStats>;
}

const desktopMediaSourceFileSystem: DesktopMediaSourceFileSystem = {
  open,
  realpath,
  stat: (path) => stat(path, { bigint: true }),
};

export class DesktopMediaSource {
  constructor(
    private readonly fileSystem: DesktopMediaSourceFileSystem = desktopMediaSourceFileSystem,
  ) {}

  async open(input: OpenDesktopMediaInput): Promise<OpenedDesktopMedia> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
      throw new TypeError('Desktop media maxBytes must be a positive safe integer');
    }
    input.signal?.throwIfAborted();
    if (!isSafeSourcePath(input.sourcePath)) {
      throw new DesktopMediaSourceUnavailableError();
    }

    let canonicalRoot: string;
    let canonicalSource: string;
    try {
      canonicalRoot = await this.fileSystem.realpath(input.desktopRoot);
      const rootMetadata = await this.fileSystem.stat(canonicalRoot);
      if (!rootMetadata.isDirectory()) {
        throw new DesktopMediaSourceUnavailableError();
      }
      canonicalSource = await this.fileSystem.realpath(resolve(canonicalRoot, input.sourcePath));
    } catch (error) {
      if (error instanceof DesktopMediaSourceUnavailableError) {
        throw error;
      }
      throw new DesktopMediaSourceUnavailableError();
    }
    if (!canonicalSource.startsWith(`${canonicalRoot}${sep}`)) {
      throw new DesktopMediaSourceUnavailableError();
    }

    let file: FileHandle | undefined;
    try {
      const expectedMetadata = await this.fileSystem.stat(canonicalSource);
      if (!expectedMetadata.isFile() || expectedMetadata.size < 0n) {
        throw new DesktopMediaSourceUnavailableError();
      }
      file = await this.fileSystem.open(canonicalSource, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await file.stat({ bigint: true });
      if (
        !metadata.isFile() ||
        metadata.size < 0n ||
        metadata.dev !== expectedMetadata.dev ||
        metadata.ino !== expectedMetadata.ino
      ) {
        throw new DesktopMediaSourceUnavailableError();
      }
      if (metadata.size > BigInt(input.maxBytes)) {
        throw new DesktopMediaSourceTooLargeError(input.maxBytes, metadata.size);
      }
      const stream = file.createReadStream({
        autoClose: true,
        ...(input.signal ? { signal: input.signal } : {}),
        start: 0,
      });
      file = undefined;
      return {
        declaredBytes: metadata.size,
        stream: nodeReadableToByteStream(stream, input.signal),
      };
    } catch (error) {
      await file?.close().catch(() => undefined);
      if (
        error instanceof DesktopMediaSourceTooLargeError ||
        error instanceof DesktopMediaSourceUnavailableError ||
        input.signal?.aborted
      ) {
        throw input.signal?.aborted ? input.signal.reason : error;
      }
      throw new DesktopMediaSourceUnavailableError();
    }
  }
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
          throw new DesktopMediaSourceUnavailableError();
        }
        controller.enqueue(result.value);
      } catch {
        if (signal?.aborted) {
          controller.error(signal.reason);
          return;
        }
        controller.error(new DesktopMediaSourceUnavailableError());
      }
    },
  });
}

function isSafeSourcePath(sourcePath: string): boolean {
  if (
    sourcePath.length === 0 ||
    sourcePath.length > 1024 ||
    sourcePath.includes('\0') ||
    sourcePath.includes('\\') ||
    isAbsolute(sourcePath) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(sourcePath)
  ) {
    return false;
  }
  const components = sourcePath.split('/');
  return components.every(
    (component) => component.length > 0 && component !== '.' && component !== '..',
  );
}
