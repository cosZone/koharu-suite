import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { closeIteratorBestEffort } from './async-control.js';
import { serializeCanonicalJson } from './canonical-json.js';
import {
  type ChecksumEntry,
  ChecksumFormatError,
  type ChecksumFormatErrorCode,
  compareChecksumPaths,
  parseChecksumFile,
  renderChecksumFile,
  sha256Hex,
} from './checksums.js';
import { type ArchiveContainerSummary, readTarZstd } from './container.js';
import {
  ArchiveContainerError,
  type ArchiveContainerErrorCode,
  type ArchiveContainerLimits,
  canonicalizeArchiveEntryPath,
  compareArchiveEntryPaths,
  DEFAULT_ARCHIVE_CONTAINER_LIMITS,
} from './entry-policy.js';
import {
  ArchiveCompatibilityError,
  type ArchiveCompatibilityErrorCode,
  parseSupportedArchiveManifest,
} from './format-migrations.js';
import { decodeJsonl, JsonlError, type JsonlErrorCode } from './jsonl.js';
import {
  type ArchiveReport,
  type ArchiveReportIssue,
  type ArchiveReportMode,
  addArchiveReportIssue,
  createArchiveReport,
  finishArchiveReport,
  markArchiveReportFatal,
} from './report.js';
import {
  type ArchiveManifest,
  type ArchiveProvenanceMediaRecord,
  type ArchiveProvenanceObservationRecord,
  type ArchiveRecord,
  type ArchiveRecordFamily,
  type ArchiveRevisionMediaRecord,
  type ArchiveRevisionRecord,
  archiveChannelRecordSchema,
  archiveMessageRecordSchema,
  archiveProvenanceMediaRecordSchema,
  archiveProvenanceObservationRecordSchema,
  archiveRevisionMediaRecordSchema,
  archiveRevisionRecordSchema,
  compareCanonicalInt64Decimals,
  safeByteLengthDecimalSchema,
  sha256HexSchema,
  suiteVersionHintSchema,
} from './schemas.js';

const MEBIBYTE = 1_024 * 1_024;
const BLOB_PATH = /^blobs\/sha256\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})$/u;

export interface ArchiveValidationLimits {
  maxChecksumBytes: number;
  maxJsonlLineBytes: number;
  maxManifestBytes: number;
  maxTotalRecords: number;
  noProgressTimeoutMs: number;
}

export const DEFAULT_ARCHIVE_VALIDATION_LIMITS: Readonly<ArchiveValidationLimits> = Object.freeze({
  maxChecksumBytes: 20 * MEBIBYTE,
  maxJsonlLineBytes: 4 * MEBIBYTE,
  maxManifestBytes: 32 * MEBIBYTE,
  maxTotalRecords: 1_000_000,
  noProgressTimeoutMs: 30_000,
});

export interface ArchiveEntryEvidence {
  byteLength: string;
  path: string;
  sha256: string;
}

export interface ArchiveRecordEnvelope {
  archivePath: string;
  line: number;
  record: unknown;
}

export interface ValidateArchiveModelInput {
  checksumEntries: readonly ChecksumEntry[];
  entries: readonly ArchiveEntryEvidence[];
  manifest: ArchiveManifest;
  records: AsyncIterable<ArchiveRecordEnvelope> | Iterable<ArchiveRecordEnvelope>;
}

export interface ArchiveModelSummary {
  blobs: number;
  records: number;
}

export interface ArchiveValidationResult {
  artifactByteLength: string | null;
  artifactSha256: string | null;
  container: ArchiveContainerSummary | null;
  manifest: ArchiveManifest;
  model: ArchiveModelSummary;
  report: ArchiveReport;
}

export interface ValidateArchiveOptions {
  containerLimits?: Partial<ArchiveContainerLimits>;
  limits?: Partial<ArchiveValidationLimits>;
  mode?: ArchiveReportMode;
  signal?: AbortSignal;
}

export type ArchiveValidationErrorCode =
  | 'ARCHIVE_INVALID'
  | 'MODEL_INVALID'
  | 'RESOURCE_LIMIT_EXCEEDED';

type FileValidationReason =
  | ChecksumFormatErrorCode
  | JsonlErrorCode
  | 'archive_aborted'
  | 'archive_entry_missing'
  | 'checksum_digest_mismatch'
  | 'checksum_inventory_mismatch'
  | 'checksum_length_mismatch'
  | 'checksum_lists_control_entry'
  | 'checksum_missing'
  | 'checksum_size_limit_exceeded'
  | 'checksum_utf8_invalid'
  | 'entry_count_limit_exceeded'
  | 'entry_digest_mismatch'
  | 'entry_length_mismatch'
  | 'entry_order_mismatch'
  | 'invalid_blob_entry'
  | 'invalid_data_path'
  | 'manifest_checksum_inventory_mismatch'
  | 'manifest_json_invalid'
  | 'manifest_json_non_canonical'
  | 'manifest_missing'
  | 'manifest_size_limit_exceeded'
  | 'no_progress_timeout'
  | 'record_envelope_mismatch'
  | 'record_limit_exceeded'
  | 'shard_checksum_descriptor_mismatch'
  | 'shard_record_count_mismatch';

/** A safe failure carrying a bounded structured report, never archive content. */
export class ArchiveValidationError extends Error {
  constructor(
    readonly code: ArchiveValidationErrorCode,
    readonly report: ArchiveReport,
  ) {
    super(`Archive validation failed: ${code}`);
    this.name = 'ArchiveValidationError';
  }
}

class FileValidationError extends Error {
  constructor(
    readonly reason: FileValidationReason,
    readonly archivePath?: string,
    readonly line?: number,
    readonly byteOffset?: number,
  ) {
    super(`Archive file validation failed: ${reason}`);
    this.name = 'FileValidationError';
  }
}

interface RevisionState {
  contentKind: ArchiveRevisionRecord['contentKind'];
  hasEntities: boolean;
  hasText: boolean;
  mediaCount: number;
}

interface OriginalState {
  byteLength: string;
  detectedMimeType: string;
  included: boolean;
  references: number;
}

type ProvenanceSource =
  | ArchiveProvenanceObservationRecord['source']
  | ArchiveProvenanceMediaRecord['source'];

type OrderPart = bigint | number | string;

const FAMILY_SCHEMAS = {
  channels: archiveChannelRecordSchema,
  messages: archiveMessageRecordSchema,
  revisions: archiveRevisionRecordSchema,
  'revision-media': archiveRevisionMediaRecordSchema,
  'provenance-observations': archiveProvenanceObservationRecordSchema,
  'provenance-media': archiveProvenanceMediaRecordSchema,
} as const;

