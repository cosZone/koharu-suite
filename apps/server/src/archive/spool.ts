import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ArchiveFileDescriptor,
  type ArchiveManifest,
  type ArchiveRecord,
  type ArchiveRecordFamily,
  archiveDataShardPath,
  archiveRecordSchema,
  type ChecksumEntry,
  canonicalJsonBytes,
  DEFAULT_ARCHIVE_CONTAINER_LIMITS,
  DEFAULT_ARCHIVE_SHARD_BYTES,
  DEFAULT_ARCHIVE_SHARD_RECORDS,
  DEFAULT_ARCHIVE_VALIDATION_LIMITS,
} from '@koharu-suite/archive-format';

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const MAX_TAR_ENTRY_OVERHEAD_BYTES = TAR_BLOCK_BYTES * 2 - 1;
const MAX_ARCHIVE_JSONL_BYTES = Math.min(
  DEFAULT_ARCHIVE_CONTAINER_LIMITS.maxTotalEntryBytes -
    DEFAULT_ARCHIVE_VALIDATION_LIMITS.maxManifestBytes -
    DEFAULT_ARCHIVE_VALIDATION_LIMITS.maxChecksumBytes,
  DEFAULT_ARCHIVE_CONTAINER_LIMITS.maxExpandedBytes -
    DEFAULT_ARCHIVE_VALIDATION_LIMITS.maxManifestBytes -
    DEFAULT_ARCHIVE_VALIDATION_LIMITS.maxChecksumBytes -
    DEFAULT_ARCHIVE_CONTAINER_LIMITS.maxEntries * MAX_TAR_ENTRY_OVERHEAD_BYTES -
    TAR_END_BYTES,
);

const FAMILY_ORDER: readonly ArchiveRecordFamily[] = [
  'channels',
  'messages',
  'revisions',
  'revision-media',
  'provenance-observations',
  'provenance-media',
];

const RECORD_TYPES: Record<ArchiveRecordFamily, ArchiveRecord['recordType']> = {
  channels: 'channel',
  messages: 'message',
  revisions: 'revision',
  'revision-media': 'revision-media',
  'provenance-observations': 'provenance-observation',
  'provenance-media': 'provenance-media',
};

export interface ArchiveSpoolSummary {
  checksumEntries: ChecksumEntry[];
  counts: ArchiveManifest['counts'];
  files: ArchiveFileDescriptor[];
  localEntries: Array<{ byteLength: number; localPath: string; path: string }>;
  logicalBytes: ArchiveManifest['logicalBytes'];
  missingMedia: ArchiveManifest['missingMedia'];
}

interface ActiveShard {
  byteLength: number;
  family: ArchiveRecordFamily;
  file: FileHandle;
  hash: ReturnType<typeof createHash>;
  localPath: string;
  path: string;
  recordCount: number;
  shardIndex: number;
}

function familyIndex(family: ArchiveRecordFamily): number {
  return FAMILY_ORDER.indexOf(family);
}

function spoolByteLimit(value: number | undefined): number {
  const limit = value ?? MAX_ARCHIVE_JSONL_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ARCHIVE_JSONL_BYTES) {
    throw new RangeError(
      `Archive spool byte limit must be between 1 and ${MAX_ARCHIVE_JSONL_BYTES}`,
    );
  }
  return limit;
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error('archive_spool_write_failed');
    offset += result.bytesWritten;
  }
}

