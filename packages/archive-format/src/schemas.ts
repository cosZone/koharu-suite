import { z } from 'zod';

export const ARCHIVE_FORMAT_NAME = 'koharu-suite-portable-archive';
export const ARCHIVE_FORMAT_VERSION = 1;
export const ARCHIVE_SCHEMA_VERSION = 1;
export const DEFAULT_ARCHIVE_SHARD_RECORDS = 50_000;
export const DEFAULT_ARCHIVE_SHARD_BYTES = 64 * 1_024 * 1_024;

export interface BoundedJsonLimits {
  maxArrayItems: number;
  maxDepth: number;
  maxNodes: number;
  maxObjectKeys: number;
  maxStringCodeUnits: number;
  maxTotalStringCodeUnits: number;
}

export const BOUNDED_JSON_LIMITS: Readonly<BoundedJsonLimits> = Object.freeze({
  maxArrayItems: 4_096,
  maxDepth: 32,
  maxNodes: 16_384,
  maxObjectKeys: 1_024,
  maxStringCodeUnits: 1_048_576,
  maxTotalStringCodeUnits: 4_194_304,
});

export const ARCHIVE_MANIFEST_JSON_LIMITS: Readonly<BoundedJsonLimits> = Object.freeze({
  ...BOUNDED_JSON_LIMITS,
  maxArrayItems: 100_000,
  maxNodes: 1_000_000,
  maxTotalStringCodeUnits: 32 * 1_024 * 1_024,
});

const MAX_TITLE_LENGTH = 512;
const MAX_TEXT_LENGTH = 1_048_576;
const MAX_ENTITY_COUNT = 4_096;
const MAX_EXTENSION_KEYS = 64;
const SIGNED_INT64_MIN = -9_223_372_036_854_775_808n;
const SIGNED_INT64_MAX = 9_223_372_036_854_775_807n;

export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

function isPlainJsonObject(value: object): value is JsonObject {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isJsonValueWithinLimits(
  value: unknown,
  limits: Readonly<BoundedJsonLimits>,
): value is JsonValue {
  const stack: Array<{ depth: number; value: unknown } | { exit: object }> = [{ depth: 0, value }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let totalStringCodeUnits = 0;

  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) return false;
    if ('exit' in item) {
      ancestors.delete(item.exit);
      continue;
    }
    nodes += 1;
    if (nodes > limits.maxNodes || item.depth > limits.maxDepth) {
      return false;
    }

    const current = item.value;
    if (current === null || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current === 'string') {
      totalStringCodeUnits += current.length;
      if (
        current.length > limits.maxStringCodeUnits ||
        totalStringCodeUnits > limits.maxTotalStringCodeUnits
      ) {
        return false;
      }
      continue;
    }
    if (typeof current !== 'object' || ancestors.has(current)) return false;
    ancestors.add(current);
    stack.push({ exit: current });

    if (Array.isArray(current)) {
      if (current.length > limits.maxArrayItems) return false;
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) return false;
        stack.push({ depth: item.depth + 1, value: current[index] });
      }
      continue;
    }

    if (!isPlainJsonObject(current) || Object.getOwnPropertySymbols(current).length > 0)
      return false;
    const keys = Object.keys(current);
    if (keys.length > limits.maxObjectKeys) return false;
    for (const key of keys) {
      totalStringCodeUnits += key.length;
      if (
        key.length === 0 ||
        key.length > 128 ||
        totalStringCodeUnits > limits.maxTotalStringCodeUnits
      ) {
        return false;
      }
      stack.push({ depth: item.depth + 1, value: current[key] });
    }
  }

  return true;
}

export function isBoundedJsonValue(value: unknown): value is JsonValue {
  return isJsonValueWithinLimits(value, BOUNDED_JSON_LIMITS);
}

export const jsonValueSchema = z.custom<JsonValue>(isBoundedJsonValue, {
  message: 'Expected bounded JSON data',
});

export const jsonObjectSchema = z.custom<JsonObject>(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isBoundedJsonValue(value),
  { message: 'Expected a bounded JSON object' },
);

export const extensionsSchema = jsonObjectSchema.refine(
  (value) => Object.keys(value).length <= MAX_EXTENSION_KEYS,
  { message: `Expected at most ${MAX_EXTENSION_KEYS} extension keys` },
);

export const canonicalUtcTimestampSchema = z
  .string()
  .max(32)
  .refine(
    (value) => {
      if (!value.endsWith('Z')) return false;
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
    },
    { message: 'Expected a canonical UTC timestamp' },
  );