function resolveValidationLimits(
  overrides: Partial<ArchiveValidationLimits> = {},
): Readonly<ArchiveValidationLimits> {
  const limits = { ...DEFAULT_ARCHIVE_VALIDATION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  for (const [name, ceiling] of Object.entries(DEFAULT_ARCHIVE_VALIDATION_LIMITS)) {
    if (limits[name as keyof ArchiveValidationLimits] > ceiling) {
      throw new TypeError(`${name} cannot exceed the v1 hard limit`);
    }
  }
  return Object.freeze(limits);
}

function resolveValidationContainerLimits(
  overrides: Partial<ArchiveContainerLimits> = {},
): Partial<ArchiveContainerLimits> {
  for (const [name, value] of Object.entries(overrides)) {
    const ceiling = DEFAULT_ARCHIVE_CONTAINER_LIMITS[name as keyof ArchiveContainerLimits];
    if (value === undefined || value > ceiling) {
      throw new TypeError(`${name} cannot exceed the v1 hard limit`);
    }
  }
  return overrides;
}

function assertValidationActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FileValidationError('archive_aborted');
}

async function validationCheckpoint(position: number, signal?: AbortSignal): Promise<void> {
  assertValidationActive(signal);
  if (position % 1_024 === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assertValidationActive(signal);
  }
}

function modelIterator(
  source: ValidateArchiveModelInput['records'],
): AsyncIterator<ArchiveRecordEnvelope> {
  if (Symbol.asyncIterator in source) return source[Symbol.asyncIterator]();
  const iterator = source[Symbol.iterator]();
  const result: AsyncIterator<ArchiveRecordEnvelope> = {
    next: async () => iterator.next(),
  };
  if (iterator.return !== undefined) {
    result.return = async () => iterator.return?.() ?? { done: true, value: undefined };
  }
  return result;
}

async function nextModelRecord(
  iterator: AsyncIterator<ArchiveRecordEnvelope>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IteratorResult<ArchiveRecordEnvelope>> {
  assertValidationActive(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = <T>(callback: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, new FileValidationError('archive_aborted'));
    timer = setTimeout(
      () => finish(reject, new FileValidationError('no_progress_timeout')),
      timeoutMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => finish(resolve, result),
        (error: unknown) => finish(reject, error),
      );
  });
}

function recordCountFromManifest(manifest: ArchiveManifest): number {
  const count =
    manifest.counts.channels +
    manifest.counts.messages +
    manifest.counts.revisions +
    manifest.counts.revisionMedia +
    manifest.counts.provenanceObservations +
    manifest.counts.provenanceMedia;
  return Number.isSafeInteger(count) ? count : Number.MAX_SAFE_INTEGER;
}

function messageKey(chatId: string, messageId: string): string {
  return `${chatId}\0${messageId}`;
}

function revisionKey(chatId: string, messageId: string, revisionNumber: number): string {
  return `${messageKey(chatId, messageId)}\0${revisionNumber}`;
}

function sourceIdentityKey(source: ProvenanceSource): string {
  if (source.kind === 'telegram_bot_update') {
    return `bot\0${source.telegramUpdateId}`;
  }
  return `desktop\0${source.sourceFileSha256}\0${source.sourceChatId}\0${source.sourceMessageId}`;
}

function exactSourceDiscriminantKey(source: ProvenanceSource): string {
  if (source.kind === 'telegram_bot_update') {
    return `bot\0${source.telegramUpdateId}\0${source.updateType}`;
  }
  return sourceIdentityKey(source);
}

function provenanceKey(
  chatId: string,
  messageId: string,
  revisionNumber: number | null,
  source: ProvenanceSource,
): string {
  return `${messageKey(chatId, messageId)}\0${revisionNumber ?? 'message'}\0${exactSourceDiscriminantKey(source)}`;
}

function sourceOrderParts(source: ProvenanceSource): OrderPart[] {
  if (source.kind === 'telegram_bot_update') {
    return [0, BigInt(source.telegramUpdateId), source.updateType];
  }
  return [1, source.sourceFileSha256, BigInt(source.sourceChatId), BigInt(source.sourceMessageId)];
}

function recordOrderParts(record: ArchiveRecord): OrderPart[] {
  const base: OrderPart[] = [
    BigInt(record.telegramChatId),
    ...(record.recordType === 'channel' ? [] : [BigInt(record.telegramMessageId)]),
  ];
  switch (record.recordType) {
    case 'channel':
    case 'message':
      return base;
    case 'revision':
      return [...base, record.revisionNumber];
    case 'revision-media':
      return [...base, record.revisionNumber, record.position];
    case 'provenance-observation':
      return [
        ...base,
        record.revisionNumber === null ? 0 : 1,
        record.revisionNumber ?? 0,
        ...sourceOrderParts(record.source),
      ];
    case 'provenance-media':
      return [
        ...base,
        record.revisionNumber === null ? 0 : 1,
        record.revisionNumber ?? 0,
        ...sourceOrderParts(record.source),
        record.position,
      ];
  }
}

