import { readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { canonicalJsonBytes } from '../src/canonical-json.js';
import {
  type ChecksumEntry,
  parseChecksumFile,
  renderChecksumFile,
  sha256Hex,
} from '../src/checksums.js';
import { type ArchiveWriteEntry, writeTarZstd } from '../src/container.js';
import { encodeJsonlShards } from '../src/jsonl.js';
import {
  ARCHIVE_FORMAT_NAME,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveManifest,
  type ArchiveRecordFamily,
} from '../src/schemas.js';
import type {
  ArchiveEntryEvidence,
  ArchiveRecordEnvelope,
  ValidateArchiveModelInput,
} from '../src/validator.js';
import { archiveBlobPath } from '../src/validator.js';

const FAMILY_ORDER: ArchiveRecordFamily[] = [
  'channels',
  'messages',
  'revisions',
  'revision-media',
  'provenance-observations',
  'provenance-media',
];

export interface LogicalArchiveFixture {
  blobs: Array<{ sha256: string; utf8: string }>;
  channels: unknown[];
  messages: unknown[];
  'provenance-media': unknown[];
  'provenance-observations': unknown[];
  'revision-media': unknown[];
  revisions: unknown[];
  sections: { media: boolean; provenance: boolean };
}

export interface PreparedFixtureArchive {
  archive: Buffer;
  entries: Array<{ body: Buffer; path: string }>;
  manifest: ArchiveManifest;
}

export function prepareFixtureModelInput(
  fixture: LogicalArchiveFixture,
  prepared: PreparedFixtureArchive,
): ValidateArchiveModelInput {
  const payloadEntries = prepared.entries.slice(2);
  const entries: ArchiveEntryEvidence[] = payloadEntries.map(({ body, path }) => ({
    byteLength: body.byteLength.toString(),
    path,
    sha256: sha256Hex(body),
  }));
  const checksumBody = prepared.entries.find((entry) => entry.path === 'checksums.sha256')?.body;
  if (checksumBody === undefined) throw new Error('Missing fixture checksum entry');
  const checksumEntries = parseChecksumFile(checksumBody.toString('utf8'));
  const offsets = new Map<ArchiveRecordFamily, number>();
  const records: ArchiveRecordEnvelope[] = [];
  for (const descriptor of prepared.manifest.files) {
    const offset = offsets.get(descriptor.family) ?? 0;
    const familyRecords = fixture[descriptor.family].slice(offset, offset + descriptor.recordCount);
    for (const [index, record] of familyRecords.entries()) {
      records.push({
        archivePath: descriptor.path,
        line: index + 1,
        record,
      });
    }
    offsets.set(descriptor.family, offset + descriptor.recordCount);
  }
  return {
    checksumEntries,
    entries,
    manifest: prepared.manifest,
    records,
  };
}

export async function loadLogicalFixture(name: 'full' | 'minimal'): Promise<LogicalArchiveFixture> {
  const path = fileURLToPath(
    new URL(`./fixtures/archive/v1/${name}/fixture.json`, import.meta.url),
  );
  return JSON.parse(await readFile(path, 'utf8')) as LogicalArchiveFixture;
}

async function collectWritable(run: (output: Writable) => Promise<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await run(output);
  return Buffer.concat(chunks);
}

function countMissingMedia(records: readonly unknown[]): ArchiveManifest['missingMedia'] {
  let references = 0;
  const known = new Map<string, bigint>();
  for (const value of records) {
    const record = value as {
      original?: {
        byteLength: string;
        detectedMimeType: string;
        included: boolean;
        sha256: string;
      } | null;
    };
    if (record.original?.included) continue;
    references += 1;
    if (record.original !== null && record.original !== undefined) {
      known.set(
        `${record.original.sha256}\0${record.original.byteLength}\0${record.original.detectedMimeType}`,
        BigInt(record.original.byteLength),
      );
    }
  }
  return {
    knownBytes: [...known.values()].reduce((sum, value) => sum + value, 0n).toString(),
    references,
    uniqueObjects: known.size,
  };
}

export async function prepareFixtureArchive(
  fixture: LogicalArchiveFixture,
  options: {
    mutateEntries?: (entries: Array<{ body: Buffer; path: string }>) => void;
    mutateManifest?: (manifest: ArchiveManifest) => void;
    reorderTarEntries?: (entries: Array<{ body: Buffer; path: string }>) => void;
  } = {},
): Promise<PreparedFixtureArchive> {
  const dataEntries: Array<{
    body: Buffer;
    family: ArchiveRecordFamily;
    path: string;
    recordCount: number;
    shardIndex: number;
  }> = [];
  for (const family of FAMILY_ORDER) {
    const records = fixture[family];
    for await (const shard of encodeJsonlShards(records, {
      family,
      maxLineBytes: 4 * 1_024 * 1_024,
      maxRecords: 1_000_000,
    })) {
      dataEntries.push({
        body: Buffer.from(shard.bytes),
        family,
        path: shard.path,
        recordCount: shard.recordCount,
        shardIndex: shard.shardIndex,
      });
    }
  }

  const blobEntries = fixture.blobs
    .map((blob) => ({ body: Buffer.from(blob.utf8), path: archiveBlobPath(blob.sha256) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const payloadEntries = [...dataEntries.map(({ body, path }) => ({ body, path })), ...blobEntries];
  options.mutateEntries?.(payloadEntries);

  const checksumEntries: ChecksumEntry[] = payloadEntries.map(({ body, path }) => ({
    byteLength: body.byteLength.toString(),
    path,
    sha256: sha256Hex(body),
  }));
  const checksumBody = Buffer.from(renderChecksumFile(checksumEntries));
  const dataBytes = dataEntries
    .filter((entry) => !entry.family.startsWith('provenance-'))
    .reduce((sum, entry) => sum + BigInt(entry.body.byteLength), 0n);
  const provenanceBytes = dataEntries
    .filter((entry) => entry.family.startsWith('provenance-'))
    .reduce((sum, entry) => sum + BigInt(entry.body.byteLength), 0n);
  const blobBytes = blobEntries.reduce((sum, entry) => sum + BigInt(entry.body.byteLength), 0n);
  const messages = fixture.messages as Array<{ visibility: { state: 'hidden' | 'public' } }>;
  const manifest: ArchiveManifest = {
    checksumFile: {
      byteLength: checksumBody.byteLength.toString(),
      path: 'checksums.sha256',
      sha256: sha256Hex(checksumBody),
    },
    counts: {
      blobs: blobEntries.length,
      channels: fixture.channels.length,
      hiddenMessages: messages.filter((record) => record.visibility.state === 'hidden').length,
      messages: messages.length,
      provenanceMedia: fixture['provenance-media'].length,
      provenanceObservations: fixture['provenance-observations'].length,
      revisionMedia: fixture['revision-media'].length,
      revisions: fixture.revisions.length,
      visibleMessages: messages.filter((record) => record.visibility.state === 'public').length,
    },
    createdAt: '2026-08-03T00:00:00.000Z',
    exporter: { name: 'koharu-suite', version: '0.4.1' },
    files: dataEntries.map((entry) => ({
      byteLength: entry.body.byteLength.toString(),
      family: entry.family,
      path: entry.path,
      recordCount: entry.recordCount,
      shardIndex: entry.shardIndex,
    })),
    format: ARCHIVE_FORMAT_NAME,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    logicalBytes: {
      blobs: blobBytes.toString(),
      data: dataBytes.toString(),
      provenance: provenanceBytes.toString(),
      total: (dataBytes + provenanceBytes + blobBytes).toString(),
    },
    missingMedia: countMissingMedia(fixture['revision-media']),
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    sections: fixture.sections,
    selection: { mode: 'all' },
    snapshotAt: '2026-08-03T00:00:00.000Z',
  };
  options.mutateManifest?.(manifest);
  const manifestBody = Buffer.from(canonicalJsonBytes(manifest, { profile: 'manifest' }));
  const entries = [
    { body: manifestBody, path: 'manifest.json' },
    { body: checksumBody, path: 'checksums.sha256' },
    ...payloadEntries,
  ];
  options.reorderTarEntries?.(entries);
  const archiveEntries: ArchiveWriteEntry[] = entries.map(({ body, path }) => ({
    body: Readable.from([body]),
    byteLength: body.byteLength,
    path,
  }));
  const archive = await collectWritable((output) => writeTarZstd(archiveEntries, output));
  return { archive, entries, manifest };
}
