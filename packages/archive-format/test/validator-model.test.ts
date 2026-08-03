import { describe, expect, it } from 'vitest';
import { serializeCanonicalJson } from '../src/canonical-json.js';
import { JsonlError } from '../src/jsonl.js';
import {
  type ArchiveRecordEnvelope,
  ArchiveValidationError,
  validateArchiveModel,
} from '../src/validator.js';
import {
  loadLogicalFixture,
  prepareFixtureArchive,
  prepareFixtureModelInput,
} from './archive-fixture.js';

async function fixtureModel() {
  const fixture = await loadLogicalFixture('minimal');
  const prepared = await prepareFixtureArchive(fixture);
  return prepareFixtureModelInput(fixture, prepared);
}

async function captureModelError(run: () => Promise<unknown>): Promise<ArchiveValidationError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveValidationError);
    return error as ArchiveValidationError;
  }
  throw new Error('Expected model validation to fail');
}

describe('portable archive public model validator', () => {
  it('binds record envelopes to manifest shard paths, lines, and evidence', async () => {
    const clean = await fixtureModel();
    await expect(validateArchiveModel(clean)).resolves.toMatchObject({
      report: { status: 'clean' },
    });

    const wrongEnvelope = await fixtureModel();
    const first = (wrongEnvelope.records as ArchiveRecordEnvelope[])[0];
    if (first === undefined) throw new Error('Missing model record');
    first.archivePath = 'data/channels/000001.jsonl';
    const envelopeError = await captureModelError(() => validateArchiveModel(wrongEnvelope));
    expect(envelopeError.report.issues[0]?.sanitizedReason).toBe('record_envelope_mismatch');

    const wrongEvidence = await fixtureModel();
    const channelEvidence = wrongEvidence.entries[0];
    if (channelEvidence === undefined) throw new Error('Missing entry evidence');
    channelEvidence.byteLength = String(Number(channelEvidence.byteLength) + 1);
    const evidenceError = await captureModelError(() => validateArchiveModel(wrongEvidence));
    expect(evidenceError.report.issues.map((issue) => issue.sanitizedReason)).toEqual(
      expect.arrayContaining(['entry_checksum_mismatch', 'shard_length_mismatch']),
    );

    const wrongChecksumDescriptor = await fixtureModel();
    wrongChecksumDescriptor.manifest.checksumFile.sha256 = 'f'.repeat(64);
    const checksumError = await captureModelError(() =>
      validateArchiveModel(wrongChecksumDescriptor),
    );
    expect(checksumError.report.issues.map((issue) => issue.sanitizedReason)).toContain(
      'checksum_file_descriptor_mismatch',
    );

    const wrongChecksumOrder = await fixtureModel();
    wrongChecksumOrder.checksumEntries = [...wrongChecksumOrder.checksumEntries].reverse();
    const orderError = await captureModelError(() => validateArchiveModel(wrongChecksumOrder));
    expect(orderError.report.issues.map((issue) => issue.sanitizedReason)).toContain(
      'checksum_order_mismatch',
    );
  });

  it('aborts stalled model iterators and sanitizes hostile envelope locations', async () => {
    const stalled = await fixtureModel();
    stalled.records = {
      async *[Symbol.asyncIterator]() {
        await new Promise(() => undefined);
      },
    };
    const stalledError = await captureModelError(() =>
      validateArchiveModel(stalled, { limits: { noProgressTimeoutMs: 20 } }),
    );
    expect(stalledError.report.issues[0]?.sanitizedReason).toBe('no_progress_timeout');

    const aborted = await fixtureModel();
    const controller = new AbortController();
    controller.abort();
    const abortError = await captureModelError(() =>
      validateArchiveModel(aborted, { signal: controller.signal }),
    );
    expect(abortError.report.issues[0]?.sanitizedReason).toBe('archive_aborted');

    const raced = await fixtureModel();
    let nextCalls = 0;
    raced.records = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            nextCalls += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const racedController = new AbortController();
    const originalAdd = racedController.signal.addEventListener.bind(racedController.signal);
    racedController.signal.addEventListener = ((
      ...args: Parameters<AbortSignal['addEventListener']>
    ) => {
      originalAdd(...args);
      racedController.abort();
    }) as AbortSignal['addEventListener'];
    const racedError = await captureModelError(() =>
      validateArchiveModel(raced, { signal: racedController.signal }),
    );
    expect(racedError.report.issues[0]?.sanitizedReason).toBe('archive_aborted');
    expect(nextCalls).toBe(0);

    const hostile = await fixtureModel();
    hostile.records = [
      ...(hostile.records as ArchiveRecordEnvelope[]),
      { archivePath: '/Users/owner/private.jsonl', line: -1, record: {} },
    ];
    const hostileError = await captureModelError(() => validateArchiveModel(hostile));
    expect(JSON.stringify(hostileError.report)).not.toContain('/Users/owner');

    const invalidError = await fixtureModel();
    invalidError.records = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const error = new JsonlError('invalid_json', -1, -1);
            Object.defineProperty(error, 'code', { value: 'not_a_real_code' });
            throw error;
          },
        };
      },
    };
    const mappedError = await captureModelError(() => validateArchiveModel(invalidError));
    expect(mappedError.report.issues[0]).toMatchObject({
      sanitizedReason: 'internal_error',
    });
    expect(mappedError.report.issues[0]).not.toHaveProperty('line');
    expect(mappedError.report.issues[0]).not.toHaveProperty('byteOffset');
  });

  it('honors every lowered model-validation ceiling it exposes', async () => {
    const manifestLimited = await fixtureModel();
    const manifestError = await captureModelError(() =>
      validateArchiveModel(manifestLimited, { limits: { maxManifestBytes: 1 } }),
    );
    expect(manifestError.report.issues[0]?.sanitizedReason).toBe('manifest_size_limit_exceeded');

    const checksumLimited = await fixtureModel();
    const checksumError = await captureModelError(() =>
      validateArchiveModel(checksumLimited, { limits: { maxChecksumBytes: 1 } }),
    );
    expect(checksumError.report.issues[0]?.sanitizedReason).toBe('input_limit_exceeded');

    const lineLimited = await fixtureModel();
    const lineError = await captureModelError(() =>
      validateArchiveModel(lineLimited, { limits: { maxJsonlLineBytes: 1 } }),
    );
    expect(lineError.report.issues[0]?.sanitizedReason).toBe('line_size_limit_exceeded');

    const exactBoundary = await fixtureModel();
    const longestCanonicalLine = Math.max(
      ...(exactBoundary.records as ArchiveRecordEnvelope[]).map((envelope) =>
        Buffer.byteLength(serializeCanonicalJson(envelope.record)),
      ),
    );
    await expect(
      validateArchiveModel(exactBoundary, {
        limits: { maxJsonlLineBytes: longestCanonicalLine },
      }),
    ).resolves.toMatchObject({ report: { status: 'clean' } });
  });
});