function compareOrderParts(left: readonly OrderPart[], right: readonly OrderPart[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function familyForPath(path: string): ArchiveRecordFamily | null {
  const match = /^data\/([^/]+)\/\d{6}\.jsonl$/u.exec(path);
  const family = match?.[1];
  return family !== undefined && Object.hasOwn(FAMILY_SCHEMAS, family)
    ? (family as ArchiveRecordFamily)
    : null;
}

export function archiveBlobPath(sha256: string): string {
  const hash = sha256HexSchema.parse(sha256);
  return `blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

function blobShaFromPath(path: string): string | null {
  const match = BLOB_PATH.exec(path);
  if (match === null) return null;
  const [, first, second, hash] = match;
  return hash !== undefined && first === hash.slice(0, 2) && second === hash.slice(2, 4)
    ? hash
    : null;
}

function evidenceSchema() {
  return z.strictObject({
    byteLength: safeByteLengthDecimalSchema,
    path: z.string().transform((value, context) => {
      try {
        return canonicalizeArchiveEntryPath(value);
      } catch {
        context.addIssue({ code: 'custom', message: 'Expected canonical archive path' });
        return z.NEVER;
      }
    }),
    sha256: sha256HexSchema,
  });
}

class ModelAccumulator {
  readonly #channels = new Set<string>();
  readonly #messages = new Map<string, number>();
  readonly #revisions = new Map<string, RevisionState>();
  readonly #observations = new Set<string>();
  readonly #provenanceSources = new Set<string>();
  readonly #originals = new Map<string, OriginalState>();
  readonly #lastOrder = new Map<ArchiveRecordFamily, OrderPart[]>();
  readonly #lastRevision = new Map<string, number>();
  readonly #lastMediaPosition = new Map<string, number>();
  readonly #lastProvenanceMediaPosition = new Map<string, number>();
  readonly #report: ArchiveReport;
  readonly #manifest: ArchiveManifest;
  readonly #limits: Readonly<ArchiveValidationLimits>;
  #descriptorIndex = 0;
  #descriptorLine = 0;
  #records = 0;

  constructor(
    manifest: ArchiveManifest,
    report: ArchiveReport,
    limits: Readonly<ArchiveValidationLimits>,
  ) {
    this.#manifest = manifest;
    this.#report = report;
    this.#limits = limits;
  }

  get records(): number {
    return this.#records;
  }

  accept(envelope: ArchiveRecordEnvelope): void {
    this.#records += 1;
    if (this.#records > this.#limits.maxTotalRecords) {
      throw new FileValidationError('record_limit_exceeded', envelope.archivePath, envelope.line);
    }
    const family = familyForPath(envelope.archivePath);
    if (family === null) {
      throw new FileValidationError('invalid_data_path');
    }
    const descriptor = this.#manifest.files[this.#descriptorIndex];
    if (
      descriptor === undefined ||
      descriptor.path !== envelope.archivePath ||
      descriptor.family !== family ||
      envelope.line !== this.#descriptorLine + 1
    ) {
      throw new FileValidationError(
        'record_envelope_mismatch',
        envelope.archivePath,
        envelope.line,
      );
    }
    this.#descriptorLine += 1;
    if (this.#descriptorLine === descriptor.recordCount) {
      this.#descriptorIndex += 1;
      this.#descriptorLine = 0;
    }
    const result = FAMILY_SCHEMAS[family].safeParse(envelope.record);
    if (!result.success) {
      this.#issue('record_schema_invalid', envelope);
      return;
    }
    const record = result.data as ArchiveRecord;
    if (Buffer.byteLength(serializeCanonicalJson(record)) > this.#limits.maxJsonlLineBytes) {
      throw new FileValidationError(
        'line_size_limit_exceeded',
        envelope.archivePath,
        envelope.line,
      );
    }
    const order = recordOrderParts(record);
    const previous = this.#lastOrder.get(family);
    if (previous !== undefined && compareOrderParts(previous, order) >= 0) {
      this.#issue('record_order_or_identity_invalid', envelope, record);
    }
    this.#lastOrder.set(family, order);

    switch (record.recordType) {
      case 'channel':
        this.#acceptChannel(record.telegramChatId, envelope, record);
        break;
      case 'message':
        this.#acceptMessage(record, envelope);
        break;
      case 'revision':
        this.#acceptRevision(record, envelope);
        break;
      case 'revision-media':
        this.#acceptRevisionMedia(record, envelope);
        break;
      case 'provenance-observation':
        this.#acceptProvenanceObservation(record, envelope);
        break;
      case 'provenance-media':
        this.#acceptProvenanceMedia(record, envelope);
        break;
    }
  }

  async finish(
    checksumEntries: readonly ChecksumEntry[],
    entries: readonly ArchiveEntryEvidence[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#validateEntries(checksumEntries, entries, signal);
    if (this.#descriptorIndex !== this.#manifest.files.length || this.#descriptorLine !== 0) {
      this.#issue('record_envelope_mismatch');
    }

    let checked = 0;
    for (const [key, currentRevision] of this.#messages) {
      checked += 1;
      await validationCheckpoint(checked, signal);
      if (!this.#revisions.has(`${key}\0${currentRevision}`)) {
        this.#issue('dangling_current_revision');
      }
    }
    for (const revision of this.#revisions.values()) {
      checked += 1;
      await validationCheckpoint(checked, signal);
      if (revision.contentKind === 'text' && (!revision.hasText || revision.mediaCount !== 0)) {
        this.#issue('text_revision_invalid');
      }
      if (revision.contentKind === 'caption' && (!revision.hasText || revision.mediaCount === 0)) {
        this.#issue('caption_revision_invalid');
      }
      if (
        revision.contentKind === 'none' &&
        (revision.hasText || revision.hasEntities || revision.mediaCount === 0)
      ) {
        this.#issue('media_only_revision_invalid');
      }
    }

    const blobEntries = entries.filter((entry) => blobShaFromPath(entry.path) !== null);
    const blobByHash = new Map(
      blobEntries.map((entry) => [blobShaFromPath(entry.path) as string, entry]),
    );
    let missingReferences = 0;
    let mediaPresent = 0;
    const missingObjects = new Map<string, bigint>();

    for (const [hash, original] of this.#originals) {
      checked += 1;
      await validationCheckpoint(checked, signal);
      const blob = blobByHash.get(hash);
      if (original.included) {
        mediaPresent += original.references;
        if (blob === undefined || blob.byteLength !== original.byteLength) {
          this.#issue('included_blob_missing_or_length_mismatch');
        }
      } else {
        missingReferences += original.references;
        const identity = `${hash}\0${original.byteLength}\0${original.detectedMimeType}`;
        missingObjects.set(identity, BigInt(original.byteLength));
        if (blob !== undefined) this.#issue('excluded_blob_present');
      }
    }
    for (const hash of blobByHash.keys()) {
      checked += 1;
      await validationCheckpoint(checked, signal);
      if (!this.#originals.has(hash)) this.#issue('orphan_blob');
    }

    const unknownMissing = this.#report.counts.revisionMedia - mediaPresent - missingReferences;
    if (unknownMissing < 0) this.#issue('media_reference_count_invalid');
    missingReferences += Math.max(0, unknownMissing);
    const knownBytes = [...missingObjects.values()].reduce((sum, value) => sum + value, 0n);
    const blobBytes = blobEntries.reduce((sum, entry) => sum + BigInt(entry.byteLength), 0n);
    this.#report.counts.blobs = blobEntries.length;
    this.#report.counts.mediaPresent = mediaPresent;
    this.#report.counts.mediaMissing = missingReferences;

    if (this.#manifest.counts.blobs !== blobEntries.length) this.#issue('blob_count_mismatch');
    if (this.#manifest.logicalBytes.blobs !== blobBytes.toString()) {
      this.#issue('blob_bytes_mismatch');
    }
    if (
      this.#manifest.missingMedia.references !== missingReferences ||
      this.#manifest.missingMedia.uniqueObjects !== missingObjects.size ||
      this.#manifest.missingMedia.knownBytes !== knownBytes.toString()
    ) {
      this.#issue('missing_media_summary_mismatch');
    }

    const selected =
      this.#manifest.selection.mode === 'channels'
        ? this.#manifest.selection.telegramChatIds
        : null;
    if (selected !== null) {
      const actual = [...this.#channels].sort(compareCanonicalInt64Decimals);
      if (
        selected.length !== actual.length ||
        selected.some((value, index) => value !== actual[index])
      ) {
        this.#issue('selection_mismatch');
      }
    }

    const expectedCounts = {
      channels: this.#report.counts.channels,
      messages: this.#report.counts.messages,
      revisions: this.#report.counts.revisions,
      revisionMedia: this.#report.counts.revisionMedia,
      provenanceObservations: this.#observations.size,
      provenanceMedia: this.#report.counts.provenanceRecords - this.#observations.size,
    };
    for (const [field, actual] of Object.entries(expectedCounts)) {
      if (this.#manifest.counts[field as keyof typeof expectedCounts] !== actual) {
        this.#issue('manifest_record_count_mismatch');
      }
    }
    if (
      this.#manifest.counts.visibleMessages !== this.#report.counts.visibleMessages ||
      this.#manifest.counts.hiddenMessages !== this.#report.counts.hiddenMessages
    ) {
      this.#issue('manifest_visibility_count_mismatch');
    }
  }

  #acceptChannel(chatId: string, envelope: ArchiveRecordEnvelope, record: ArchiveRecord): void {
    if (this.#channels.has(chatId)) this.#issue('duplicate_channel', envelope, record);
    this.#channels.add(chatId);
    this.#report.counts.channels += 1;
  }

  #acceptMessage(
    record: Extract<ArchiveRecord, { recordType: 'message' }>,
    envelope: ArchiveRecordEnvelope,
  ): void {
    const key = messageKey(record.telegramChatId, record.telegramMessageId);
    if (!this.#channels.has(record.telegramChatId)) {
      this.#issue('dangling_message_channel', envelope, record);
    }
    if (this.#messages.has(key)) this.#issue('duplicate_message', envelope, record);
    this.#messages.set(key, record.currentRevisionNumber);
    this.#report.counts.messages += 1;
    if (record.visibility.state === 'public') this.#report.counts.visibleMessages += 1;
    else this.#report.counts.hiddenMessages += 1;
  }

  #acceptRevision(record: ArchiveRevisionRecord, envelope: ArchiveRecordEnvelope): void {
    const parent = messageKey(record.telegramChatId, record.telegramMessageId);
    const key = revisionKey(record.telegramChatId, record.telegramMessageId, record.revisionNumber);
    if (!this.#messages.has(parent)) this.#issue('dangling_revision_message', envelope, record);
    const previous = this.#lastRevision.get(parent) ?? 0;
    if (record.revisionNumber !== previous + 1) {
      this.#issue('revision_sequence_invalid', envelope, record);
    }
    this.#lastRevision.set(parent, record.revisionNumber);
    if (this.#revisions.has(key)) this.#issue('duplicate_revision', envelope, record);
    for (const entity of record.entities) {
      const textLength = record.text?.length ?? 0;
      if (entity.offset > textLength || entity.length > textLength - entity.offset) {
        this.#issue('entity_range_invalid', envelope, record);
        break;
      }
    }
    this.#revisions.set(key, {
      contentKind: record.contentKind,
      hasEntities: record.entities.length > 0,
      hasText: record.text !== null,
      mediaCount: 0,
    });
    this.#report.counts.revisions += 1;
  }

  #acceptRevisionMedia(record: ArchiveRevisionMediaRecord, envelope: ArchiveRecordEnvelope): void {
    const parent = revisionKey(
      record.telegramChatId,
      record.telegramMessageId,
      record.revisionNumber,
    );
    const revision = this.#revisions.get(parent);
    if (revision === undefined) this.#issue('dangling_revision_media', envelope, record);
    const previous = this.#lastMediaPosition.get(parent) ?? -1;
    if (record.position !== previous + 1) {
      this.#issue('media_position_invalid', envelope, record);
    }
    this.#lastMediaPosition.set(parent, record.position);
    if (revision !== undefined) revision.mediaCount += 1;

    const hasFileId = record.source.telegramFileId !== null;
    const hasUniqueId = record.source.telegramFileUniqueId !== null;
    if (
      (record.source.kind === 'telegram_bot_update' && (!hasFileId || !hasUniqueId)) ||
      (record.source.kind === 'telegram_desktop_json' && (hasFileId || hasUniqueId))
    ) {
      this.#issue('media_source_locator_invalid', envelope, record);
    }
    if (record.original !== null) {
      if (record.original.included && record.availability !== 'available') {
        this.#issue('included_media_not_available', envelope, record);
      }
      if (!this.#manifest.sections.media && record.original.included) {
        this.#issue('disabled_media_contains_blob', envelope, record);
      }
      const previousOriginal = this.#originals.get(record.original.sha256);
      if (
        previousOriginal !== undefined &&
        (previousOriginal.byteLength !== record.original.byteLength ||
          previousOriginal.detectedMimeType !== record.original.detectedMimeType ||
          previousOriginal.included !== record.original.included)
      ) {
        this.#issue('blob_identity_conflict', envelope, record);
      }
      if (previousOriginal === undefined) {
        this.#originals.set(record.original.sha256, {
          byteLength: record.original.byteLength,
          detectedMimeType: record.original.detectedMimeType,
          included: record.original.included,
          references: 1,
        });
      } else {
        previousOriginal.references += 1;
      }
    }
    this.#report.counts.revisionMedia += 1;
  }

  #acceptProvenanceObservation(
    record: ArchiveProvenanceObservationRecord,
    envelope: ArchiveRecordEnvelope,
  ): void {
    this.#validateProvenanceReference(record, envelope);
    const key = provenanceKey(
      record.telegramChatId,
      record.telegramMessageId,
      record.revisionNumber,
      record.source,
    );
    if (this.#observations.has(key))
      this.#issue('duplicate_provenance_observation', envelope, record);
    const sourceKey = sourceIdentityKey(record.source);
    if (this.#provenanceSources.has(sourceKey)) {
      this.#issue('duplicate_provenance_source_identity', envelope, record);
    } else {
      this.#provenanceSources.add(sourceKey);
    }
    this.#observations.add(key);
    this.#report.counts.provenanceRecords += 1;
  }

  #acceptProvenanceMedia(
    record: ArchiveProvenanceMediaRecord,
    envelope: ArchiveRecordEnvelope,
  ): void {
    this.#validateProvenanceReference(record, envelope);
    const parent = provenanceKey(
      record.telegramChatId,
      record.telegramMessageId,
      record.revisionNumber,
      record.source,
    );
    if (!this.#observations.has(parent)) {
      this.#issue('dangling_provenance_media_observation', envelope, record);
    }
    const previous = this.#lastProvenanceMediaPosition.get(parent) ?? -1;
    if (record.position !== previous + 1) {
      this.#issue('provenance_media_position_invalid', envelope, record);
    }
    this.#lastProvenanceMediaPosition.set(parent, record.position);
    const hasFileId = record.telegramFileId !== null;
    const hasUniqueId = record.telegramFileUniqueId !== null;
    if (
      (record.source.kind === 'telegram_bot_update' && (!hasFileId || !hasUniqueId)) ||
      (record.source.kind === 'telegram_desktop_json' && (hasFileId || hasUniqueId))
    ) {
      this.#issue('provenance_media_locator_invalid', envelope, record);
    }
    this.#report.counts.provenanceRecords += 1;
  }

  #validateProvenanceReference(
    record: ArchiveProvenanceObservationRecord | ArchiveProvenanceMediaRecord,
    envelope: ArchiveRecordEnvelope,
  ): void {
    if (!this.#manifest.sections.provenance) {
      this.#issue('disabled_provenance_contains_records', envelope, record);
    }
    const parent = messageKey(record.telegramChatId, record.telegramMessageId);
    if (!this.#messages.has(parent)) {
      this.#issue('dangling_provenance_message', envelope, record);
    }
    if (
      record.revisionNumber !== null &&
      !this.#revisions.has(
        revisionKey(record.telegramChatId, record.telegramMessageId, record.revisionNumber),
      )
    ) {
      this.#issue('dangling_provenance_revision', envelope, record);
    }
  }

  async #validateEntries(
    rawChecksums: readonly ChecksumEntry[],
    rawEntries: readonly ArchiveEntryEvidence[],
    signal?: AbortSignal,
  ): Promise<void> {
    let checksumText: string;
    try {
      checksumText = renderChecksumFile(rawChecksums, {
        maxFileBytes: this.#limits.maxChecksumBytes,
      });
    } catch (error) {
      if (error instanceof ChecksumFormatError) {
        throw new FileValidationError(CHECKSUM_ERROR_REASONS[error.code] ?? 'invalid_line');
      }
      throw error;
    }
    const canonicalChecksums = parseChecksumFile(checksumText);
    if (
      canonicalChecksums.length !== rawChecksums.length ||
      canonicalChecksums.some((entry, index) => {
        const original = rawChecksums[index];
        return (
          original === undefined ||
          entry.path !== original.path ||
          entry.byteLength !== original.byteLength ||
          entry.sha256 !== original.sha256
        );
      })
    ) {
      this.#issue('checksum_order_mismatch');
    }
    if (
      this.#manifest.checksumFile.byteLength !== Buffer.byteLength(checksumText).toString() ||
      this.#manifest.checksumFile.sha256 !== sha256Hex(checksumText)
    ) {
      this.#issue('checksum_file_descriptor_mismatch');
    }
    const entryResult = z.array(evidenceSchema()).safeParse(rawEntries);
    if (!entryResult.success) {
      this.#issue('entry_evidence_invalid');
      return;
    }
    const entries = entryResult.data;
    const checksums = new Map(rawChecksums.map((entry) => [entry.path, entry]));
    const descriptorByPath = new Map(this.#manifest.files.map((file) => [file.path, file]));
    const blobPaths = rawChecksums
      .map((entry) => entry.path)
      .filter((path) => !descriptorByPath.has(path))
      .sort(compareArchiveEntryPaths);
    const expectedPaths = [...this.#manifest.files.map((file) => file.path), ...blobPaths];
    const comparison = compareChecksumPaths(
      rawChecksums,
      entries.map((entry) => entry.path),
    );
    if (
      comparison.unlistedArchivePaths.length > 0 ||
      comparison.undeclaredChecksumPaths.length > 0
    ) {
      this.#issue('checksum_inventory_mismatch');
    }
    if (
      entries.length !== expectedPaths.length ||
      entries.some((entry, index) => entry.path !== expectedPaths[index])
    ) {
      this.#issue('entry_order_mismatch');
    }
    for (const [index, entry] of entries.entries()) {
      await validationCheckpoint(index + 1, signal);
      const checksum = checksums.get(entry.path);
      if (
        checksum === undefined ||
        checksum.byteLength !== entry.byteLength ||
        checksum.sha256 !== entry.sha256
      ) {
        this.#issue('entry_checksum_mismatch');
      }
      const descriptor = descriptorByPath.get(entry.path);
      if (descriptor !== undefined && descriptor.byteLength !== entry.byteLength) {
        this.#issue('shard_length_mismatch');
      }
      const blobSha = blobShaFromPath(entry.path);
      if (descriptor === undefined && (blobSha === null || blobSha !== entry.sha256)) {
        this.#issue('invalid_blob_entry');
      }
    }
  }

  #issue(reason: string, envelope?: ArchiveRecordEnvelope, record?: ArchiveRecord): void {
    const issue: ArchiveReportIssue = {
      code: 'model_validation',
      sanitizedReason: reason,
      severity: 'error',
      ...(envelope === undefined
        ? {}
        : {
            archivePath: envelope.archivePath,
            line: envelope.line,
          }),
      ...(record === undefined
        ? {}
        : {
            telegramChatId: record.telegramChatId,
            ...(record.recordType === 'channel'
              ? {}
              : { telegramMessageId: record.telegramMessageId }),
            ...(record.recordType === 'revision' || record.recordType === 'revision-media'
              ? { revisionNumber: record.revisionNumber }
              : {}),
          }),
    };
    addArchiveReportIssue(this.#report, issue);
  }
}

function finalizeModelResult(
  manifest: ArchiveManifest,
  report: ArchiveReport,
  records: number,
  container: ArchiveContainerSummary | null,
): ArchiveValidationResult {
  const finalized = finishArchiveReport(report);
  const result: ArchiveValidationResult = {
    artifactByteLength: finalized.artifactByteLength,
    artifactSha256: finalized.artifactSha256,
    container,
    manifest,
    model: { blobs: finalized.counts.blobs, records },
    report: finalized,
  };
  if (finalized.status !== 'clean') throw new ArchiveValidationError('MODEL_INVALID', finalized);
  return result;
}

export async function validateArchiveModel(
  input: ValidateArchiveModelInput,
  options: Pick<ValidateArchiveOptions, 'limits' | 'mode' | 'signal'> = {},
): Promise<ArchiveValidationResult> {
  const limits = resolveValidationLimits(options.limits);
  const report = createArchiveReport({
    mode: options.mode ?? 'inspect',
  });
  try {
    const manifest = parseSupportedArchiveManifest(input.manifest);
    report.formatVersion = manifest.formatVersion;
    if (
      Buffer.byteLength(serializeCanonicalJson(manifest, { profile: 'manifest' })) >
      limits.maxManifestBytes
    ) {
      throw new FileValidationError('manifest_size_limit_exceeded', 'manifest.json');
    }
    if (
      input.entries.length > DEFAULT_ARCHIVE_CONTAINER_LIMITS.maxEntries - 2 ||
      input.checksumEntries.length > DEFAULT_ARCHIVE_CONTAINER_LIMITS.maxEntries - 2
    ) {
      throw new FileValidationError('entry_count_limit_exceeded');
    }
    if (recordCountFromManifest(manifest) > limits.maxTotalRecords) {
      markArchiveReportFatal(report, {
        code: 'archive_validation',
        sanitizedReason: 'record_limit_exceeded',
        severity: 'error',
      });
      throw new ArchiveValidationError('RESOURCE_LIMIT_EXCEEDED', finishArchiveReport(report));
    }
    const accumulator = new ModelAccumulator(manifest, report, limits);
    const iterator = modelIterator(input.records);
    let complete = false;
    try {
      while (true) {
        const next = await nextModelRecord(iterator, limits.noProgressTimeoutMs, options.signal);
        if (next.done) {
          complete = true;
          break;
        }
        accumulator.accept(next.value);
        await validationCheckpoint(accumulator.records, options.signal);
      }
    } finally {
      if (!complete && iterator.return !== undefined) {
        await closeIteratorBestEffort(iterator);
      }
    }
    await accumulator.finish(input.checksumEntries, input.entries, options.signal);
    return finalizeModelResult(manifest, report, accumulator.records, null);
  } catch (error) {
    if (error instanceof ArchiveValidationError) throw error;
    applyCompatibilityMetadata(report, error);
    markArchiveReportFatal(report, {
      code: 'archive_validation',
      sanitizedReason: reasonForError(error),
      severity: 'error',
      ...safeLocation(error),
    });
    throw new ArchiveValidationError('ARCHIVE_INVALID', finishArchiveReport(report));
  }
}

interface PreparedPayloadEntry {
  byteLength: string;
  checksum: ChecksumEntry;
  descriptor: ArchiveManifest['files'][number] | null;
  path: string;
}

function preparePayloadEntries(
  manifest: ArchiveManifest,
  checksumEntries: readonly ChecksumEntry[],
): PreparedPayloadEntry[] {
  const byPath = new Map(checksumEntries.map((entry) => [entry.path, entry]));
  if (byPath.has('manifest.json') || byPath.has('checksums.sha256')) {
    throw new FileValidationError('checksum_lists_control_entry');
  }
  const descriptorPaths = new Set(manifest.files.map((file) => file.path));
  const comparison = compareChecksumPaths(
    checksumEntries.filter((entry) => descriptorPaths.has(entry.path)),
    descriptorPaths,
  );
  if (comparison.unlistedArchivePaths.length > 0 || comparison.undeclaredChecksumPaths.length > 0) {
    throw new FileValidationError('manifest_checksum_inventory_mismatch');
  }
  const blobEntries = checksumEntries
    .filter((entry) => !descriptorPaths.has(entry.path))
    .map((entry) => {
      const hash = blobShaFromPath(entry.path);
      if (hash === null || hash !== entry.sha256) {
        throw new FileValidationError('invalid_blob_entry', entry.path);
      }
      return { byteLength: entry.byteLength, checksum: entry, descriptor: null, path: entry.path };
    })
    .sort((left, right) => compareArchiveEntryPaths(left.path, right.path));

  const dataEntries = manifest.files.map((descriptor) => {
    const checksum = byPath.get(descriptor.path);
    if (checksum === undefined || checksum.byteLength !== descriptor.byteLength) {
      throw new FileValidationError('shard_checksum_descriptor_mismatch', descriptor.path);
    }
    return {
      byteLength: descriptor.byteLength,
      checksum,
      descriptor,
      path: descriptor.path,
    };
  });
  if (dataEntries.length + blobEntries.length !== checksumEntries.length) {
    throw new FileValidationError('checksum_inventory_mismatch');
  }
  return [...dataEntries, ...blobEntries];
}

async function collectBounded(
  stream: Readable,
  declaredBytes: number,
  limit: number,
  reason: FileValidationReason,
): Promise<Buffer> {
  if (declaredBytes > limit) throw new FileValidationError(reason);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > limit) throw new FileValidationError(reason);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

async function* hashingChunks(
  stream: Readable,
  hash: ReturnType<typeof createHash>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    yield bytes;
  }
}

function parseCanonicalManifest(bytes: Buffer): ArchiveManifest {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new FileValidationError('manifest_json_invalid', 'manifest.json');
  }
  const manifest = parseSupportedArchiveManifest(parsed);
  if (serializeCanonicalJson(manifest, { profile: 'manifest' }) !== text) {
    throw new FileValidationError('manifest_json_non_canonical', 'manifest.json');
  }
  return manifest;
}

const CONTAINER_ERROR_REASONS = {
  ARCHIVE_ABORTED: 'archive_aborted',
  COMPRESSED_SIZE_LIMIT_EXCEEDED: 'compressed_size_limit_exceeded',
  COMPRESSION_RATIO_LIMIT_EXCEEDED: 'compression_ratio_limit_exceeded',
  DUPLICATE_ARCHIVE_PATH: 'duplicate_archive_path',
  ENTRY_COUNT_LIMIT_EXCEEDED: 'entry_count_limit_exceeded',
  ENTRY_NOT_CONSUMED: 'entry_not_consumed',
  ENTRY_SIZE_LIMIT_EXCEEDED: 'entry_size_limit_exceeded',
  ENTRY_SIZE_MISMATCH: 'entry_size_mismatch',
  EXPANDED_SIZE_LIMIT_EXCEEDED: 'expanded_size_limit_exceeded',
  EXTRA_ARCHIVE_ENTRY: 'extra_archive_entry',
  INVALID_ARCHIVE_CONTAINER: 'invalid_archive_container',
  INVALID_ARCHIVE_LIMIT: 'invalid_archive_limit',
  INVALID_ARCHIVE_PATH: 'invalid_archive_path',
  NO_PROGRESS_TIMEOUT: 'no_progress_timeout',
  TOTAL_ENTRY_SIZE_LIMIT_EXCEEDED: 'total_entry_size_limit_exceeded',
  TRAILING_ARCHIVE_DATA: 'trailing_archive_data',
  TRUNCATED_ARCHIVE: 'truncated_archive',
  UNSUPPORTED_ARCHIVE_ENTRY_TYPE: 'unsupported_archive_entry_type',
  UNSUPPORTED_TAR_EXTENSION: 'unsupported_tar_extension',
  ZSTD_RUNTIME_UNSUPPORTED: 'zstd_runtime_unsupported',
} as const satisfies Record<ArchiveContainerErrorCode, string>;

const CHECKSUM_ERROR_REASONS = {
  byte_length_limit_exceeded: 'byte_length_limit_exceeded',
  duplicate_path: 'duplicate_path',
  empty_file: 'empty_file',
  entry_count_limit_exceeded: 'entry_count_limit_exceeded',
  input_limit_exceeded: 'input_limit_exceeded',
  invalid_byte_length: 'invalid_byte_length',
  invalid_line: 'invalid_line',
  invalid_path: 'invalid_path',
  invalid_sha256: 'invalid_sha256',
  line_size_limit_exceeded: 'line_size_limit_exceeded',
  non_canonical_order: 'non_canonical_order',
  non_lf_line_ending: 'non_lf_line_ending',
} as const satisfies Record<ChecksumFormatErrorCode, string>;

const JSONL_ERROR_REASONS = {
  blank_line: 'blank_line',
  invalid_chunk: 'invalid_chunk',
  invalid_json: 'invalid_json',
  invalid_line_ending: 'invalid_line_ending',
  invalid_record: 'invalid_record',
  invalid_utf8: 'invalid_utf8',
  line_too_large: 'line_too_large',
  missing_trailing_lf: 'missing_trailing_lf',
  non_canonical_json: 'non_canonical_json',
  record_limit_exceeded: 'record_limit_exceeded',
  shard_limit_exceeded: 'shard_limit_exceeded',
} as const satisfies Record<JsonlErrorCode, string>;

const COMPATIBILITY_ERROR_REASONS = {
  FUTURE_FORMAT_VERSION: 'future_format_version',
  FUTURE_SCHEMA_VERSION: 'future_schema_version',
  INVALID_MANIFEST: 'invalid_manifest',
  UNKNOWN_ARCHIVE_FORMAT: 'unknown_archive_format',
  UNSUPPORTED_FORMAT_VERSION: 'unsupported_format_version',
  UNSUPPORTED_SCHEMA_VERSION: 'unsupported_schema_version',
} as const satisfies Record<ArchiveCompatibilityErrorCode, string>;

const MAX_ERROR_CAUSE_DEPTH = 16;
const INVALID_ERROR_FIELD = Symbol('invalid-error-field');

function safeInstanceOf<T extends abstract new (...args: never[]) => unknown>(
  value: unknown,
  classConstructor: T,
): value is InstanceType<T> {
  try {
    return value instanceof classConstructor;
  } catch {
    return false;
  }
}

function ownDataField(value: unknown, key: PropertyKey): unknown | typeof INVALID_ERROR_FIELD {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return INVALID_ERROR_FIELD;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return undefined;
    return 'value' in descriptor ? descriptor.value : INVALID_ERROR_FIELD;
  } catch {
    return INVALID_ERROR_FIELD;
  }
}

function boundedErrorChain(error: unknown): { complete: boolean; values: unknown[] } {
  const seen = new Set<object>();
  const values: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    if ((typeof current === 'object' && current !== null) || typeof current === 'function') {
      if (seen.has(current as object)) return { complete: false, values: [] };
      seen.add(current as object);
    }
    values.push(current);
    if (!safeInstanceOf(current, ArchiveContainerError)) {
      return { complete: true, values };
    }
    const cause = ownDataField(current, 'cause');
    if (cause === INVALID_ERROR_FIELD) return { complete: false, values: [] };
    if (cause === undefined) return { complete: true, values };
    current = cause;
  }
  return { complete: false, values: [] };
}

function reasonForError(error: unknown): string {
  const chain = boundedErrorChain(error);
  if (!chain.complete) return 'internal_error';
  for (const current of [...chain.values].reverse()) {
    if (safeInstanceOf(current, FileValidationError)) {
      const reason = ownDataField(current, 'reason');
      return typeof reason === 'string' && /^[a-z][a-z0-9_]{0,127}$/u.test(reason)
        ? reason
        : 'internal_error';
    }
    if (safeInstanceOf(current, ChecksumFormatError)) {
      const code = ownDataField(current, 'code');
      return typeof code === 'string' && Object.hasOwn(CHECKSUM_ERROR_REASONS, code)
        ? CHECKSUM_ERROR_REASONS[code as ChecksumFormatErrorCode]
        : 'internal_error';
    }
    if (safeInstanceOf(current, JsonlError)) {
      const code = ownDataField(current, 'code');
      return typeof code === 'string' && Object.hasOwn(JSONL_ERROR_REASONS, code)
        ? JSONL_ERROR_REASONS[code as JsonlErrorCode]
        : 'internal_error';
    }
    if (safeInstanceOf(current, ArchiveCompatibilityError)) {
      const code = ownDataField(current, 'code');
      return typeof code === 'string' && Object.hasOwn(COMPATIBILITY_ERROR_REASONS, code)
        ? COMPATIBILITY_ERROR_REASONS[code as ArchiveCompatibilityErrorCode]
        : 'internal_error';
    }
    if (safeInstanceOf(current, ArchiveContainerError)) {
      const code = ownDataField(current, 'code');
      return typeof code === 'string' && Object.hasOwn(CONTAINER_ERROR_REASONS, code)
        ? CONTAINER_ERROR_REASONS[code as ArchiveContainerErrorCode]
        : 'internal_error';
    }
  }
  return 'internal_error';
}

function compatibilityMetadataForError(error: unknown): {
  formatVersion: number | null;
  minimumSuiteVersion: string | null;
} {
  const chain = boundedErrorChain(error);
  if (!chain.complete) return { formatVersion: null, minimumSuiteVersion: null };
  for (const current of chain.values) {
    if (safeInstanceOf(current, ArchiveCompatibilityError)) {
      const code = ownDataField(current, 'code');
      const formatVersion = ownDataField(current, 'observedFormatVersion');
      const minimumSuiteVersion = ownDataField(current, 'minimumSuiteVersion');
      const safeFormatVersion =
        typeof formatVersion === 'number' &&
        Number.isSafeInteger(formatVersion) &&
        formatVersion >= 0
          ? formatVersion
          : null;
      const exposesUpgradeHint =
        code === 'FUTURE_FORMAT_VERSION' || code === 'FUTURE_SCHEMA_VERSION';
      const safeMinimumSuiteVersion = exposesUpgradeHint
        ? (suiteVersionHintSchema.safeParse(minimumSuiteVersion).data ?? null)
        : null;
      return {
        formatVersion: safeFormatVersion,
        minimumSuiteVersion: safeMinimumSuiteVersion,
      };
    }
  }
  return { formatVersion: null, minimumSuiteVersion: null };
}

function applyCompatibilityMetadata(report: ArchiveReport, error: unknown): void {
  const compatibility = compatibilityMetadataForError(error);
  if (compatibility.formatVersion !== null) {
    report.formatVersion = compatibility.formatVersion;
  }
  report.minimumSuiteVersion = compatibility.minimumSuiteVersion;
}

function safeLocation(
  error: unknown,
): Pick<ArchiveReportIssue, 'archivePath' | 'byteOffset' | 'line'> {
  const chain = boundedErrorChain(error);
  if (!chain.complete) return {};
  const locationError = chain.values.find(
    (current) =>
      safeInstanceOf(current, FileValidationError) || safeInstanceOf(current, JsonlError),
  );
  if (safeInstanceOf(locationError, FileValidationError)) {
    const rawArchivePath = ownDataField(locationError, 'archivePath');
    const rawByteOffset = ownDataField(locationError, 'byteOffset');
    const rawLine = ownDataField(locationError, 'line');
    let archivePath: string | undefined;
    try {
      if (
        typeof rawArchivePath === 'string' &&
        canonicalizeArchiveEntryPath(rawArchivePath) === rawArchivePath
      ) {
        archivePath = rawArchivePath;
      }
    } catch {
      archivePath = undefined;
    }
    return {
      ...(archivePath === undefined ? {} : { archivePath }),
      ...(typeof rawByteOffset === 'number' &&
      Number.isSafeInteger(rawByteOffset) &&
      rawByteOffset >= 0
        ? { byteOffset: rawByteOffset }
        : {}),
      ...(typeof rawLine === 'number' && Number.isSafeInteger(rawLine) && rawLine > 0
        ? { line: rawLine }
        : {}),
    };
  }
  if (safeInstanceOf(locationError, JsonlError)) {
    const rawByteOffset = ownDataField(locationError, 'byteOffset');
    const rawLine = ownDataField(locationError, 'lineNo');
    return {
      ...(typeof rawByteOffset === 'number' &&
      Number.isSafeInteger(rawByteOffset) &&
      rawByteOffset >= 0
        ? { byteOffset: rawByteOffset }
        : {}),
      ...(typeof rawLine === 'number' && Number.isSafeInteger(rawLine) && rawLine > 0
        ? { line: rawLine }
        : {}),
    };
  }
  return {};
}

export async function validateTarZstdArchive(
  input: Readable,
  options: ValidateArchiveOptions = {},
): Promise<ArchiveValidationResult> {
  const limits = resolveValidationLimits(options.limits);
  const containerLimits = resolveValidationContainerLimits(options.containerLimits);
  const report = createArchiveReport({ mode: options.mode ?? 'inspect' });
  const artifactHash = createHash('sha256');
  let artifactBytes = 0;
  let manifest: ArchiveManifest | null = null;
  let checksumEntries: ChecksumEntry[] = [];
  let payload: PreparedPayloadEntry[] = [];
  let payloadIndex = 0;
  let expectedPath = 'manifest.json';
  let checksumSeen = false;
  let accumulator: ModelAccumulator | null = null;
  const evidence: ArchiveEntryEvidence[] = [];

  const hashedInput = Readable.from(
    (async function* () {
      for await (const chunk of input) {
        options.signal?.throwIfAborted();
        const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
        artifactBytes += bytes.byteLength;
        artifactHash.update(bytes);
        yield bytes;
      }
    })(),
  );

  try {
    const container = await readTarZstd(hashedInput, {
      isAllowedPath: (path) => path === expectedPath,
      ...(Object.keys(containerLimits).length === 0 ? {} : { limits: containerLimits }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onEntry: async (entry) => {
        if (entry.path === 'manifest.json') {
          const bytes = await collectBounded(
            entry.stream,
            entry.byteLength,
            limits.maxManifestBytes,
            'manifest_size_limit_exceeded',
          );
          manifest = parseCanonicalManifest(bytes);
          report.formatVersion = manifest.formatVersion;
          if (recordCountFromManifest(manifest) > limits.maxTotalRecords) {
            throw new FileValidationError('record_limit_exceeded', 'manifest.json');
          }
          accumulator = new ModelAccumulator(manifest, report, limits);
          expectedPath = 'checksums.sha256';
          return;
        }
        if (entry.path === 'checksums.sha256') {
          if (manifest === null) throw new FileValidationError('manifest_missing');
          if (entry.byteLength !== Number(manifest.checksumFile.byteLength)) {
            throw new FileValidationError('checksum_length_mismatch', entry.path);
          }
          const bytes = await collectBounded(
            entry.stream,
            entry.byteLength,
            limits.maxChecksumBytes,
            'checksum_size_limit_exceeded',
          );
          if (sha256Hex(bytes) !== manifest.checksumFile.sha256) {
            throw new FileValidationError('checksum_digest_mismatch', entry.path);
          }
          let text: string;
          try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          } catch {
            throw new FileValidationError('checksum_utf8_invalid', entry.path);
          }
          try {
            checksumEntries = parseChecksumFile(text, {
              maxFileBytes: limits.maxChecksumBytes,
            });
          } catch (error) {
            if (error instanceof ChecksumFormatError) {
              throw new FileValidationError(
                CHECKSUM_ERROR_REASONS[error.code],
                entry.path,
                error.line ?? undefined,
              );
            }
            throw error;
          }
          payload = preparePayloadEntries(manifest, checksumEntries);
          checksumSeen = true;
          expectedPath = payload[0]?.path ?? '';
          return;
        }

        const expected = payload[payloadIndex];
        if (
          expected === undefined ||
          entry.path !== expected.path ||
          manifest === null ||
          accumulator === null
        ) {
          throw new FileValidationError('entry_order_mismatch');
        }
        if (entry.byteLength !== Number(expected.byteLength)) {
          throw new FileValidationError('entry_length_mismatch', entry.path);
        }
        const hash = createHash('sha256');
        if (expected.descriptor === null) {
          for await (const _chunk of hashingChunks(entry.stream, hash, entry.signal)) {
            // Intentionally drain and hash blob bytes without buffering them.
          }
        } else {
          let records = 0;
          try {
            for await (const record of decodeJsonl(
              hashingChunks(entry.stream, hash, entry.signal),
              {
                maxLineBytes: limits.maxJsonlLineBytes,
                maxRecords: expected.descriptor.recordCount,
                ...(entry.signal === undefined ? {} : { signal: entry.signal }),
              },
            )) {
              records += 1;
              accumulator.accept({ archivePath: entry.path, line: records, record });
              await validationCheckpoint(records, entry.signal);
            }
          } catch (error) {
            if (error instanceof JsonlError) {
              throw new FileValidationError(
                JSONL_ERROR_REASONS[error.code],
                entry.path,
                error.lineNo,
                error.byteOffset,
              );
            }
            throw error;
          }
          if (records !== expected.descriptor.recordCount) {
            throw new FileValidationError('shard_record_count_mismatch', entry.path);
          }
        }
        const digest = hash.digest('hex');
        if (digest !== expected.checksum.sha256) {
          throw new FileValidationError('entry_digest_mismatch', entry.path);
        }
        evidence.push({
          byteLength: expected.byteLength,
          path: entry.path,
          sha256: digest,
        });
        payloadIndex += 1;
        expectedPath = payload[payloadIndex]?.path ?? '';
      },
    });

    const completedManifest = manifest as ArchiveManifest | null;
    const completedAccumulator = accumulator as ModelAccumulator | null;
    if (completedManifest === null || completedAccumulator === null) {
      throw new FileValidationError('manifest_missing');
    }
    if (!checksumSeen) throw new FileValidationError('checksum_missing');
    if (payloadIndex !== payload.length) throw new FileValidationError('archive_entry_missing');
    await completedAccumulator.finish(checksumEntries, evidence, options.signal);
    report.artifactByteLength = artifactBytes.toString();
    report.artifactSha256 = artifactHash.digest('hex');
    return finalizeModelResult(completedManifest, report, completedAccumulator.records, container);
  } catch (error) {
    if (error instanceof ArchiveValidationError) throw error;
    applyCompatibilityMetadata(report, error);
    markArchiveReportFatal(report, {
      code: 'archive_validation',
      sanitizedReason: reasonForError(error),
      severity: 'error',
      ...safeLocation(error),
    });
    const finalized = finishArchiveReport(report);
    throw new ArchiveValidationError(
      reasonForError(error) === 'record_limit_exceeded'
        ? 'RESOURCE_LIMIT_EXCEEDED'
        : 'ARCHIVE_INVALID',
      finalized,
    );
  }
}