function isSignedInt64Decimal(value: string): boolean {
  if (!/^(?:0|-[1-9]\d*|[1-9]\d*)$/u.test(value) || value.length > 20) return false;
  const parsed = BigInt(value);
  return parsed >= SIGNED_INT64_MIN && parsed <= SIGNED_INT64_MAX;
}

export function compareCanonicalInt64Decimals(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export const canonicalSignedDecimalSchema = z
  .string()
  .refine(isSignedInt64Decimal, 'Expected a canonical signed 64-bit decimal string');

export const canonicalNonNegativeDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/u, 'Expected a canonical non-negative decimal string');

export const safeByteLengthDecimalSchema = canonicalNonNegativeDecimalSchema.refine(
  (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
  'Expected a safe non-negative byte length',
);

export const telegramChatIdSchema = canonicalSignedDecimalSchema.refine(
  (value) => BigInt(value) < 0n,
  'Expected a negative Telegram chat ID',
);

export const telegramMessageIdSchema = canonicalSignedDecimalSchema.refine(
  (value) => BigInt(value) > 0n,
  'Expected a positive Telegram message ID',
);

export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, 'Expected a lowercase SHA-256 hex digest');

export const suiteVersionHintSchema = z
  .string()
  .max(128)
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
    'Expected a semantic suite version',
  );

export const archivePortableMetadataSchema = z.strictObject({});
export const archiveProvenancePayloadSchema = z.strictObject({
  type: z.enum(['message', 'service']).optional(),
});
const portableFileNameSchema = z
  .string()
  .max(1_024)
  .refine((value) => !/[\\/\0]/u.test(value), 'Portable file names cannot contain a path');

export const archiveMessageIdentitySchema = z.strictObject({
  telegramChatId: telegramChatIdSchema,
  telegramMessageId: telegramMessageIdSchema,
});

export const archiveRevisionIdentitySchema = archiveMessageIdentitySchema.extend({
  revisionNumber: z.number().int().positive().safe(),
});

export const archiveMessageEntitySchema = z.strictObject({
  customEmojiId: z.string().min(1).max(256).optional(),
  dateTimeFormat: z.string().min(1).max(128).optional(),
  language: z.string().min(1).max(128).optional(),
  length: z.number().int().nonnegative().safe(),
  offset: z.number().int().nonnegative().safe(),
  type: z.string().min(1).max(128),
  unixTime: z.number().int().safe().optional(),
  url: z.string().max(16_384).optional(),
});

export const archiveMediaKindSchema = z.enum([
  'animation',
  'audio',
  'document',
  'photo',
  'video',
  'voice',
]);

export const archiveChannelRecordSchema = z.strictObject({
  recordType: z.literal('channel'),
  telegramChatId: telegramChatIdSchema,
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  username: z.string().min(1).max(64).nullable(),
});

export const archiveVisibilitySchema = z
  .strictObject({
    state: z.enum(['hidden', 'public']),
    changedAt: canonicalUtcTimestampSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.state === 'hidden' && value.changedAt === null) {
      context.addIssue({
        code: 'custom',
        message: 'Hidden visibility requires changedAt',
        path: ['changedAt'],
      });
    }
    if (value.state === 'public' && value.changedAt !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Public visibility requires null changedAt',
        path: ['changedAt'],
      });
    }
  });

export const archiveMessageRecordSchema = z.strictObject({
  recordType: z.literal('message'),
  telegramChatId: telegramChatIdSchema,
  telegramMessageId: telegramMessageIdSchema,
  publishedAt: canonicalUtcTimestampSchema,
  currentRevisionNumber: z.number().int().positive().safe(),
  visibility: archiveVisibilitySchema,
});

export const archiveRevisionRecordSchema = z.strictObject({
  recordType: z.literal('revision'),
  telegramChatId: telegramChatIdSchema,
  telegramMessageId: telegramMessageIdSchema,
  revisionNumber: z.number().int().positive().safe(),
  contentKind: z.enum(['caption', 'none', 'text']),
  text: z.string().max(MAX_TEXT_LENGTH).nullable(),
  entities: z.array(archiveMessageEntitySchema).max(MAX_ENTITY_COUNT),
  authorSignature: z.string().max(512).nullable(),
  mediaGroupId: z.string().min(1).max(256).nullable(),
  editedAt: canonicalUtcTimestampSchema.nullable(),
});

