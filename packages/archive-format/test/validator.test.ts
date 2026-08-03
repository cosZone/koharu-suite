import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ArchiveContainerError } from '../src/entry-policy.js';
import { ArchiveValidationError, validateTarZstdArchive } from '../src/validator.js';
import {
  type LogicalArchiveFixture,
  loadLogicalFixture,
  prepareFixtureArchive,
} from './archive-fixture.js';

async function captureValidationError(
  archive: Buffer,
  options = {},
): Promise<ArchiveValidationError> {
  try {
    await validateTarZstdArchive(Readable.from([archive]), options);
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveValidationError);
    return error as ArchiveValidationError;
  }
  throw new Error('Expected archive validation to fail');
}

describe('portable archive v1 validator', () => {
  it('streams the committed minimal and full fixtures through every format layer', async () => {
    const minimal = await prepareFixtureArchive(await loadLogicalFixture('minimal'));
    const minimalResult = await validateTarZstdArchive(Readable.from([minimal.archive]));
    expect(minimalResult.report.status).toBe('clean');
    expect(minimalResult.report.counts).toMatchObject({
      channels: 1,
      hiddenMessages: 1,
      mediaMissing: 1,
      messages: 2,
      visibleMessages: 1,
    });

    const full = await prepareFixtureArchive(await loadLogicalFixture('full'));
    const fullResult = await validateTarZstdArchive(Readable.from([full.archive]));
    expect(fullResult.report.status).toBe('clean');
    expect(fullResult.report.counts).toMatchObject({
      blobs: 1,
      mediaPresent: 2,
      provenanceRecords: 2,
      revisionMedia: 2,
    });
    expect(fullResult.artifactByteLength).toBe(full.archive.byteLength.toString());
    expect(fullResult.artifactSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('writes deterministic compressed bytes and rejects non-canonical tar entry order', async () => {
    const fixture = await loadLogicalFixture('full');
    const first = await prepareFixtureArchive(fixture);
    const second = await prepareFixtureArchive(fixture);
    expect(second.archive).toEqual(first.archive);

    const reordered = await prepareFixtureArchive(fixture, {
      reorderTarEntries: (entries) => {
        const third = entries[2];
        const fourth = entries[3];
        if (third !== undefined && fourth !== undefined) [entries[2], entries[3]] = [fourth, third];
      },
    });
    const error = await captureValidationError(reordered.archive);
    expect(error.report.issues[0]?.sanitizedReason).toBe('extra_archive_entry');
  });

  it('rejects non-canonical JSONL even when its reconciled checksum is valid', async () => {
    const fixture = await loadLogicalFixture('minimal');
    const nonCanonical = await prepareFixtureArchive(fixture, {
      mutateEntries: (entries) => {
        const shard = entries.find((entry) => entry.path.startsWith('data/channels/'));
        if (shard !== undefined) {
          shard.body = Buffer.from(
            '{"username":"fixture_channel","title":"Fixture channel","telegramChatId":"-9007199254740994","recordType":"channel"}\n',
          );
        }
      },
    });
    const error = await captureValidationError(nonCanonical.archive);
    expect(error.report.issues[0]).toMatchObject({
      archivePath: 'data/channels/000000.jsonl',
      byteOffset: 0,
      line: 1,
      sanitizedReason: 'non_canonical_json',
    });
  });

  it('rejects a payload changed after checksums were prepared', async () => {
    const corrupt = await prepareFixtureArchive(await loadLogicalFixture('minimal'), {
      reorderTarEntries: (entries) => {
        const shard = entries.find((entry) => entry.path.startsWith('data/channels/'));
        if (shard !== undefined) shard.body[0] = (shard.body[0] ?? 0) ^ 1;
      },
    });
    const error = await captureValidationError(corrupt.archive);
    expect(error.report.issues[0]?.sanitizedReason).toMatch(/invalid_json|entry_digest_mismatch/u);
  });

  it('rejects dangling current revisions and source-machine paths without exposing content', async () => {
    const danglingFixture = await loadLogicalFixture('minimal');
    (danglingFixture.messages[0] as { currentRevisionNumber: number }).currentRevisionNumber = 2;
    const dangling = await prepareFixtureArchive(danglingFixture);
    const danglingError = await captureValidationError(dangling.archive);
    expect(danglingError.code).toBe('MODEL_INVALID');
    expect(
      danglingError.report.issues.some(
        (issue) => issue.sanitizedReason === 'dangling_current_revision',
      ),
    ).toBe(true);

    const pathFixture = await loadLogicalFixture('full');
    (pathFixture['provenance-observations'][0] as { payload: unknown }).payload = {
      photo: 'photos/photo_1.jpg',
    };
    const pathArchive = await prepareFixtureArchive(pathFixture);
    const pathError = await captureValidationError(pathArchive.archive);
    expect(
      pathError.report.issues.some((issue) => issue.sanitizedReason === 'record_schema_invalid'),
    ).toBe(true);
    expect(JSON.stringify(pathError.report)).not.toContain('photos/photo_1.jpg');
  });

  it.each([
    ['direct host path', '/Users/owner/private/result.json'],
    ['single-segment host path', '/app'],
    ['host path in an array', ['C:\\owner\\private\\result.json']],
    ['host file URI', { uri: 'file:///Users/owner/private/result.json' }],
    ['attachment path', { attachment: 'photos/photo_1.jpg' }],
    ['nested attachment path', { attachment: ['photos/photo_1.jpg'] }],
    ['database UUID', { databaseId: '123e4567-e89b-12d3-a456-426614174000' }],
    ['nested database UUID', { recordId: ['123e4567-e89b-12d3-a456-426614174000'] }],
    ['opaque deployment UUID', { value: '123e4567-e89b-12d3-a456-426614174000' }],
    ['database URL in an opaque value', { value: 'postgresql://owner:secret@database/db' }],
    ['bearer token in an opaque value', { header: 'Bearer private-access-token' }],
    ['JWT in an opaque value', { value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature' }],
    ['path hidden under a text object', { text: { source: '/Users/owner/private.json' } }],
    ['API key', { APIKey: 'private-api-key' }],
    ['ID token', { IDToken: 'private-id-token' }],
    ['JWT token', { JWTToken: 'private-jwt-token' }],
    ['private key', { privateKey: 'private-signing-key' }],
    ['access key', { accessKey: 'private-access-key' }],
    ['connection string', { connectionString: 'postgresql://private@database/db' }],
    ['DSN', { dsn: 'postgresql://private@database/db' }],
    ['passwd', { passwd: 'private-password' }],
    ['credential collection', { credentials: ['private-credential'] }],
  ])('rejects privacy-sensitive provenance payloads: %s', async (_label, payload) => {
    const fixture = await loadLogicalFixture('full');
    (fixture['provenance-observations'][0] as { payload: unknown }).payload = payload;
    const prepared = await prepareFixtureArchive(fixture);
    const error = await captureValidationError(prepared.archive);
    expect(error.report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sanitizedReason: 'record_schema_invalid' }),
      ]),
    );
    expect(JSON.stringify(error.report)).not.toContain(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    );
  });

  it('preserves user content that only resembles a command or UUID', async () => {
    const fixture = await loadLogicalFixture('full');
    (fixture.revisions[0] as { text: string }).text =
      '/start 550e8400-e29b-41d4-a716-446655440000 postgresql://shown-in-user-content';
    const prepared = await prepareFixtureArchive(fixture);
    await expect(validateTarZstdArchive(Readable.from([prepared.archive]))).resolves.toMatchObject({
      report: { status: 'clean' },
    });
  });

  it('reports a safe upgrade hint for a future archive envelope', async () => {
    const prepared = await prepareFixtureArchive(await loadLogicalFixture('minimal'), {
      mutateManifest: (manifest) => {
        const envelope = manifest as unknown as Record<string, unknown>;
        envelope.formatVersion = 2;
        envelope.minimumSuiteVersion = '0.9.0';
      },
    });
    const error = await captureValidationError(prepared.archive);
    expect(error.report).toMatchObject({
      formatVersion: 2,
      minimumSuiteVersion: '0.9.0',
    });
    expect(error.report.issues[0]?.sanitizedReason).toBe('future_format_version');
  });

  it('reports unsupported format zero without breaking the report schema', async () => {
    const prepared = await prepareFixtureArchive(await loadLogicalFixture('minimal'), {
      mutateManifest: (manifest) => {
        const envelope = manifest as unknown as Record<string, unknown>;
        envelope.formatVersion = 0;
        envelope.minimumSuiteVersion = '999.0.0';
      },
    });
    const error = await captureValidationError(prepared.archive);
    expect(error.report).toMatchObject({ formatVersion: 0, minimumSuiteVersion: null });
    expect(error.report.issues[0]?.sanitizedReason).toBe('unsupported_format_version');
  });

  it('does not trust upgrade hints from another archive format', async () => {
    const prepared = await prepareFixtureArchive(await loadLogicalFixture('minimal'), {
      mutateManifest: (manifest) => {
        const envelope = manifest as unknown as Record<string, unknown>;
        envelope.format = 'another-product-archive';
        envelope.formatVersion = 999;
        envelope.minimumSuiteVersion = '999.0.0';
      },
    });
    const error = await captureValidationError(prepared.archive);
    expect(error.report).toMatchObject({ formatVersion: 1, minimumSuiteVersion: null });
    expect(error.report.issues[0]?.sanitizedReason).toBe('unknown_archive_format');
  });

  it('sanitizes cyclic error causes instead of recursing indefinitely', async () => {
    const cause = new ArchiveContainerError('INVALID_ARCHIVE_CONTAINER', 'hostile nested cause');
    Object.defineProperty(cause, 'cause', { configurable: true, value: cause });
    const controller = new AbortController();
    controller.abort(cause);

    const error = await captureValidationError(Buffer.alloc(0), {
      signal: controller.signal,
    });
    expect(error.report.issues[0]).toMatchObject({ sanitizedReason: 'archive_aborted' });
    expect(JSON.stringify(error.report)).not.toContain('hostile nested cause');
  });

  it('preflights a finite global record budget before payload eligibility', async () => {
    const prepared = await prepareFixtureArchive(await loadLogicalFixture('minimal'));
    const error = await captureValidationError(prepared.archive, {
      limits: { maxTotalRecords: 1 },
    });
    expect(error.code).toBe('RESOURCE_LIMIT_EXCEEDED');
    expect(error.report.issues[0]?.sanitizedReason).toBe('record_limit_exceeded');
  });

  it('rejects a BOM-prefixed manifest instead of normalizing its raw bytes', async () => {
    const prepared = await prepareFixtureArchive(await loadLogicalFixture('minimal'), {
      reorderTarEntries: (entries) => {
        const manifest = entries.find((entry) => entry.path === 'manifest.json');
        if (manifest !== undefined) {
          manifest.body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), manifest.body]);
        }
      },
    });
    const error = await captureValidationError(prepared.archive);
    expect(error.report.issues[0]?.sanitizedReason).toBe('manifest_json_invalid');
  });

  it('streams 100,000 records across shard boundaries under the global budget', async () => {
    const channels = Array.from({ length: 100_000 }, (_, index) => ({
      recordType: 'channel',
      telegramChatId: String(-100_000 + index),
      title: `channel-${index}`,
      username: null,
    }));
    const fixture: LogicalArchiveFixture = {
      blobs: [],
      channels,
      messages: [],
      'provenance-media': [],
      'provenance-observations': [],
      'revision-media': [],
      revisions: [],
      sections: { media: false, provenance: false },
    };
    const prepared = await prepareFixtureArchive(fixture);
    expect(prepared.manifest.files).toHaveLength(2);
    const result = await validateTarZstdArchive(Readable.from([prepared.archive]));
    expect(result.report.status).toBe('clean');
    expect(result.model.records).toBe(100_000);
  }, 60_000);
});
