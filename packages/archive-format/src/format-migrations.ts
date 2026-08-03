import { z } from 'zod';
import {
  ARCHIVE_FORMAT_NAME,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveManifest,
  archiveManifestSchema,
  suiteVersionHintSchema,
} from './schemas.js';

export type ArchiveCompatibilityErrorCode =
  | 'FUTURE_FORMAT_VERSION'
  | 'FUTURE_SCHEMA_VERSION'
  | 'INVALID_MANIFEST'
  | 'UNKNOWN_ARCHIVE_FORMAT'
  | 'UNSUPPORTED_FORMAT_VERSION'
  | 'UNSUPPORTED_SCHEMA_VERSION';

/** A content-safe compatibility failure raised before strict manifest parsing. */
export class ArchiveCompatibilityError extends Error {
  constructor(
    readonly code: ArchiveCompatibilityErrorCode,
    readonly minimumSuiteVersion: string | null = null,
    readonly observedFormatVersion: number | null = null,
  ) {
    super(`Archive compatibility check failed: ${code}`);
    this.name = 'ArchiveCompatibilityError';
  }
}

const versionEnvelopeSchema = z.looseObject({
  format: z.string().max(128),
  // Zero is not a valid portable archive version, but parsing it here lets the
  // compatibility boundary return the stable unsupported-version code instead
  // of collapsing an older envelope into a generic malformed-manifest error.
  formatVersion: z.number().int().nonnegative().safe(),
  schemaVersion: z.number().int().nonnegative().safe(),
  minimumSuiteVersion: suiteVersionHintSchema.optional(),
});

/**
 * V1 is the first portable format, so the migration registry is deliberately
 * empty. Add an entry only when a real older wire format becomes supported.
 */
export const archiveFormatMigrations: readonly never[] = Object.freeze([]);

export function parseSupportedArchiveManifest(input: unknown): ArchiveManifest {
  const envelopeResult = versionEnvelopeSchema.safeParse(input);
  if (!envelopeResult.success) {
    throw new ArchiveCompatibilityError('INVALID_MANIFEST');
  }

  const envelope = envelopeResult.data;
  const minimumSuiteVersion = envelope.minimumSuiteVersion ?? null;
  if (envelope.format !== ARCHIVE_FORMAT_NAME) {
    throw new ArchiveCompatibilityError('UNKNOWN_ARCHIVE_FORMAT');
  }
  if (envelope.formatVersion > ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveCompatibilityError(
      'FUTURE_FORMAT_VERSION',
      minimumSuiteVersion,
      envelope.formatVersion,
    );
  }
  if (envelope.formatVersion < ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveCompatibilityError('UNSUPPORTED_FORMAT_VERSION', null, envelope.formatVersion);
  }
  if (envelope.schemaVersion > ARCHIVE_SCHEMA_VERSION) {
    throw new ArchiveCompatibilityError(
      'FUTURE_SCHEMA_VERSION',
      minimumSuiteVersion,
      envelope.formatVersion,
    );
  }
  if (envelope.schemaVersion < ARCHIVE_SCHEMA_VERSION) {
    throw new ArchiveCompatibilityError('UNSUPPORTED_SCHEMA_VERSION', null, envelope.formatVersion);
  }

  const manifestResult = archiveManifestSchema.safeParse(input);
  if (!manifestResult.success) {
    throw new ArchiveCompatibilityError('INVALID_MANIFEST', null, envelope.formatVersion);
  }
  return manifestResult.data;
}