export const archiveMediaSourceSchema = z.strictObject({
  kind: z.enum(['telegram_bot_update', 'telegram_desktop_json']),
  telegramFileId: z.string().min(1).max(512).nullable(),
  telegramFileUniqueId: z.string().min(1).max(512).nullable(),
  mediaType: z.string().min(1).max(128).nullable(),
  metadata: archivePortableMetadataSchema,
});

export const archiveOriginalMediaSchema = z.strictObject({
  sha256: sha256HexSchema,
  byteLength: safeByteLengthDecimalSchema,
  detectedMimeType: z.string().min(1).max(256),
  included: z.boolean(),
});

export const archiveRevisionMediaRecordSchema = z.strictObject({
  recordType: z.literal('revision-media'),
  telegramChatId: telegramChatIdSchema,
  telegramMessageId: telegramMessageIdSchema,
  revisionNumber: z.number().int().positive().safe(),
  position: z.number().int().nonnegative().safe(),
  kind: archiveMediaKindSchema,
  availability: z.enum(['available', 'exceeds_maximum_size', 'not_included', 'unavailable']),
  mimeType: z.string().min(1).max(256).nullable(),
  fileName: portableFileNameSchema.nullable(),
  fileSize: safeByteLengthDecimalSchema.nullable(),
  width: z.number().int().positive().safe().nullable(),
  height: z.number().int().positive().safe().nullable(),
  duration: z.number().int().nonnegative().safe().nullable(),
  source: archiveMediaSourceSchema,
  original: archiveOriginalMediaSchema.nullable(),
});

export const archiveProvenanceSourceIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('telegram_bot_update'),
    telegramUpdateId: canonicalSignedDecimalSchema.refine((value) => BigInt(value) >= 0n, {
      message: 'Expected a non-negative Telegram update ID',
    }),
    updateType: z.enum(['channel_post', 'edited_channel_post']),
  }),
  z.strictObject({
    kind: z.literal('telegram_desktop_json'),
    sourceFileSha256: sha256HexSchema,
    sourceChatId: canonicalSignedDecimalSchema,
    sourceMessageId: telegramMessageIdSchema,
  }),
]);

const provenanceReferenceShape = {
  telegramChatId: telegramChatIdSchema,
  telegramMessageId: telegramMessageIdSchema,
  revisionNumber: z.number().int().positive().safe().nullable(),
};

export const archiveProvenanceObservationRecordSchema = z.strictObject({
  recordType: z.literal('provenance-observation'),
  ...provenanceReferenceShape,
  source: archiveProvenanceSourceIdentitySchema,
  observedAt: canonicalUtcTimestampSchema.nullable(),
  metadata: archivePortableMetadataSchema,
  payload: archiveProvenancePayloadSchema,
});

export const archiveProvenanceMediaRecordSchema = z.strictObject({
  recordType: z.literal('provenance-media'),
  ...provenanceReferenceShape,
  source: archiveProvenanceSourceIdentitySchema,
  position: z.number().int().nonnegative().safe(),
  kind: archiveMediaKindSchema,
  availability: z.enum(['available', 'exceeds_maximum_size', 'not_included', 'unavailable']),
  telegramFileId: z.string().min(1).max(512).nullable(),
  telegramFileUniqueId: z.string().min(1).max(512).nullable(),
  mediaType: z.string().min(1).max(128).nullable(),
  metadata: archivePortableMetadataSchema,
});

export const archiveRecordSchema = z.discriminatedUnion('recordType', [
  archiveChannelRecordSchema,
  archiveMessageRecordSchema,
  archiveRevisionRecordSchema,
  archiveRevisionMediaRecordSchema,
  archiveProvenanceObservationRecordSchema,
  archiveProvenanceMediaRecordSchema,
]);

export const archiveRecordFamilySchema = z.enum([
  'channels',
  'messages',
  'revisions',
  'revision-media',
  'provenance-observations',
  'provenance-media',
]);

export const archiveDataPathSchema = z
  .string()
  .regex(
    /^data\/(?:channels|messages|revisions|revision-media|provenance-observations|provenance-media)\/\d{6}\.jsonl$/u,
    'Expected a canonical archive data shard path',
  );

export const archiveFileDescriptorSchema = z.strictObject({
  path: archiveDataPathSchema,
  family: archiveRecordFamilySchema,
  shardIndex: z.number().int().nonnegative().max(999_999),
  recordCount: z.number().int().positive().max(DEFAULT_ARCHIVE_SHARD_RECORDS),
  byteLength: safeByteLengthDecimalSchema
    .refine((value) => value !== '0', 'Archive data shards cannot be empty')
    .refine(
      (value) => BigInt(value) <= BigInt(DEFAULT_ARCHIVE_SHARD_BYTES),
      'Archive data shard exceeds the byte limit',
    ),
});

