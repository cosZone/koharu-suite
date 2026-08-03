import path from 'node:path';

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;
const USTAR_NAME_BYTES = 100;
const PORTABLE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const WINDOWS_DEVICE_SEGMENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export interface ArchiveContainerLimits {
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxCompressionRatio: number;
  compressionRatioFloorBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalEntryBytes: number;
  maxPathBytes: number;
  maxPathSegments: number;
  noProgressTimeoutMs: number;
  zstdWindowLogMax: number;
}

export const DEFAULT_ARCHIVE_CONTAINER_LIMITS: Readonly<ArchiveContainerLimits> = Object.freeze({
  maxCompressedBytes: 8 * GIBIBYTE,
  maxExpandedBytes: 16 * GIBIBYTE,
  maxCompressionRatio: 100,
  compressionRatioFloorBytes: MEBIBYTE,
  maxEntries: 100_000,
  maxEntryBytes: 8 * GIBIBYTE - 1,
  maxTotalEntryBytes: 16 * GIBIBYTE - 1024,
  maxPathBytes: USTAR_NAME_BYTES,
  maxPathSegments: 16,
  noProgressTimeoutMs: 30_000,
  zstdWindowLogMax: 27,
});

export type ArchiveContainerErrorCode =
  | 'ARCHIVE_ABORTED'
  | 'COMPRESSED_SIZE_LIMIT_EXCEEDED'
  | 'COMPRESSION_RATIO_LIMIT_EXCEEDED'
  | 'DUPLICATE_ARCHIVE_PATH'
  | 'ENTRY_COUNT_LIMIT_EXCEEDED'
  | 'ENTRY_NOT_CONSUMED'
  | 'ENTRY_SIZE_LIMIT_EXCEEDED'
  | 'ENTRY_SIZE_MISMATCH'
  | 'EXPANDED_SIZE_LIMIT_EXCEEDED'
  | 'EXTRA_ARCHIVE_ENTRY'
  | 'INVALID_ARCHIVE_CONTAINER'
  | 'INVALID_ARCHIVE_LIMIT'
  | 'INVALID_ARCHIVE_PATH'
  | 'NO_PROGRESS_TIMEOUT'
  | 'TOTAL_ENTRY_SIZE_LIMIT_EXCEEDED'
  | 'TRAILING_ARCHIVE_DATA'
  | 'TRUNCATED_ARCHIVE'
  | 'UNSUPPORTED_ARCHIVE_ENTRY_TYPE'
  | 'UNSUPPORTED_TAR_EXTENSION'
  | 'ZSTD_RUNTIME_UNSUPPORTED';

export class ArchiveContainerError extends Error {
  readonly code: ArchiveContainerErrorCode;

  constructor(code: ArchiveContainerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArchiveContainerError';
    this.code = code;
  }
}

function finitePositiveSafeInteger(value: number, name: keyof ArchiveContainerLimits): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ArchiveContainerError(
      'INVALID_ARCHIVE_LIMIT',
      `${name} must be a positive safe integer`,
    );
  }
  return value;
}

export function resolveArchiveContainerLimits(
  overrides: Partial<ArchiveContainerLimits> = {},
): Readonly<ArchiveContainerLimits> {
  const limits: ArchiveContainerLimits = { ...DEFAULT_ARCHIVE_CONTAINER_LIMITS, ...overrides };

  finitePositiveSafeInteger(limits.maxCompressedBytes, 'maxCompressedBytes');
  finitePositiveSafeInteger(limits.maxExpandedBytes, 'maxExpandedBytes');
  finitePositiveSafeInteger(limits.compressionRatioFloorBytes, 'compressionRatioFloorBytes');
  finitePositiveSafeInteger(limits.maxEntries, 'maxEntries');
  finitePositiveSafeInteger(limits.maxEntryBytes, 'maxEntryBytes');
  finitePositiveSafeInteger(limits.maxTotalEntryBytes, 'maxTotalEntryBytes');
  finitePositiveSafeInteger(limits.maxPathBytes, 'maxPathBytes');
  finitePositiveSafeInteger(limits.maxPathSegments, 'maxPathSegments');
  finitePositiveSafeInteger(limits.noProgressTimeoutMs, 'noProgressTimeoutMs');
  finitePositiveSafeInteger(limits.zstdWindowLogMax, 'zstdWindowLogMax');

  if (!Number.isFinite(limits.maxCompressionRatio) || limits.maxCompressionRatio < 1) {
    throw new ArchiveContainerError(
      'INVALID_ARCHIVE_LIMIT',
      'maxCompressionRatio must be a finite number greater than or equal to 1',
    );
  }
  if (limits.maxPathBytes > USTAR_NAME_BYTES) {
    throw new ArchiveContainerError(
      'INVALID_ARCHIVE_LIMIT',
      `maxPathBytes must not exceed the canonical USTAR limit of ${USTAR_NAME_BYTES}`,
    );
  }
  if (limits.zstdWindowLogMax < 10 || limits.zstdWindowLogMax > 30) {
    throw new ArchiveContainerError(
      'INVALID_ARCHIVE_LIMIT',
      'zstdWindowLogMax must be between 10 and 30',
    );
  }
  if (
    limits.maxEntryBytes > limits.maxTotalEntryBytes ||
    limits.maxTotalEntryBytes > limits.maxExpandedBytes
  ) {
    throw new ArchiveContainerError(
      'INVALID_ARCHIVE_LIMIT',
      'entry byte limits must satisfy maxEntryBytes <= maxTotalEntryBytes <= maxExpandedBytes',
    );
  }

  return Object.freeze(limits);
}

