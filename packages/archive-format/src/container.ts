import { type Readable, Transform, type TransformCallback, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { extract as createTarExtract, pack as createTarPack } from 'tar-stream';
import { runWithAbort } from './async-control.js';
import {
  ArchiveContainerError,
  type ArchiveContainerLimits,
  ArchiveEntryPolicy,
  type ArchivePathAuthorizer,
  canonicalizeArchiveEntryPath,
  resolveArchiveContainerLimits,
} from './entry-policy.js';

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const FIXED_MTIME = new Date(0);

export interface ArchiveContainerSummary {
  compressedBytes: number;
  expandedBytes: number;
  entries: number;
  entryBytes: number;
}

export interface ArchiveReadEntry {
  path: string;
  byteLength: number;
  stream: Readable;
  signal?: AbortSignal;
}

export interface ReadTarZstdOptions {
  isAllowedPath: ArchivePathAuthorizer;
  onEntry: (entry: ArchiveReadEntry) => Promise<void> | void;
  limits?: Partial<ArchiveContainerLimits>;
  signal?: AbortSignal;
}

export interface ArchiveWriteEntry {
  path: string;
  byteLength: number;
  body: Readable;
}

export interface LazyArchiveWriteEntry {
  path: string;
  byteLength: number;
  body: () => Readable;
}

export type ArchiveWriteSourceEntry = ArchiveWriteEntry | LazyArchiveWriteEntry;

export interface WriteTarZstdOptions {
  limits?: Partial<ArchiveContainerLimits>;
  signal?: AbortSignal;
}

export interface ZstdRuntimeSupportProbe {
  createZstdCompress?: unknown;
  createZstdDecompress?: unknown;
  constants?: {
    ZSTD_c_checksumFlag?: unknown;
    ZSTD_c_compressionLevel?: unknown;
    ZSTD_d_windowLogMax?: unknown;
  };
}

export function assertZstdRuntimeSupport(runtime: ZstdRuntimeSupportProbe = zlib): void {
  if (
    typeof runtime.createZstdCompress !== 'function' ||
    typeof runtime.createZstdDecompress !== 'function' ||
    typeof runtime.constants?.ZSTD_c_checksumFlag !== 'number' ||
    typeof runtime.constants.ZSTD_c_compressionLevel !== 'number' ||
    typeof runtime.constants.ZSTD_d_windowLogMax !== 'number'
  ) {
    throw new ArchiveContainerError(
      'ZSTD_RUNTIME_UNSUPPORTED',
      'Node.js runtime does not provide the required Zstd stream support',
    );
  }
}

interface TarHeader {
  name: string;
  size: number;
  type?: string | null;
  linkname?: string | null;
}

interface TarEntryReadable extends Readable {
  header: TarHeader;
}

class CountingLimitTransform extends Transform {
  totalBytes = 0;

  constructor(
    readonly limit: number,
    readonly code: 'COMPRESSED_SIZE_LIMIT_EXCEEDED' | 'EXPANDED_SIZE_LIMIT_EXCEEDED',
    readonly label: string,
    readonly afterChunk?: (totalBytes: number) => void,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > this.limit) {
      callback(new ArchiveContainerError(this.code, `${this.label} exceeds the configured limit`));
      return;
    }

    try {
      this.afterChunk?.(this.totalBytes);
      callback(null, chunk);
    } catch (error) {
      callback(error as Error);
    }
  }
}

