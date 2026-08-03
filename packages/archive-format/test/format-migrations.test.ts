import { describe, expect, it } from 'vitest';
import {
  ArchiveCompatibilityError,
  parseSupportedArchiveManifest,
} from '../src/format-migrations.js';
import {
  ARCHIVE_FORMAT_NAME,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveManifest,
} from '../src/schemas.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const NOW = '2026-08-03T00:00:00.000Z';

function currentManifest(): ArchiveManifest {
  return {
    checksumFile: {
      byteLength: '0',
      path: 'checksums.sha256',
      sha256: EMPTY_SHA256,
    },
    counts: {
      blobs: 0,
      channels: 0,
      hiddenMessages: 0,
      messages: 0,
      provenanceMedia: 0,
      provenanceObservations: 0,
      revisionMedia: 0,
      revisions: 0,
      visibleMessages: 0,
    },
    createdAt: NOW,
    exporter: { name: 'koharu-suite', version: '0.4.1' },
    files: [],
    format: ARCHIVE_FORMAT_NAME,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    logicalBytes: { blobs: '0', data: '0', provenance: '0', total: '0' },
    missingMedia: { knownBytes: '0', references: 0, uniqueObjects: 0 },
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    sections: { media: false, provenance: false },
    selection: { mode: 'all' },
    snapshotAt: NOW,
  };
}

function compatibilityError(input: unknown): ArchiveCompatibilityError {
  try {
    parseSupportedArchiveManifest(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveCompatibilityError);
    return error as ArchiveCompatibilityError;
  }
  throw new Error('Expected archive compatibility parsing to fail');
}

describe('archive format compatibility', () => {
  it('accepts the current strict manifest contract', () => {
    const manifest = currentManifest();
    expect(parseSupportedArchiveManifest(manifest)).toEqual(manifest);
  });

  it('fails closed on a future format and preserves its minimum suite version', () => {
    const error = compatibilityError({
      format: ARCHIVE_FORMAT_NAME,
      formatVersion: ARCHIVE_FORMAT_VERSION + 1,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      minimumSuiteVersion: '0.9.0',
    });

    expect(error.code).toBe('FUTURE_FORMAT_VERSION');
    expect(error.minimumSuiteVersion).toBe('0.9.0');
    expect(error.observedFormatVersion).toBe(ARCHIVE_FORMAT_VERSION + 1);
  });

  it('fails closed on a future schema and preserves its minimum suite version', () => {
    const error = compatibilityError({
      format: ARCHIVE_FORMAT_NAME,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      schemaVersion: ARCHIVE_SCHEMA_VERSION + 1,
      minimumSuiteVersion: '0.8.0',
    });

    expect(error.code).toBe('FUTURE_SCHEMA_VERSION');
    expect(error.minimumSuiteVersion).toBe('0.8.0');
  });

  it('rejects an unsupported older format version through the migration registry boundary', () => {
    const error = compatibilityError({
      format: ARCHIVE_FORMAT_NAME,
      formatVersion: 0,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
    });

    expect(error.code).toBe('UNSUPPORTED_FORMAT_VERSION');
    expect(error.observedFormatVersion).toBe(0);
  });

  it('rejects an unsupported older schema version through the migration registry boundary', () => {
    const error = compatibilityError({
      format: ARCHIVE_FORMAT_NAME,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      schemaVersion: 0,
    });

    expect(error.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });

  it('rejects an unknown archive format before strict manifest parsing', () => {
    const error = compatibilityError({
      format: 'another-product-archive',
      formatVersion: ARCHIVE_FORMAT_VERSION,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      minimumSuiteVersion: '999.0.0',
    });

    expect(error.code).toBe('UNKNOWN_ARCHIVE_FORMAT');
    expect(error.minimumSuiteVersion).toBeNull();
    expect(error.observedFormatVersion).toBeNull();
  });

  it('rejects an invalid current manifest without disclosing input content', () => {
    const privateContent = 'private Telegram message body from /Users/owner/export';
    const error = compatibilityError({
      ...currentManifest(),
      unexpectedPayload: privateContent,
    });

    expect(error.code).toBe('INVALID_MANIFEST');
    expect(error.message).not.toContain(privateContent);
    expect(error.message).not.toContain('/Users/owner');
  });

  it('rejects unsafe minimum-version hints without retaining their content', () => {
    const privateHint = '/Users/owner/private-version';
    const error = compatibilityError({
      format: ARCHIVE_FORMAT_NAME,
      formatVersion: ARCHIVE_FORMAT_VERSION + 1,
      minimumSuiteVersion: privateHint,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
    });
    expect(error.code).toBe('INVALID_MANIFEST');
    expect(error.minimumSuiteVersion).toBeNull();
    expect(error.message).not.toContain(privateHint);
  });
});