const sortedUniqueChatIdsSchema = z
  .array(telegramChatIdSchema)
  .min(1)
  .max(4_096)
  .superRefine((ids, context) => {
    for (let index = 1; index < ids.length; index += 1) {
      const previous = ids[index - 1];
      const current = ids[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        compareCanonicalInt64Decimals(previous, current) >= 0
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Selected Telegram chat IDs must be unique and numerically sorted',
          path: [index],
        });
      }
    }
  });

export const archiveSelectionSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('all') }),
  z.strictObject({
    mode: z.literal('channels'),
    telegramChatIds: sortedUniqueChatIdsSchema,
  }),
]);

export const archiveManifestCountsSchema = z.strictObject({
  channels: z.number().int().nonnegative().safe(),
  messages: z.number().int().nonnegative().safe(),
  visibleMessages: z.number().int().nonnegative().safe(),
  hiddenMessages: z.number().int().nonnegative().safe(),
  revisions: z.number().int().nonnegative().safe(),
  revisionMedia: z.number().int().nonnegative().safe(),
  provenanceObservations: z.number().int().nonnegative().safe(),
  provenanceMedia: z.number().int().nonnegative().safe(),
  blobs: z.number().int().nonnegative().safe(),
});

const FAMILY_ORDER = archiveRecordFamilySchema.options;

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export const archiveManifestSchema = z
  .strictObject({
    format: z.literal(ARCHIVE_FORMAT_NAME),
    formatVersion: z.literal(ARCHIVE_FORMAT_VERSION),
    schemaVersion: z.literal(ARCHIVE_SCHEMA_VERSION),
    exporter: z.strictObject({
      name: z.literal('koharu-suite'),
      version: z.string().min(1).max(128),
    }),
    createdAt: canonicalUtcTimestampSchema,
    snapshotAt: canonicalUtcTimestampSchema,
    selection: archiveSelectionSchema,
    sections: z.strictObject({
      media: z.boolean(),
      provenance: z.boolean(),
    }),
    counts: archiveManifestCountsSchema,
    files: z.array(archiveFileDescriptorSchema).max(100_000),
    checksumFile: z.strictObject({
      path: z.literal('checksums.sha256'),
      sha256: sha256HexSchema,
      byteLength: safeByteLengthDecimalSchema,
    }),
    logicalBytes: z.strictObject({
      data: safeByteLengthDecimalSchema,
      provenance: safeByteLengthDecimalSchema,
      blobs: safeByteLengthDecimalSchema,
      total: safeByteLengthDecimalSchema,
    }),
    missingMedia: z.strictObject({
      references: z.number().int().nonnegative().safe(),
      uniqueObjects: z.number().int().nonnegative().safe(),
      knownBytes: safeByteLengthDecimalSchema,
    }),
  })
  .superRefine((manifest, context) => {
    if (Date.parse(manifest.createdAt) < Date.parse(manifest.snapshotAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Archive creation cannot precede its snapshot',
        path: ['createdAt'],
      });
    }
    if (
      manifest.counts.visibleMessages + manifest.counts.hiddenMessages !==
      manifest.counts.messages
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Visibility counts do not match messages',
        path: ['counts'],
      });
    }

    const calculatedTotal =
      BigInt(manifest.logicalBytes.data) +
      BigInt(manifest.logicalBytes.provenance) +
      BigInt(manifest.logicalBytes.blobs);
    if (calculatedTotal !== BigInt(manifest.logicalBytes.total)) {
      context.addIssue({
        code: 'custom',
        message: 'Logical byte totals do not match',
        path: ['logicalBytes'],
      });
    }

    const expectedCounts: Record<z.infer<typeof archiveRecordFamilySchema>, number> = {
      channels: manifest.counts.channels,
      messages: manifest.counts.messages,
      revisions: manifest.counts.revisions,
      'revision-media': manifest.counts.revisionMedia,
      'provenance-observations': manifest.counts.provenanceObservations,
      'provenance-media': manifest.counts.provenanceMedia,
    };
    const actualCounts = Object.fromEntries(
      FAMILY_ORDER.map((family) => [family, 0]),
    ) as typeof expectedCounts;
    const nextShard = Object.fromEntries(
      FAMILY_ORDER.map((family) => [family, 0]),
    ) as typeof expectedCounts;
    let previousFamilyIndex = -1;
    let previousPath = '';
    let dataBytes = 0n;
    let provenanceBytes = 0n;

    for (const [index, file] of manifest.files.entries()) {
      const familyIndex = FAMILY_ORDER.indexOf(file.family);
      const expectedPath = `data/${file.family}/${file.shardIndex.toString().padStart(6, '0')}.jsonl`;
      if (file.path !== expectedPath) {
        context.addIssue({
          code: 'custom',
          message: 'Shard path does not match its descriptor',
          path: ['files', index],
        });
      }
      if (file.shardIndex !== nextShard[file.family]) {
        context.addIssue({
          code: 'custom',
          message: 'Shard indexes must be zero-based and contiguous',
          path: ['files', index],
        });
      }
      if (
        familyIndex < previousFamilyIndex ||
        (familyIndex === previousFamilyIndex && compareCodeUnits(file.path, previousPath) <= 0)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Shard inventory must be deterministically ordered',
          path: ['files', index],
        });
      }
      nextShard[file.family] += 1;
      actualCounts[file.family] += file.recordCount;
      previousFamilyIndex = familyIndex;
      previousPath = file.path;
      if (file.family.startsWith('provenance-')) provenanceBytes += BigInt(file.byteLength);
      else dataBytes += BigInt(file.byteLength);
    }

    for (const family of FAMILY_ORDER) {
      if (actualCounts[family] !== expectedCounts[family]) {
        context.addIssue({
          code: 'custom',
          message: 'Shard record counts do not match manifest counts',
          path: ['counts', family],
        });
      }
    }
    if (
      dataBytes !== BigInt(manifest.logicalBytes.data) ||
      provenanceBytes !== BigInt(manifest.logicalBytes.provenance)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Shard byte lengths do not match logical byte totals',
        path: ['logicalBytes'],
      });
    }
    if (
      !manifest.sections.provenance &&
      (manifest.counts.provenanceObservations !== 0 || manifest.counts.provenanceMedia !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Disabled provenance section is not empty',
        path: ['sections', 'provenance'],
      });
    }
    if (!manifest.sections.media && manifest.counts.blobs !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'Disabled media section has blobs',
        path: ['sections', 'media'],
      });
    }
    if (!manifest.sections.media && manifest.logicalBytes.blobs !== '0') {
      context.addIssue({
        code: 'custom',
        message: 'Disabled media section has blob bytes',
        path: ['logicalBytes', 'blobs'],
      });
    }
    if (manifest.missingMedia.uniqueObjects > manifest.missingMedia.references) {
      context.addIssue({
        code: 'custom',
        message: 'Missing object count exceeds missing references',
        path: ['missingMedia'],
      });
    }
    if (manifest.missingMedia.uniqueObjects === 0 && manifest.missingMedia.knownBytes !== '0') {
      context.addIssue({
        code: 'custom',
        message: 'Known missing bytes require a known object identity',
        path: ['missingMedia'],
      });
    }
  });