class NoProgressMonitor {
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  readonly #timeoutMs: number;
  #timedOut = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(timeoutMs: number, parentSignal?: AbortSignal) {
    this.#timeoutMs = timeoutMs;
    this.signal = parentSignal
      ? AbortSignal.any([parentSignal, this.#controller.signal])
      : this.#controller.signal;
    this.touch();
  }

  touch = (): void => {
    if (this.signal.aborted) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (this.signal.aborted) return;
      this.#timedOut = true;
      this.#controller.abort(
        new ArchiveContainerError(
          'NO_PROGRESS_TIMEOUT',
          'archive operation made no progress before the timeout',
        ),
      );
    }, this.#timeoutMs);
    this.#timer.unref();
  };

  get timedOut(): boolean {
    return this.#timedOut;
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

class ExactByteLengthTransform extends Transform {
  totalBytes = 0;

  constructor(readonly expectedBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > this.expectedBytes) {
      callback(
        new ArchiveContainerError(
          'ENTRY_SIZE_MISMATCH',
          'archive entry exceeds its declared byte length',
        ),
      );
      return;
    }
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    callback(
      this.totalBytes === this.expectedBytes
        ? null
        : new ArchiveContainerError(
            'ENTRY_SIZE_MISMATCH',
            'archive entry is shorter than its declared byte length',
          ),
    );
  }
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function decodeCanonicalTarSize(header: Buffer): number {
  const field = header.subarray(124, 136);
  if ((field[0] ?? 0) & 0x80) {
    throw new ArchiveContainerError(
      'UNSUPPORTED_TAR_EXTENSION',
      'base-256 tar sizes are not supported',
    );
  }

  const raw = field.toString('ascii').replaceAll('\0', '').trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new ArchiveContainerError(
      'INVALID_ARCHIVE_CONTAINER',
      'tar entry size is not canonical octal',
    );
  }

  const size = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ArchiveContainerError(
      'ENTRY_SIZE_LIMIT_EXCEEDED',
      'tar entry size is outside the safe range',
    );
  }
  return size;
}

/**
 * Enforces one canonical USTAR stream before tar-stream sees any entry.
 * Exactly two zero end blocks are required; PAX/GNU extensions and all bytes
 * after the terminator are rejected.
 */
