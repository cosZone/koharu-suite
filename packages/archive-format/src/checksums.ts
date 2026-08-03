import { createHash } from 'node:crypto';
import {
  archiveEntryPathCollisionKey,
  canonicalizeArchiveEntryPath,
  compareArchiveEntryPaths,
  DEFAULT_ARCHIVE_CONTAINER_LIMITS,
} from './entry-policy.js';
import { canonicalNonNegativeDecimalSchema, sha256HexSchema } from './schemas.js';

export interface ChecksumEntry {
  byteLength: string;
  path: string;
  sha256: string;
}

export interface ChecksumParseLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxFileBytes: number;
  maxLineBytes: number;
  maxPathBytes: number;
  maxPathSegments: number;
}

export const DEFAULT_CHECKSUM_PARSE_LIMITS: Readonly<ChecksumParseLimits> = Object.freeze({
  maxEntries: DEFAULT_ARCHIVE_CONTAINER_LIMITS.maxEntries,
  maxEntryBytes: DEFAULT_ARCHIVE_CONTAINER_LIMITS.maxEntryBytes,
  maxFileBytes: 20 * 1_024 * 1_024,
  maxLineBytes: 256,
  maxPathBytes: DEFAULT_ARCHIVE_CONTAINER_LIMITS.maxPathBytes,
  maxPathSegments: DEFAULT_ARCHIVE_CONTAINER_LIMITS.maxPathSegments,
});

export interface ChecksumPathComparison {
  /** Archive entries which have no corresponding line in checksums.sha256. */
  unlistedArchivePaths: string[];
  /** Checksum lines which have no corresponding entry in the archive. */
  undeclaredChecksumPaths: string[];
}

export type ChecksumFormatErrorCode =
  | 'byte_length_limit_exceeded'
  | 'duplicate_path'
  | 'empty_file'
  | 'entry_count_limit_exceeded'
  | 'input_limit_exceeded'
  | 'invalid_byte_length'
  | 'invalid_line'
  | 'invalid_path'
  | 'invalid_sha256'
  | 'line_size_limit_exceeded'
  | 'non_canonical_order'
  | 'non_lf_line_ending';

export class ChecksumFormatError extends Error {
  readonly code: ChecksumFormatErrorCode;
  readonly line: number | null;

  constructor(code: ChecksumFormatErrorCode, line: number | null) {
    super(
      line === null
        ? `Invalid checksum file: ${code}`
        : `Invalid checksum file at line ${line}: ${code}`,
    );
    this.name = 'ChecksumFormatError';
    this.code = code;
    this.line = line;
  }
}

function resolveLimits(
  overrides: Partial<ChecksumParseLimits> = {},
): Readonly<ChecksumParseLimits> {
  const limits = { ...DEFAULT_CHECKSUM_PARSE_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('Checksum limits must be positive safe integers');
    }
  }
  if (limits.maxEntries > DEFAULT_ARCHIVE_CONTAINER_LIMITS.maxEntries) {
    throw new TypeError('Checksum maxEntries exceeds the archive container limit');
  }
  if (limits.maxEntryBytes > DEFAULT_ARCHIVE_CONTAINER_LIMITS.maxEntryBytes) {
    throw new TypeError('Checksum maxEntryBytes exceeds the archive container limit');
  }
  return Object.freeze(limits);
}

function canonicalPath(path: string, limits: Readonly<ChecksumParseLimits>): string {
  try {
    return canonicalizeArchiveEntryPath(path, limits.maxPathBytes, limits.maxPathSegments);
  } catch {
    throw new ChecksumFormatError('invalid_path', null);
  }
}

function validateEntry(
  entry: ChecksumEntry,
  line: number | null,
  limits: Readonly<ChecksumParseLimits>,
): ChecksumEntry {
  if (!sha256HexSchema.safeParse(entry.sha256).success) {
    throw new ChecksumFormatError('invalid_sha256', line);
  }
  if (!canonicalNonNegativeDecimalSchema.safeParse(entry.byteLength).success) {
    throw new ChecksumFormatError('invalid_byte_length', line);
  }
  if (BigInt(entry.byteLength) > BigInt(limits.maxEntryBytes)) {
    throw new ChecksumFormatError('byte_length_limit_exceeded', line);
  }
  try {
    canonicalizeArchiveEntryPath(entry.path, limits.maxPathBytes, limits.maxPathSegments);
  } catch {
    throw new ChecksumFormatError('invalid_path', line);
  }
  return entry;
}