export type ArchiveMessageIdentity = z.infer<typeof archiveMessageIdentitySchema>;
export type ArchiveRevisionIdentity = z.infer<typeof archiveRevisionIdentitySchema>;
export type ArchiveMessageEntity = z.infer<typeof archiveMessageEntitySchema>;
export type ArchiveMediaKind = z.infer<typeof archiveMediaKindSchema>;
export type ArchiveChannelRecord = z.infer<typeof archiveChannelRecordSchema>;
export type ArchiveMessageRecord = z.infer<typeof archiveMessageRecordSchema>;
export type ArchiveRevisionRecord = z.infer<typeof archiveRevisionRecordSchema>;
export type ArchiveRevisionMediaRecord = z.infer<typeof archiveRevisionMediaRecordSchema>;
export type ArchiveProvenanceObservationRecord = z.infer<
  typeof archiveProvenanceObservationRecordSchema
>;
export type ArchiveProvenanceMediaRecord = z.infer<typeof archiveProvenanceMediaRecordSchema>;
export type ArchiveRecord = z.infer<typeof archiveRecordSchema>;
export type ArchiveRecordFamily = z.infer<typeof archiveRecordFamilySchema>;
export type ArchiveFileDescriptor = z.infer<typeof archiveFileDescriptorSchema>;
export type ArchiveManifest = z.infer<typeof archiveManifestSchema>;