class CanonicalTarBoundaryTransform extends Transform {
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #bodyBytes = 0;
  #paddingBytes = 0;
  #zeroBlocks = 0;
  #ended = false;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      if (this.#ended && chunk.byteLength > 0) {
        throw new ArchiveContainerError('TRAILING_ARCHIVE_DATA', 'tar data follows the end marker');
      }

      this.#buffer = this.#buffer.byteLength === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
      this.#drain();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    if (
      !this.#ended ||
      this.#buffer.byteLength !== 0 ||
      this.#bodyBytes !== 0 ||
      this.#paddingBytes !== 0
    ) {
      callback(
        new ArchiveContainerError(
          'TRUNCATED_ARCHIVE',
          'tar stream is missing its canonical end marker',
        ),
      );
      return;
    }
    callback();
  }

  #drain(): void {
    while (this.#buffer.byteLength > 0) {
      if (this.#ended) {
        throw new ArchiveContainerError('TRAILING_ARCHIVE_DATA', 'tar data follows the end marker');
      }

      if (this.#bodyBytes > 0) {
        const length = Math.min(this.#bodyBytes, this.#buffer.byteLength);
        this.push(this.#take(length));
        this.#bodyBytes -= length;
        continue;
      }

      if (this.#paddingBytes > 0) {
        const length = Math.min(this.#paddingBytes, this.#buffer.byteLength);
        const padding = this.#take(length);
        if (!isZeroBlock(padding)) {
          throw new ArchiveContainerError(
            'INVALID_ARCHIVE_CONTAINER',
            'tar entry padding must be zeroed',
          );
        }
        this.push(padding);
        this.#paddingBytes -= length;
        continue;
      }

      if (this.#buffer.byteLength < TAR_BLOCK_BYTES) return;
      const header = this.#take(TAR_BLOCK_BYTES);
      if (isZeroBlock(header)) {
        this.#zeroBlocks += 1;
        this.push(header);
        if (this.#zeroBlocks === 2) this.#ended = true;
        continue;
      }
      if (this.#zeroBlocks !== 0) {
        throw new ArchiveContainerError(
          'TRAILING_ARCHIVE_DATA',
          'tar entry follows an incomplete end marker',
        );
      }

      const typeFlag = header[156] ?? 0;
      if (typeFlag !== 0 && typeFlag !== 48) {
        const extension =
          typeFlag === 120 || typeFlag === 103 || typeFlag === 76 || typeFlag === 75;
        throw new ArchiveContainerError(
          extension ? 'UNSUPPORTED_TAR_EXTENSION' : 'UNSUPPORTED_ARCHIVE_ENTRY_TYPE',
          extension
            ? 'PAX and GNU tar extensions are not supported'
            : 'only regular tar files are supported',
        );
      }

      const size = decodeCanonicalTarSize(header);
      this.#bodyBytes = size;
      this.#paddingBytes =
        size % TAR_BLOCK_BYTES === 0 ? 0 : TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES);
      this.push(header);
    }
  }

  #take(length: number): Buffer {
    const value = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return value;
  }
}

function enforceCompressionRatio(
  expandedBytes: number,
  compressedBytes: number,
  limits: Readonly<ArchiveContainerLimits>,
): void {
  const ratioBaseBytes = Math.max(compressedBytes, limits.compressionRatioFloorBytes);
  if (expandedBytes / ratioBaseBytes > limits.maxCompressionRatio) {
    throw new ArchiveContainerError(
      'COMPRESSION_RATIO_LIMIT_EXCEEDED',
      'archive compression ratio exceeds the configured limit',
    );
  }
}

function abortContainerError(timedOut: boolean): ArchiveContainerError {
  return timedOut
    ? new ArchiveContainerError(
        'NO_PROGRESS_TIMEOUT',
        'archive operation made no progress before the timeout',
      )
    : new ArchiveContainerError('ARCHIVE_ABORTED', 'archive operation was aborted');
}

function asContainerError(
  error: unknown,
  signal?: AbortSignal,
  timedOut = false,
): ArchiveContainerError {
  if (signal?.aborted) return abortContainerError(timedOut);
  if (error instanceof ArchiveContainerError) return error;
  return new ArchiveContainerError(
    'INVALID_ARCHIVE_CONTAINER',
    'archive container processing failed',
    {
      cause: error,
    },
  );
}

function throwIfAborted(signal?: AbortSignal, timedOut = false): void {
  if (signal?.aborted) throw abortContainerError(timedOut);
}

async function waitWithSignal<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<T> {
  return runWithAbort(operation, signal);
}

export async function readTarZstd(
  input: Readable,
  options: ReadTarZstdOptions,
): Promise<ArchiveContainerSummary> {
  assertZstdRuntimeSupport();
  const limits = resolveArchiveContainerLimits(options.limits);
  const policy = new ArchiveEntryPolicy({ isAllowedPath: options.isAllowedPath, limits });
  throwIfAborted(options.signal);
  const progress = new NoProgressMonitor(limits.noProgressTimeoutMs, options.signal);
  const compressed = new CountingLimitTransform(
    limits.maxCompressedBytes,
    'COMPRESSED_SIZE_LIMIT_EXCEEDED',
    'compressed archive size',
    progress.touch,
  );
  const expanded = new CountingLimitTransform(
    limits.maxExpandedBytes,
    'EXPANDED_SIZE_LIMIT_EXCEEDED',
    'expanded archive size',
    (expandedBytes) => {
      progress.touch();
      enforceCompressionRatio(expandedBytes, compressed.totalBytes, limits);
    },
  );
  const boundary = new CanonicalTarBoundaryTransform();
  const tarExtract = createTarExtract({ allowUnknownFormat: false, filenameEncoding: 'utf-8' });

  const parseResult = pipeline(
    input,
    compressed,
    zlib.createZstdDecompress({
      params: { [zlib.constants.ZSTD_d_windowLogMax]: limits.zstdWindowLogMax },
    }),
    expanded,
    boundary,
    tarExtract,
    { signal: progress.signal },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );

  try {
    for await (const rawEntry of tarExtract as unknown as AsyncIterable<TarEntryReadable>) {
      throwIfAborted(progress.signal, progress.timedOut);
      const accepted = policy.accept(rawEntry.header);
      const exactLength = new ExactByteLengthTransform(accepted.byteLength);
      const entryResult = pipeline(rawEntry, exactLength, { signal: progress.signal }).then(
        () => undefined,
        (error: unknown) => error,
      );

      try {
        await waitWithSignal(
          () =>
            options.onEntry({
              path: accepted.path,
              byteLength: accepted.byteLength,
              stream: exactLength,
              signal: progress.signal,
            }),
          progress.signal,
        );
        if (!exactLength.readableEnded) {
          throw new ArchiveContainerError(
            'ENTRY_NOT_CONSUMED',
            'archive entry was not fully consumed',
          );
        }
        const entryError = await entryResult;
        if (entryError) throw entryError;
      } catch (error) {
        exactLength.destroy(error as Error);
        rawEntry.destroy(error as Error);
        await entryResult;
        throw error;
      }
    }

    const parseError = await parseResult;
    if (parseError) throw parseError;
    enforceCompressionRatio(expanded.totalBytes, compressed.totalBytes, limits);

    return {
      compressedBytes: compressed.totalBytes,
      expandedBytes: expanded.totalBytes,
      entries: policy.entryCount,
      entryBytes: policy.entryBytes,
    };
  } catch (error) {
    tarExtract.destroy(error as Error);
    await parseResult;
    throw asContainerError(error, progress.signal, progress.timedOut);
  } finally {
    progress.stop();
  }
}

function assertProjectedTarBytesWithinLimit(
  entries: readonly { byteLength: number }[],
  maxExpandedBytes: number,
): void {
  let totalBytes = TAR_END_BYTES;
  for (const entry of entries) {
    const encodedEntryBytes =
      TAR_BLOCK_BYTES + Math.ceil(entry.byteLength / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (
      !Number.isSafeInteger(encodedEntryBytes) ||
      totalBytes > maxExpandedBytes - encodedEntryBytes
    ) {
      throw new ArchiveContainerError(
        'EXPANDED_SIZE_LIMIT_EXCEEDED',
        'projected tar size exceeds the limit',
      );
    }
    totalBytes += encodedEntryBytes;
  }
}

export async function writeTarZstd(
  entries: readonly ArchiveWriteSourceEntry[],
  output: Writable,
  options: WriteTarZstdOptions = {},
): Promise<ArchiveContainerSummary> {
  assertZstdRuntimeSupport();
  const limits = resolveArchiveContainerLimits(options.limits);
  const policy = new ArchiveEntryPolicy({ isAllowedPath: () => true, limits });
  const canonicalEntries = entries.map((entry) => ({
    ...entry,
    path: canonicalizeArchiveEntryPath(entry.path, limits.maxPathBytes, limits.maxPathSegments),
  }));

  for (const entry of canonicalEntries) {
    policy.accept({ name: entry.path, size: entry.byteLength, type: 'file' });
  }
  assertProjectedTarBytesWithinLimit(canonicalEntries, limits.maxExpandedBytes);

  throwIfAborted(options.signal);
  const progress = new NoProgressMonitor(limits.noProgressTimeoutMs, options.signal);
  const tarPack = createTarPack();
  const expanded = new CountingLimitTransform(
    limits.maxExpandedBytes,
    'EXPANDED_SIZE_LIMIT_EXCEEDED',
    'expanded archive size',
    progress.touch,
  );
  const compressed = new CountingLimitTransform(
    limits.maxCompressedBytes,
    'COMPRESSED_SIZE_LIMIT_EXCEEDED',
    'compressed archive size',
    progress.touch,
  );
  const containerResult = pipeline(
    tarPack as unknown as Readable,
    expanded,
    zlib.createZstdCompress({
      params: {
        [zlib.constants.ZSTD_c_compressionLevel]: 3,
        [zlib.constants.ZSTD_c_checksumFlag]: 1,
      },
    }),
    compressed,
    output,
    { signal: progress.signal },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );

  try {
    for (const entry of canonicalEntries) {
      throwIfAborted(progress.signal, progress.timedOut);
      const tarEntry = tarPack.entry({
        name: entry.path,
        size: entry.byteLength,
        type: 'file',
        mode: 0o644,
        uid: 0,
        gid: 0,
        mtime: FIXED_MTIME,
        uname: '',
        gname: '',
      });
      const body = typeof entry.body === 'function' ? entry.body() : entry.body;
      await pipeline(
        body,
        new ExactByteLengthTransform(entry.byteLength),
        tarEntry as unknown as Writable,
        {
          signal: progress.signal,
        },
      );
    }
    tarPack.finalize();

    const containerError = await containerResult;
    if (containerError) throw containerError;
    enforceCompressionRatio(expanded.totalBytes, compressed.totalBytes, limits);
    return {
      compressedBytes: compressed.totalBytes,
      expandedBytes: expanded.totalBytes,
      entries: policy.entryCount,
      entryBytes: policy.entryBytes,
    };
  } catch (error) {
    tarPack.destroy(error as Error);
    await containerResult;
    throw asContainerError(error, progress.signal, progress.timedOut);
  } finally {
    progress.stop();
  }
}
