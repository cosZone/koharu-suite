import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_FORMAT_NAME,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveManifest,
  archiveManifestSchema,
  archiveProvenanceObservationRecordSchema,
  archiveRecordSchema,
  compareCanonicalInt64Decimals,
  DEFAULT_ARCHIVE_SHARD_BYTES,
  DEFAULT_ARCHIVE_SHARD_RECORDS,
  isBoundedJsonValue,
  telegramChatIdSchema,
  telegramMessageIdSchema,
} from '../src/schemas.js';

const HASH = 'a'.repeat(64);
const NOW = '2026-08-03T00:00:00.000Z';

function validManifest(): ArchiveManifest {
  return {
    format: ARCHIVE_FORMAT_NAME,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    exporter: { name: 'koharu-suite', version: '0.4.1' },
    createdAt: NOW,
    snapshotAt: NOW,
    selection: { mode: 'all' },
    sections: { media: false, provenance: false },
    counts: {
      blobs: 0,
      channels: 1,
      hiddenMessages: 0,
      messages: 1,
      provenanceMedia: 0,
      provenanceObservations: 0,
      revisionMedia: 1,
      revisions: 1,
      visibleMessages: 1,
    },
    files: [
      {
        byteLength: '10',
        family: 'channels',
        path: 'data/channels/000000.jsonl',
        recordCount: 1,
        shardIndex: 0,
      },
      {
        byteLength: '11',
        family: 'messages',
        path: 'data/messages/000000.jsonl',
        recordCount: 1,
        shardIndex: 0,
      },
      {
        byteLength: '12',
        family: 'revisions',
        path: 'data/revisions/000000.jsonl',
        recordCount: 1,
        shardIndex: 0,
      },
      {
        byteLength: '13',
        family: 'revision-media',
        path: 'data/revision-media/000000.jsonl',
        recordCount: 1,
        shardIndex: 0,
      },
    ],
    checksumFile: { byteLength: '80', path: 'checksums.sha256', sha256: HASH },
    logicalBytes: { blobs: '0', data: '46', provenance: '0', total: '46' },
    missingMedia: { knownBytes: '0', references: 1, uniqueObjects: 0 },
  };
}

function manifestFile(manifest: ArchiveManifest, index: number): ArchiveManifest['files'][number] {
  const file = manifest.files[index];
  if (file === undefined) throw new Error(`Missing manifest fixture file ${index}`);
  return file;
}