export function canonicalizeArchiveEntryPath(
  rawPath: string,
  maxPathBytes = USTAR_NAME_BYTES,
  maxPathSegments = DEFAULT_ARCHIVE_CONTAINER_LIMITS.maxPathSegments,
): string {
  finitePositiveSafeInteger(maxPathBytes, 'maxPathBytes');
  finitePositiveSafeInteger(maxPathSegments, 'maxPathSegments');
  if (maxPathBytes > USTAR_NAME_BYTES) {
    throw new ArchiveContainerError(
      'INVALID_ARCHIVE_LIMIT',
      `maxPathBytes must not exceed the canonical USTAR limit of ${USTAR_NAME_BYTES}`,
    );
  }

  if (
    rawPath.length === 0 ||
    rawPath.includes('\0') ||
    rawPath.includes('\\') ||
    rawPath.includes('\uFFFD') ||
    !/^[\x21-\x7E]+$/.test(rawPath) ||
    Buffer.byteLength(rawPath, 'utf8') > maxPathBytes ||
    path.posix.isAbsolute(rawPath) ||
    rawPath.startsWith('//') ||
    rawPath.endsWith('/')
  ) {
    throw new ArchiveContainerError(
      'INVALID_ARCHIVE_PATH',
      'archive entry path is not a canonical POSIX path',
    );
  }

  const segments = rawPath.split('/');
  if (
    segments.length > maxPathSegments ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        !PORTABLE_SEGMENT.test(segment) ||
        segment.endsWith('.') ||
        WINDOWS_DEVICE_SEGMENT.test(segment),
    ) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(segments[0] ?? '')
  ) {
    throw new ArchiveContainerError(
      'INVALID_ARCHIVE_PATH',
      'archive entry path contains an unsafe segment',
    );
  }
  if (path.posix.normalize(rawPath) !== rawPath) {
    throw new ArchiveContainerError('INVALID_ARCHIVE_PATH', 'archive entry path is not normalized');
  }

  return rawPath;
}

export function archiveEntryPathCollisionKey(canonicalPath: string): string {
  return canonicalPath.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function compareArchiveEntryPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ArchiveEntryHeader {
  name: string;
  size: number;
  type?: string | null;
  linkname?: string | null;
}

export interface AcceptedArchiveEntry {
  path: string;
  byteLength: number;
}

export type ArchivePathAuthorizer = (path: string) => boolean;

export class ArchiveEntryPolicy {
  readonly limits: Readonly<ArchiveContainerLimits>;
  readonly #isAllowedPath: ArchivePathAuthorizer;
  readonly #seenPathKeys = new Set<string>();
  #entryBytes = 0;

  constructor(options: {
    isAllowedPath: ArchivePathAuthorizer;
    limits?: Partial<ArchiveContainerLimits>;
  }) {
    this.limits = resolveArchiveContainerLimits(options.limits);
    this.#isAllowedPath = options.isAllowedPath;
  }

  get entryCount(): number {
    return this.#seenPathKeys.size;
  }

  get entryBytes(): number {
    return this.#entryBytes;
  }

  accept(header: ArchiveEntryHeader): AcceptedArchiveEntry {
    if (header.type !== undefined && header.type !== null && header.type !== 'file') {
      throw new ArchiveContainerError(
        'UNSUPPORTED_ARCHIVE_ENTRY_TYPE',
        'archive entry type is not supported',
      );
    }
    if (header.linkname) {
      throw new ArchiveContainerError(
        'UNSUPPORTED_ARCHIVE_ENTRY_TYPE',
        'archive links are not supported',
      );
    }
    if (!Number.isSafeInteger(header.size) || header.size < 0) {
      throw new ArchiveContainerError('ENTRY_SIZE_LIMIT_EXCEEDED', 'archive entry size is invalid');
    }

    const canonicalPath = canonicalizeArchiveEntryPath(
      header.name,
      this.limits.maxPathBytes,
      this.limits.maxPathSegments,
    );
    const pathKey = archiveEntryPathCollisionKey(canonicalPath);
    if (this.#seenPathKeys.has(pathKey)) {
      throw new ArchiveContainerError(
        'DUPLICATE_ARCHIVE_PATH',
        'archive contains a duplicate entry path',
      );
    }
    if (!this.#isAllowedPath(canonicalPath)) {
      throw new ArchiveContainerError(
        'EXTRA_ARCHIVE_ENTRY',
        'archive contains an entry outside the allowed layout',
      );
    }
    if (this.#seenPathKeys.size + 1 > this.limits.maxEntries) {
      throw new ArchiveContainerError(
        'ENTRY_COUNT_LIMIT_EXCEEDED',
        'archive entry count exceeds the limit',
      );
    }
    if (header.size > this.limits.maxEntryBytes) {
      throw new ArchiveContainerError(
        'ENTRY_SIZE_LIMIT_EXCEEDED',
        'archive entry exceeds the size limit',
      );
    }
    if (this.#entryBytes + header.size > this.limits.maxTotalEntryBytes) {
      throw new ArchiveContainerError(
        'TOTAL_ENTRY_SIZE_LIMIT_EXCEEDED',
        'archive entry bytes exceed the limit',
      );
    }

    this.#seenPathKeys.add(pathKey);
    this.#entryBytes += header.size;
    return { path: canonicalPath, byteLength: header.size };
  }
}