/** Bounded, canonical JSONL spool used only inside one export snapshot. */
export class ArchiveSpool {
  readonly #checksumEntries: ChecksumEntry[] = [];
  readonly #counts: ArchiveManifest['counts'] = {
    blobs: 0,
    channels: 0,
    hiddenMessages: 0,
    messages: 0,
    provenanceMedia: 0,
    provenanceObservations: 0,
    revisionMedia: 0,
    revisions: 0,
    visibleMessages: 0,
  };
  readonly #directory: string;
  readonly #files: ArchiveFileDescriptor[] = [];
  readonly #localEntries: Array<{ byteLength: number; localPath: string; path: string }> = [];
  readonly #knownMissingOriginals = new Map<string, bigint>();
  readonly #maxJsonlBytes: number;
  readonly #signal: AbortSignal | undefined;
  #active: ActiveShard | null = null;
  #finished = false;
  #lastFamilyIndex = -1;
  #missingReferences = 0;
  #totalJsonlBytes = 0;
  #totalRecords = 0;

  constructor(input: { directory: string; maxJsonlBytes?: number; signal?: AbortSignal }) {
    this.#directory = input.directory;
    this.#maxJsonlBytes = spoolByteLimit(input.maxJsonlBytes);
    this.#signal = input.signal;
  }

  async write(family: ArchiveRecordFamily, value: ArchiveRecord): Promise<void> {
    this.#assertOpen();
    this.#signal?.throwIfAborted();
    const index = familyIndex(family);
    if (index < this.#lastFamilyIndex) throw new Error('archive_family_order_invalid');
    if (value.recordType !== RECORD_TYPES[family]) throw new Error('archive_family_mismatch');
    const record = archiveRecordSchema.parse(value);
    const encoded = canonicalJsonBytes(record);
    if (encoded.byteLength + 1 > DEFAULT_ARCHIVE_VALIDATION_LIMITS.maxJsonlLineBytes) {
      throw new Error('archive_record_too_large');
    }
    if (this.#totalRecords >= DEFAULT_ARCHIVE_VALIDATION_LIMITS.maxTotalRecords) {
      throw new Error('archive_record_limit_exceeded');
    }
    const lineByteLength = encoded.byteLength + 1;
    if (this.#totalJsonlBytes > this.#maxJsonlBytes - lineByteLength) {
      throw new Error('archive_spool_byte_limit_exceeded');
    }

    if (
      this.#active !== null &&
      (this.#active.family !== family ||
        this.#active.recordCount >= DEFAULT_ARCHIVE_SHARD_RECORDS ||
        this.#active.byteLength + lineByteLength > DEFAULT_ARCHIVE_SHARD_BYTES)
    ) {
      await this.#closeActive();
    }
    if (this.#active === null) this.#active = await this.#openShard(family);

    const line = new Uint8Array(encoded.byteLength + 1);
    line.set(encoded);
    line[line.length - 1] = 0x0a;
    await writeAll(this.#active.file, line);
    this.#active.hash.update(line);
    this.#active.byteLength += line.byteLength;
    this.#active.recordCount += 1;
    this.#lastFamilyIndex = index;
    this.#totalJsonlBytes += line.byteLength;
    this.#totalRecords += 1;
    this.#count(record);
  }

  async finish(): Promise<ArchiveSpoolSummary> {
    this.#assertOpen();
    this.#finished = true;
    await this.#closeActive();
    const dataBytes = this.#files
      .filter((file) => !file.family.startsWith('provenance-'))
      .reduce((sum, file) => sum + BigInt(file.byteLength), 0n);
    const provenanceBytes = this.#files
      .filter((file) => file.family.startsWith('provenance-'))
      .reduce((sum, file) => sum + BigInt(file.byteLength), 0n);
    const knownBytes = [...this.#knownMissingOriginals.values()].reduce(
      (sum, value) => sum + value,
      0n,
    );
    return {
      checksumEntries: [...this.#checksumEntries],
      counts: { ...this.#counts },
      files: [...this.#files],
      localEntries: [...this.#localEntries],
      logicalBytes: {
        blobs: '0',
        data: dataBytes.toString(),
        provenance: provenanceBytes.toString(),
        total: (dataBytes + provenanceBytes).toString(),
      },
      missingMedia: {
        knownBytes: knownBytes.toString(),
        references: this.#missingReferences,
        uniqueObjects: this.#knownMissingOriginals.size,
      },
    };
  }

  async closeAfterFailure(): Promise<void> {
    this.#finished = true;
    const active = this.#active;
    this.#active = null;
    await active?.file.close().catch(() => undefined);
  }

  #assertOpen(): void {
    if (this.#finished) throw new Error('archive_spool_closed');
  }

  #count(record: ArchiveRecord): void {
    switch (record.recordType) {
      case 'channel':
        this.#counts.channels += 1;
        break;
      case 'message':
        this.#counts.messages += 1;
        if (record.visibility.state === 'public') this.#counts.visibleMessages += 1;
        else this.#counts.hiddenMessages += 1;
        break;
      case 'revision':
        this.#counts.revisions += 1;
        break;
      case 'revision-media': {
        this.#counts.revisionMedia += 1;
        this.#missingReferences += 1;
        if (record.original !== null) {
          this.#knownMissingOriginals.set(
            `${record.original.sha256}\0${record.original.byteLength}\0${record.original.detectedMimeType}`,
            BigInt(record.original.byteLength),
          );
        }
        break;
      }
      case 'provenance-observation':
        this.#counts.provenanceObservations += 1;
        break;
      case 'provenance-media':
        this.#counts.provenanceMedia += 1;
        break;
    }
  }

  async #closeActive(): Promise<void> {
    const shard = this.#active;
    if (shard === null) return;
    await shard.file.sync();
    await shard.file.close();
    const sha256 = shard.hash.digest('hex');
    this.#files.push({
      byteLength: shard.byteLength.toString(),
      family: shard.family,
      path: shard.path,
      recordCount: shard.recordCount,
      shardIndex: shard.shardIndex,
    });
    this.#checksumEntries.push({
      byteLength: shard.byteLength.toString(),
      path: shard.path,
      sha256,
    });
    this.#localEntries.push({
      byteLength: shard.byteLength,
      localPath: shard.localPath,
      path: shard.path,
    });
    this.#active = null;
  }

  async #openShard(family: ArchiveRecordFamily): Promise<ActiveShard> {
    const shardIndex = this.#files.filter((file) => file.family === family).length;
    const path = archiveDataShardPath(family, shardIndex);
    const familyDirectory = join(this.#directory, 'data', family);
    await mkdir(familyDirectory, { mode: 0o700, recursive: true });
    const localPath = join(this.#directory, path);
    const file = await open(
      localPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_WRONLY,
      0o600,
    );
    await file.chmod(0o600);
    return {
      byteLength: 0,
      family,
      file,
      hash: createHash('sha256'),
      localPath,
      path,
      recordCount: 0,
      shardIndex,
    };
  }
}