describe('archive wire schemas', () => {
  it('accepts shared JSON subtrees while still rejecting real cycles', () => {
    const shared = { value: 'portable' };
    expect(isBoundedJsonValue({ first: shared, second: shared })).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isBoundedJsonValue(cyclic)).toBe(false);
  });

  it('accepts a complete strict manifest with deterministic shard inventory', () => {
    expect(archiveManifestSchema.parse(validManifest())).toEqual(validManifest());
  });

  it('rejects unknown fields, empty shards, count drift, and non-contiguous shard indexes', () => {
    expect(
      archiveManifestSchema.safeParse({ ...validManifest(), secret: 'must-not-be-ignored' })
        .success,
    ).toBe(false);

    const emptyShard = validManifest();
    emptyShard.files[0] = { ...manifestFile(emptyShard, 0), recordCount: 0 };
    expect(archiveManifestSchema.safeParse(emptyShard).success).toBe(false);

    const drift = validManifest();
    drift.counts.messages = 2;
    drift.counts.visibleMessages = 2;
    expect(archiveManifestSchema.safeParse(drift).success).toBe(false);

    const skippedShard = validManifest();
    skippedShard.files[1] = {
      ...manifestFile(skippedShard, 1),
      path: 'data/messages/000001.jsonl',
      shardIndex: 1,
    };
    expect(archiveManifestSchema.safeParse(skippedShard).success).toBe(false);

    const oversizedCount = validManifest();
    oversizedCount.files[0] = {
      ...manifestFile(oversizedCount, 0),
      recordCount: DEFAULT_ARCHIVE_SHARD_RECORDS + 1,
    };
    expect(archiveManifestSchema.safeParse(oversizedCount).success).toBe(false);

    const oversizedBytes = validManifest();
    oversizedBytes.files[0] = {
      ...manifestFile(oversizedBytes, 0),
      byteLength: String(DEFAULT_ARCHIVE_SHARD_BYTES + 1),
    };
    expect(archiveManifestSchema.safeParse(oversizedBytes).success).toBe(false);
  });

  it('accepts an empty checksum file descriptor and enforces cross-field manifest invariants', () => {
    const empty = validManifest();
    empty.checksumFile.byteLength = '0';
    expect(archiveManifestSchema.safeParse(empty).success).toBe(true);

    const beforeSnapshot = validManifest();
    beforeSnapshot.createdAt = '2026-08-02T23:59:59.000Z';
    expect(archiveManifestSchema.safeParse(beforeSnapshot).success).toBe(false);

    const disabledMediaBytes = validManifest();
    disabledMediaBytes.logicalBytes.blobs = '1';
    disabledMediaBytes.logicalBytes.total = '47';
    expect(archiveManifestSchema.safeParse(disabledMediaBytes).success).toBe(false);

    const impossibleMissingObjects = validManifest();
    impossibleMissingObjects.missingMedia.uniqueObjects = 2;
    expect(archiveManifestSchema.safeParse(impossibleMissingObjects).success).toBe(false);

    const ownerlessKnownBytes = validManifest();
    ownerlessKnownBytes.missingMedia.knownBytes = '1';
    expect(archiveManifestSchema.safeParse(ownerlessKnownBytes).success).toBe(false);
  });

  it('bounds canonical Telegram identifiers to signed int64', () => {
    expect(telegramChatIdSchema.safeParse('-9223372036854775808').success).toBe(true);
    expect(telegramChatIdSchema.safeParse('-9223372036854775809').success).toBe(false);
    expect(telegramChatIdSchema.safeParse('1').success).toBe(false);
    expect(telegramMessageIdSchema.safeParse('9223372036854775807').success).toBe(true);
    expect(telegramMessageIdSchema.safeParse('9223372036854775808').success).toBe(false);
    expect(telegramMessageIdSchema.safeParse('01').success).toBe(false);
    expect(compareCanonicalInt64Decimals('-10', '-2')).toBeLessThan(0);
  });

  it('enforces visibility timestamps and rejects undeclared extension fields', () => {
    const base = {
      recordType: 'message',
      telegramChatId: '-1001338193436',
      telegramMessageId: '3902',
      publishedAt: NOW,
      currentRevisionNumber: 1,
    };
    expect(
      archiveRecordSchema.safeParse({ ...base, visibility: { state: 'hidden', changedAt: null } })
        .success,
    ).toBe(false);
    expect(
      archiveRecordSchema.safeParse({
        ...base,
        visibility: { state: 'public', changedAt: null },
        extensions: { 'future-field': { enabled: true } },
      }).success,
    ).toBe(false);
    expect(
      archiveRecordSchema.safeParse({
        ...base,
        visibility: { state: 'public', changedAt: null },
        future: true,
      }).success,
    ).toBe(false);
  });

  it('preserves source-discriminated provenance without accepting desktop host paths', () => {
    const provenance = {
      recordType: 'provenance-observation',
      telegramChatId: '-1001338193436',
      telegramMessageId: '3902',
      revisionNumber: 1,
      source: {
        kind: 'telegram_desktop_json',
        sourceFileSha256: HASH,
        sourceChatId: '1338193436',
        sourceMessageId: '3902',
      },
      observedAt: NOW,
      metadata: {},
      payload: { type: 'message' },
    };
    expect(archiveProvenanceObservationRecordSchema.safeParse(provenance).success).toBe(true);
    expect(
      archiveProvenanceObservationRecordSchema.safeParse({
        ...provenance,
        payload: { type: 'message', unknownRawField: 'secret' },
      }).success,
    ).toBe(false);
    expect(
      archiveProvenanceObservationRecordSchema.safeParse({
        ...provenance,
        source: { ...provenance.source, sourcePath: '/Users/owner/export/result.json' },
      }).success,
    ).toBe(false);
  });

  it('rejects path-bearing portable media file names and metadata', () => {
    const media = {
      recordType: 'revision-media',
      telegramChatId: '-1001338193436',
      telegramMessageId: '3902',
      revisionNumber: 1,
      position: 0,
      kind: 'photo',
      availability: 'unavailable',
      mimeType: null,
      fileName: null,
      fileSize: null,
      width: null,
      height: null,
      duration: null,
      source: {
        kind: 'telegram_desktop_json',
        telegramFileId: null,
        telegramFileUniqueId: null,
        mediaType: 'photo',
        metadata: {},
      },
      original: null,
    };
    expect(
      archiveRecordSchema.safeParse({ ...media, fileName: 'photos/photo_1.jpg' }).success,
    ).toBe(false);
    expect(
      archiveRecordSchema.safeParse({
        ...media,
        source: { ...(media.source as object), metadata: { path: '/Users/owner/file' } },
      }).success,
    ).toBe(false);
  });

  it('rejects deeply nested or oversized JSON metadata without recursive parsing', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 40; index += 1) deep = { nested: deep };
    expect(isBoundedJsonValue(deep)).toBe(false);
    expect(isBoundedJsonValue({ safe: ['value', 1, true, null] })).toBe(true);
  });
});
