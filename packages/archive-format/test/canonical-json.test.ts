import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  canonicalJsonBytes,
  serializeCanonicalJson,
} from '../src/canonical-json.js';
import {
  ARCHIVE_FORMAT_NAME,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  archiveManifestSchema,
} from '../src/schemas.js';

describe('canonical JSON', () => {
  it('sorts object keys by locale-independent code-unit order at every level', () => {
    expect(
      serializeCanonicalJson({
        z: 1,
        a: { beta: true, alpha: null },
        list: [{ y: 2, x: 1 }],
      }),
    ).toBe('{"a":{"alpha":null,"beta":true},"list":[{"x":1,"y":2}],"z":1}');
  });

  it('returns deterministic UTF-8 bytes', () => {
    expect(Buffer.from(canonicalJsonBytes({ emoji: '小春' })).toString('utf8')).toBe(
      '{"emoji":"小春"}',
    );
  });

  it('rejects values outside the bounded JSON contract before recursive serialization', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 40; index += 1) deep = { nested: deep };

    expect(() => serializeCanonicalJson(deep)).toThrow(CanonicalJsonError);
    expect(() => serializeCanonicalJson({ missing: undefined })).toThrow(CanonicalJsonError);
    expect(() => serializeCanonicalJson({ value: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => serializeCanonicalJson(new Date())).toThrow(CanonicalJsonError);
  });

  it('rejects sparse and cyclic input without echoing its contents', () => {
    const sparse = new Array(2);
    sparse[1] = 'private-message-body';
    const cyclic: Record<string, unknown> = { secret: 'private-message-body' };
    cyclic.self = cyclic;

    for (const value of [sparse, cyclic]) {
      try {
        serializeCanonicalJson(value);
        throw new Error('Expected serialization to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(CanonicalJsonError);
        expect((error as Error).message).not.toContain('private-message-body');
      }
    }
  });

  it('uses a finite manifest profile for inventories larger than generic JSON payloads', () => {
    const fileCount = 4_097;
    const manifest = archiveManifestSchema.parse({
      checksumFile: { byteLength: '1', path: 'checksums.sha256', sha256: 'a'.repeat(64) },
      counts: {
        blobs: 0,
        channels: fileCount,
        hiddenMessages: 0,
        messages: 0,
        provenanceMedia: 0,
        provenanceObservations: 0,
        revisionMedia: 0,
        revisions: 0,
        visibleMessages: 0,
      },
      createdAt: '2026-08-03T00:00:00.000Z',
      exporter: { name: 'koharu-suite', version: '0.4.1' },
      files: Array.from({ length: fileCount }, (_, shardIndex) => ({
        byteLength: '1',
        family: 'channels',
        path: `data/channels/${shardIndex.toString().padStart(6, '0')}.jsonl`,
        recordCount: 1,
        shardIndex,
      })),
      format: ARCHIVE_FORMAT_NAME,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      logicalBytes: {
        blobs: '0',
        data: fileCount.toString(),
        provenance: '0',
        total: fileCount.toString(),
      },
      missingMedia: { knownBytes: '0', references: 0, uniqueObjects: 0 },
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      sections: { media: false, provenance: false },
      selection: { mode: 'all' },
      snapshotAt: '2026-08-03T00:00:00.000Z',
    });

    expect(() => serializeCanonicalJson(manifest)).toThrow(CanonicalJsonError);
    expect(serializeCanonicalJson(manifest, { profile: 'manifest' })).toContain(
      'data/channels/004096.jsonl',
    );
  });
});