export function parseChecksumFile(
  input: string,
  limitOverrides: Partial<ChecksumParseLimits> = {},
): ChecksumEntry[] {
  const limits = resolveLimits(limitOverrides);
  if (input.length === 0) return [];
  if (Buffer.byteLength(input, 'utf8') > limits.maxFileBytes) {
    throw new ChecksumFormatError('input_limit_exceeded', null);
  }
  if (input.includes('\r') || !input.endsWith('\n')) {
    throw new ChecksumFormatError('non_lf_line_ending', null);
  }
  if (input === '\n') throw new ChecksumFormatError('empty_file', null);

  const lines = input.slice(0, -1).split('\n');
  if (lines.length > limits.maxEntries) {
    throw new ChecksumFormatError('entry_count_limit_exceeded', null);
  }

  const entries: ChecksumEntry[] = [];
  const collisionKeys = new Set<string>();
  let previousPath: string | null = null;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (Buffer.byteLength(line, 'utf8') > limits.maxLineBytes) {
      throw new ChecksumFormatError('line_size_limit_exceeded', lineNumber);
    }
    const fields = line.split('\t');
    if (fields.length !== 3) throw new ChecksumFormatError('invalid_line', lineNumber);
    const [sha256, byteLength, path] = fields;
    if (sha256 === undefined || byteLength === undefined || path === undefined) {
      throw new ChecksumFormatError('invalid_line', lineNumber);
    }

    const entry = validateEntry({ byteLength, path, sha256 }, lineNumber, limits);
    const collisionKey = archiveEntryPathCollisionKey(entry.path);
    if (collisionKeys.has(collisionKey)) {
      throw new ChecksumFormatError('duplicate_path', lineNumber);
    }
    if (previousPath !== null && compareArchiveEntryPaths(previousPath, entry.path) >= 0) {
      throw new ChecksumFormatError('non_canonical_order', lineNumber);
    }

    collisionKeys.add(collisionKey);
    previousPath = entry.path;
    entries.push(entry);
  }

  return entries;
}

export function renderChecksumFile(
  entries: readonly ChecksumEntry[],
  limitOverrides: Partial<ChecksumParseLimits> = {},
): string {
  const limits = resolveLimits(limitOverrides);
  if (entries.length === 0) return '';
  if (entries.length > limits.maxEntries) {
    throw new ChecksumFormatError('entry_count_limit_exceeded', null);
  }

  const sorted = entries
    .map((entry) => validateEntry({ ...entry }, null, limits))
    .sort((left, right) => compareArchiveEntryPaths(left.path, right.path));
  const collisionKeys = new Set<string>();
  for (const entry of sorted) {
    const collisionKey = archiveEntryPathCollisionKey(entry.path);
    if (collisionKeys.has(collisionKey)) throw new ChecksumFormatError('duplicate_path', null);
    collisionKeys.add(collisionKey);
  }

  const output = `${sorted
    .map((entry) => `${entry.sha256}\t${entry.byteLength}\t${entry.path}`)
    .join('\n')}\n`;
  for (const [index, line] of output.slice(0, -1).split('\n').entries()) {
    if (Buffer.byteLength(line, 'utf8') > limits.maxLineBytes) {
      throw new ChecksumFormatError('line_size_limit_exceeded', index + 1);
    }
  }
  if (Buffer.byteLength(output, 'utf8') > limits.maxFileBytes) {
    throw new ChecksumFormatError('input_limit_exceeded', null);
  }
  return output;
}

export function compareChecksumPaths(
  entries: readonly ChecksumEntry[],
  archivePaths: Iterable<string>,
): ChecksumPathComparison {
  const limits = DEFAULT_CHECKSUM_PARSE_LIMITS;
  const declared = new Map<string, string>();
  for (const rawEntry of entries) {
    const entry = validateEntry({ ...rawEntry }, null, limits);
    const collisionKey = archiveEntryPathCollisionKey(entry.path);
    if (declared.has(collisionKey)) throw new ChecksumFormatError('duplicate_path', null);
    declared.set(collisionKey, entry.path);
  }
  const present = new Map<string, string>();
  for (const rawPath of archivePaths) {
    const path = canonicalPath(rawPath, DEFAULT_CHECKSUM_PARSE_LIMITS);
    const collisionKey = archiveEntryPathCollisionKey(path);
    if (present.has(collisionKey)) throw new ChecksumFormatError('duplicate_path', null);
    present.set(collisionKey, path);
  }

  return {
    unlistedArchivePaths: [...present]
      .filter(([key]) => !declared.has(key))
      .map(([, path]) => path)
      .sort(compareArchiveEntryPaths),
    undeclaredChecksumPaths: [...declared]
      .filter(([key]) => !present.has(key))
      .map(([, path]) => path)
      .sort(compareArchiveEntryPaths),
  };
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
