import {
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveManifest,
  type ArchiveRecord,
  type ArchiveRecordFamily,
  archiveChannelRecordSchema,
  archiveManifestCountsSchema,
  archiveMessageRecordSchema,
  archiveProvenanceMediaRecordSchema,
  archiveProvenanceObservationRecordSchema,
  archiveRevisionMediaRecordSchema,
  archiveRevisionRecordSchema,
  archiveSelectionSchema,
  canonicalNonNegativeDecimalSchema,
  canonicalUtcTimestampSchema,
  sha256HexSchema,
} from '@koharu-suite/archive-format';
import { and, asc, eq, gt, inArray, or, type SQL, sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { Database } from '../db/client.js';
import {
  archiveExportRuns,
  mediaCacheBlobs,
  mediaCacheObjects,
  messageMedia,
  messageRevisions,
  messages,
  telegramChannels,
} from '../db/schema.js';

const ARCHIVE_EXPORT_ADVISORY_LOCK = 6_309_648_946_926_690;
const DEFAULT_PAGE_SIZE = 1_000;
const MAX_PAGE_SIZE = 10_000;
const SAFE_REPORT_SCHEMA_VERSION = 1;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,127}$/u;

type ArchiveSelection = ArchiveManifest['selection'];
type ArchiveCounts = ArchiveManifest['counts'];
type ArchiveTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type ArchiveExportRepositoryErrorCode =
  | 'archive_export_aborted'
  | 'archive_export_busy'
  | 'archive_export_invalid_database_state'
  | 'archive_export_invalid_page_size'
  | 'archive_export_lock_lost'
  | 'archive_export_unknown_channel';

export class ArchiveExportRepositoryError extends Error {
  constructor(
    readonly code: ArchiveExportRepositoryErrorCode,
    readonly telegramChatIds: readonly string[] = [],
  ) {
    super(code);
    this.name = 'ArchiveExportRepositoryError';
  }
}

export interface ArchiveExportSnapshotOptions {
  includeProvenance: boolean;
  pageSize?: number;
  selection: ArchiveSelection;
  signal?: AbortSignal;
}

export interface ArchiveExportSnapshotSummary {
  counts: ArchiveCounts;
  createdAt: string;
  selection: ArchiveSelection;
  snapshotAt: string;
}

export type ArchiveExportRecordVisitor = (
  family: ArchiveRecordFamily,
  record: ArchiveRecord,
) => Promise<void> | void;

export interface CreateArchiveExportRunInput {
  includeProvenance: boolean;
  selection: ArchiveSelection;
}

export interface CompleteArchiveExportRunInput {
  artifactByteLength: string;
  artifactSha256: string;
  counts: ArchiveCounts;
  snapshotAt: string;
}

export interface FailArchiveExportRunInput {
  code: string;
  status: 'failed' | 'interrupted';
}

interface SafeArchiveExportRunReport {
  [key: string]: unknown;
  code: string | null;
  counts: ArchiveCounts | null;
  schemaVersion: 1;
  status: 'clean' | 'failed' | 'interrupted' | 'running';
}

interface SnapshotBoundaryRow {
  [key: string]: unknown;
  backendPid: number;
  snapshotAt: Date;
}

export interface ArchiveExportLease {
  assertActive: (signal?: AbortSignal) => Promise<void>;
  release: () => Promise<void>;
}

interface CanonicalSnapshotCounts {
  channels: number;
  hiddenMessages: number;
  messages: number;
  revisionMedia: number;
  revisions: number;
  visibleMessages: number;
}

interface MessageCursor {
  chatId: bigint;
  messageId: bigint;
}

interface RevisionCursor extends MessageCursor {
  revisionNumber: number;
}

interface RevisionMediaCursor extends RevisionCursor {
  position: number;
}

interface MessageRow {
  currentRevisionNumber: number;
  publishedAt: Date;
  telegramChatId: bigint;
  telegramMessageId: bigint;
  tombstonedAt: Date | null;
}

interface RevisionRow {
  authorSignature: string | null;
  contentKind: string;
  editedAt: Date | null;
  entities: unknown;
  mediaGroupId: string | null;
  revisionNumber: number;
  telegramChatId: bigint;
  telegramMessageId: bigint;
  text: string | null;
}

interface RevisionMediaRow {
  availabilityReason: string | null;
  blobByteLength: bigint | null;
  blobDetectedMime: string | null;
  blobSha256: string | null;
  duration: number | null;
  fileName: string | null;
  fileSize: bigint | null;
  height: number | null;
  kind: string;
  mimeType: string | null;
  position: number;
  revisionNumber: number;
  sourceKind: string;
  sourceMediaType: string | null;
  telegramChatId: bigint;
  telegramFileId: string | null;
  telegramFileUniqueId: string | null;
  telegramMessageId: bigint;
  width: number | null;
}

interface ProvenanceRow {
  [key: string]: unknown;
  channelIdMatches: boolean;
  desktopMappingValid: boolean;
  observedAt: Date | null;
  observationId: string;
  payloadType: string | null;
  revisionBelongsToMessage: boolean;
  revisionNumber: number | null;
  sortKey: string;
  sourceChatId: string | null;
  sourceFileSha256: string | null;
  sourceKind: 'telegram_bot_update' | 'telegram_desktop_json';
  sourceMessageId: bigint;
  telegramChatId: bigint;
  telegramMessageId: bigint;
  telegramMessageIdMatches: boolean;
  telegramUpdateId: bigint | null;
  updateType: string | null;
}

interface ProvenanceMediaRow extends ProvenanceRow {
  availability: string;
  mediaKind: string;
  position: number;
  telegramFileId: string | null;
  telegramFileUniqueId: string | null;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ArchiveExportRepositoryError('archive_export_aborted');
  }
}

function failDatabaseState(): never {
  throw new ArchiveExportRepositoryError('archive_export_invalid_database_state');
}

function canonicalTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) failDatabaseState();
  return canonicalUtcTimestampSchema.parse(timestamp.toISOString());
}

function parsePageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new ArchiveExportRepositoryError('archive_export_invalid_page_size');
  }
  return pageSize;
}

function normalizeSelection(selection: ArchiveSelection): ArchiveSelection {
  return archiveSelectionSchema.parse(selection);
}

function safeRunReport(
  status: SafeArchiveExportRunReport['status'],
  input: { code?: string | null; counts?: ArchiveCounts | null } = {},
): SafeArchiveExportRunReport {
  const code = input.code ?? null;
  if (code !== null && !SAFE_ERROR_CODE.test(code)) {
    throw new TypeError('Archive export run code must be a sanitized token');
  }
  return {
    code,
    counts:
      input.counts === undefined || input.counts === null
        ? null
        : archiveManifestCountsSchema.parse(input.counts),
    schemaVersion: SAFE_REPORT_SCHEMA_VERSION,
    status,
  };
}

function availability(
  value: string | null,
): 'available' | 'exceeds_maximum_size' | 'not_included' | 'unavailable';
function availability(
  value: string | null,
): 'available' | 'exceeds_maximum_size' | 'not_included' | 'unavailable' {
  if (value === null) return 'available';
  if (
    value === 'available' ||
    value === 'exceeds_maximum_size' ||
    value === 'not_included' ||
    value === 'unavailable'
  ) {
    return value;
  }
  return failDatabaseState();
}

function channelScope(
  column: typeof telegramChannels.id,
  ids: readonly string[] | null,
): SQL | undefined;
function channelScope(
  column: typeof messages.channelId,
  ids: readonly string[] | null,
): SQL | undefined;
function channelScope(
  column: typeof telegramChannels.id | typeof messages.channelId,
  ids: readonly string[] | null,
): SQL | undefined {
  return ids === null ? undefined : inArray(column, [...ids]);
}

function rawChannelScope(ids: readonly string[] | null): SQL {
  if (ids === null) return sql.empty();
  return sql`and tc.id in (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

function rawObservationChannelScope(ids: readonly string[] | null): SQL {
  if (ids === null) return sql.empty();
  return sql`and mso.channel_id in (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

function countRow(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) failDatabaseState();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) failDatabaseState();
  return parsed;
}

async function visit(
  visitor: ArchiveExportRecordVisitor,
  family: ArchiveRecordFamily,
  record: ArchiveRecord,
  signal?: AbortSignal,
): Promise<void> {
  assertActive(signal);
  await visitor(family, record);
  assertActive(signal);
}

export class PostgresArchiveExportRepository {
  private readonly cancelClient;
  private readonly lockClient;
  private lockBackendPid: number | undefined;
  private lockSession: postgres.ReservedSql | undefined;
  private lockSessionLost = false;

  constructor(
    databaseUrl: string,
    private readonly database: Database,
  ) {
    this.cancelClient = postgres(databaseUrl, {
      connect_timeout: 5,
      max: 1,
      max_lifetime: null,
    });
    this.lockClient = postgres(databaseUrl, {
      max: 1,
      max_lifetime: null,
      onclose: () => {
        this.lockSessionLost = true;
      },
    });
  }

  async acquireExportLease(signal?: AbortSignal): Promise<ArchiveExportLease> {
    assertActive(signal);
    if (this.lockSession) {
      throw new ArchiveExportRepositoryError('archive_export_busy');
    }

    this.lockSessionLost = false;
    const session = await this.lockClient.reserve();
    let acquired = false;
    try {
      assertActive(signal);
      const [result] = await session<{ acquired: boolean; backendPid: number }[]>`
        select
          pg_try_advisory_lock(${ARCHIVE_EXPORT_ADVISORY_LOCK}) as acquired,
          pg_backend_pid() as "backendPid"
      `;
      if (!result?.acquired) {
        throw new ArchiveExportRepositoryError('archive_export_busy');
      }
      acquired = true;
      assertActive(signal);
      this.lockBackendPid = result.backendPid;
      this.lockSession = session;
    } catch (error) {
      if (acquired) {
        try {
          await session`select pg_advisory_unlock(${ARCHIVE_EXPORT_ADVISORY_LOCK})`;
        } catch {
          // Releasing or closing the reserved connection also releases the session lock.
        }
      }
      session.release();
      throw error;
    }

    let released = false;
    return {
      assertActive: (leaseSignal) => this.assertExportLeaseActive(leaseSignal),
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseExportLease();
      },
    };
  }

  async close(): Promise<void> {
    try {
      await this.releaseExportLease();
    } finally {
      await Promise.all([
        this.cancelClient.end({ timeout: 1 }),
        this.lockClient.end({ timeout: 1 }),
      ]);
    }
  }

  async createRun(input: CreateArchiveExportRunInput): Promise<string> {
    const selection = normalizeSelection(input.selection);
    const [run] = await this.database
      .insert(archiveExportRuns)
      .values({
        formatVersion: ARCHIVE_FORMAT_VERSION,
        includeProvenance: input.includeProvenance,
        report: safeRunReport('running'),
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        selection,
        status: 'running',
      })
      .returning({ id: archiveExportRuns.id });
    if (!run) failDatabaseState();
    return run.id;
  }

  async completeRun(id: string, input: CompleteArchiveExportRunInput): Promise<void> {
    const artifactSha256 = sha256HexSchema.parse(input.artifactSha256);
    const artifactByteLength = canonicalNonNegativeDecimalSchema.parse(input.artifactByteLength);
    if (artifactByteLength === '0')
      throw new TypeError('Completed archive artifact cannot be empty');
    const snapshotAt = new Date(canonicalUtcTimestampSchema.parse(input.snapshotAt));
    const counts = archiveManifestCountsSchema.parse(input.counts);
    const [updated] = await this.database
      .update(archiveExportRuns)
      .set({
        artifactByteLength: BigInt(artifactByteLength),
        artifactSha256,
        completedAt: sql`clock_timestamp()`,
        report: safeRunReport('clean', { counts }),
        snapshotAt,
        status: 'completed',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(eq(archiveExportRuns.id, id), eq(archiveExportRuns.status, 'running')))
      .returning({ id: archiveExportRuns.id });
    if (!updated) failDatabaseState();
  }

  async failRun(id: string, input: FailArchiveExportRunInput): Promise<void> {
    const [updated] = await this.database
      .update(archiveExportRuns)
      .set({
        completedAt: sql`clock_timestamp()`,
        report: safeRunReport(input.status, { code: input.code }),
        status: input.status,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(eq(archiveExportRuns.id, id), eq(archiveExportRuns.status, 'running')))
      .returning({ id: archiveExportRuns.id });
    if (!updated) failDatabaseState();
  }

  async readSnapshot(
    options: ArchiveExportSnapshotOptions,
    visitor: ArchiveExportRecordVisitor,
  ): Promise<ArchiveExportSnapshotSummary> {
    const selection = normalizeSelection(options.selection);
    const pageSize = parsePageSize(options.pageSize);
    assertActive(options.signal);

    try {
      return await this.database.transaction(
        async (transaction) => {
          const [boundary] = await transaction.execute<SnapshotBoundaryRow>(sql`
          select
            pg_backend_pid() as "backendPid",
            statement_timestamp() as "snapshotAt",
            pg_current_snapshot()::text as "snapshotId"
        `);
          if (!boundary) failDatabaseState();
          let cancelPromise: Promise<void> | undefined;
          const cancelSnapshot = () => {
            cancelPromise ??= this.cancelSnapshotBackend(boundary.backendPid);
          };
          options.signal?.addEventListener('abort', cancelSnapshot, { once: true });
          if (options.signal?.aborted) cancelSnapshot();
          try {
            const snapshotAt = canonicalTimestamp(boundary.snapshotAt);
            assertActive(options.signal);

            const selectedChannelIds = await this.resolveSelectedChannelIds(transaction, selection);
            const expected = await this.readCanonicalCounts(transaction, selectedChannelIds);
            const counts: ArchiveCounts = {
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

            await this.visitChannels(
              transaction,
              selectedChannelIds,
              pageSize,
              visitor,
              counts,
              options.signal,
            );
            await this.visitMessages(
              transaction,
              selectedChannelIds,
              pageSize,
              visitor,
              counts,
              options.signal,
            );
            await this.visitRevisions(
              transaction,
              selectedChannelIds,
              pageSize,
              visitor,
              counts,
              options.signal,
            );
            await this.visitRevisionMedia(
              transaction,
              selectedChannelIds,
              pageSize,
              visitor,
              counts,
              options.signal,
            );
            if (options.includeProvenance) {
              await this.visitProvenanceObservations(
                transaction,
                selectedChannelIds,
                pageSize,
                visitor,
                counts,
                options.signal,
              );
              await this.visitProvenanceMedia(
                transaction,
                selectedChannelIds,
                pageSize,
                visitor,
                counts,
                options.signal,
              );
            }

            if (
              counts.channels !== expected.channels ||
              counts.messages !== expected.messages ||
              counts.visibleMessages !== expected.visibleMessages ||
              counts.hiddenMessages !== expected.hiddenMessages ||
              counts.revisions !== expected.revisions ||
              counts.revisionMedia !== expected.revisionMedia
            ) {
              failDatabaseState();
            }
            archiveManifestCountsSchema.parse(counts);
            const [finished] = await transaction.execute<{ createdAt: Date }>(
              sql`select clock_timestamp() as "createdAt"`,
            );
            if (!finished) failDatabaseState();
            return {
              counts,
              createdAt: canonicalTimestamp(finished.createdAt),
              selection,
              snapshotAt,
            };
          } finally {
            options.signal?.removeEventListener('abort', cancelSnapshot);
            await cancelPromise?.catch(() => undefined);
          }
        },
        { accessMode: 'read only', isolationLevel: 'repeatable read' },
      );
    } catch (error) {
      if (options.signal?.aborted) {
        throw new ArchiveExportRepositoryError('archive_export_aborted');
      }
      throw error;
    }
  }

  private async cancelSnapshotBackend(backendPid: number): Promise<void> {
    await this.cancelClient`select pg_cancel_backend(${backendPid})`;
  }

  private async releaseExportLease(): Promise<void> {
    const session = this.lockSession;
    const backendPid = this.lockBackendPid;
    if (!session) return;

    try {
      if (backendPid === undefined || this.lockSessionLost) {
        throw new ArchiveExportRepositoryError('archive_export_lock_lost');
      }
      const [result] = await session<{ backendPid: number; released: boolean }[]>`
        select
          pg_backend_pid() as "backendPid",
          pg_advisory_unlock(${ARCHIVE_EXPORT_ADVISORY_LOCK}) as released
      `;
      if (result?.backendPid !== backendPid || !result.released) {
        throw new ArchiveExportRepositoryError('archive_export_lock_lost');
      }
    } finally {
      this.lockBackendPid = undefined;
      this.lockSessionLost = true;
      session.release();
      this.lockSession = undefined;
    }
  }

  private async assertExportLeaseActive(signal?: AbortSignal): Promise<void> {
    assertActive(signal);
    const session = this.lockSession;
    const backendPid = this.lockBackendPid;
    if (!session || backendPid === undefined || this.lockSessionLost) {
      throw new ArchiveExportRepositoryError('archive_export_lock_lost');
    }

    let currentBackendPid: number | undefined;
    try {
      const [result] = await session<{ backendPid: number }[]>`
        select pg_backend_pid() as "backendPid"
      `;
      currentBackendPid = result?.backendPid;
    } catch {
      this.lockSessionLost = true;
      throw new ArchiveExportRepositoryError('archive_export_lock_lost');
    }
    if (this.lockSessionLost || currentBackendPid !== backendPid) {
      this.lockSessionLost = true;
      throw new ArchiveExportRepositoryError('archive_export_lock_lost');
    }
    assertActive(signal);
  }

  private async resolveSelectedChannelIds(
    transaction: ArchiveTransaction,
    selection: ArchiveSelection,
  ): Promise<string[] | null> {
    if (selection.mode === 'all') return null;
    const requested = selection.telegramChatIds.map(BigInt);
    const rows = await transaction
      .select({ id: telegramChannels.id, telegramChatId: telegramChannels.telegramChatId })
      .from(telegramChannels)
      .where(inArray(telegramChannels.telegramChatId, requested))
      .orderBy(asc(telegramChannels.telegramChatId));
    const found = new Set(rows.map((row) => row.telegramChatId.toString()));
    const missing = selection.telegramChatIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new ArchiveExportRepositoryError('archive_export_unknown_channel', missing);
    }
    return rows.map((row) => row.id);
  }

  private async readCanonicalCounts(
    transaction: ArchiveTransaction,
    selectedChannelIds: readonly string[] | null,
  ): Promise<CanonicalSnapshotCounts> {
    const channelWhere = channelScope(telegramChannels.id, selectedChannelIds);
    const messageWhere = channelScope(messages.channelId, selectedChannelIds);
    const [channelCount] = await transaction
      .select({ count: sql<string>`count(*)::text` })
      .from(telegramChannels)
      .where(channelWhere);
    const [messageCount] = await transaction
      .select({
        count: sql<string>`count(*)::text`,
        hidden: sql<string>`count(*) filter (where ${messages.tombstonedAt} is not null)::text`,
        visible: sql<string>`count(*) filter (where ${messages.tombstonedAt} is null)::text`,
      })
      .from(messages)
      .where(messageWhere);
    const [revisionCount] = await transaction
      .select({ count: sql<string>`count(*)::text` })
      .from(messageRevisions)
      .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
      .where(messageWhere);
    const [mediaCount] = await transaction
      .select({ count: sql<string>`count(*)::text` })
      .from(messageMedia)
      .innerJoin(messageRevisions, eq(messageRevisions.id, messageMedia.revisionId))
      .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
      .where(messageWhere);
    if (!channelCount || !messageCount || !revisionCount || !mediaCount) failDatabaseState();
    return {
      channels: countRow(channelCount.count),
      hiddenMessages: countRow(messageCount.hidden),
      messages: countRow(messageCount.count),
      revisionMedia: countRow(mediaCount.count),
      revisions: countRow(revisionCount.count),
      visibleMessages: countRow(messageCount.visible),
    };
  }

  private async visitChannels(
    transaction: ArchiveTransaction,
    selectedChannelIds: readonly string[] | null,
    pageSize: number,
    visitor: ArchiveExportRecordVisitor,
    counts: ArchiveCounts,
    signal?: AbortSignal,
  ): Promise<void> {
    let cursor: bigint | null = null;
    while (true) {
      assertActive(signal);
      const rows = await transaction
        .select({
          telegramChatId: telegramChannels.telegramChatId,
          title: telegramChannels.title,
          username: telegramChannels.username,
        })
        .from(telegramChannels)
        .where(
          and(
            channelScope(telegramChannels.id, selectedChannelIds),
            cursor === null ? undefined : gt(telegramChannels.telegramChatId, cursor),
          ),
        )
        .orderBy(asc(telegramChannels.telegramChatId))
        .limit(pageSize);
      for (const row of rows) {
        const record = archiveChannelRecordSchema.parse({
          recordType: 'channel',
          telegramChatId: row.telegramChatId.toString(),
          title: row.title,
          username: row.username,
        });
        await visit(visitor, 'channels', record, signal);
        counts.channels += 1;
      }
      if (rows.length < pageSize) return;
      cursor = rows.at(-1)?.telegramChatId ?? failDatabaseState();
    }
  }

  private async visitMessages(
    transaction: ArchiveTransaction,
    selectedChannelIds: readonly string[] | null,
    pageSize: number,
    visitor: ArchiveExportRecordVisitor,
    counts: ArchiveCounts,
    signal?: AbortSignal,
  ): Promise<void> {
    let cursor: MessageCursor | null = null;
    while (true) {
      assertActive(signal);
      const currentCursor: MessageCursor | null = cursor;
      const rows: MessageRow[] = await transaction
        .select({
          currentRevisionNumber: messages.currentRevisionNumber,
          publishedAt: messages.publishedAt,
          telegramChatId: telegramChannels.telegramChatId,
          telegramMessageId: messages.telegramMessageId,
          tombstonedAt: messages.tombstonedAt,
        })
        .from(messages)
        .innerJoin(telegramChannels, eq(telegramChannels.id, messages.channelId))
        .where(
          and(
            channelScope(messages.channelId, selectedChannelIds),
            currentCursor === null
              ? undefined
              : or(
                  gt(telegramChannels.telegramChatId, currentCursor.chatId),
                  and(
                    eq(telegramChannels.telegramChatId, currentCursor.chatId),
                    gt(messages.telegramMessageId, currentCursor.messageId),
                  ),
                ),
          ),
        )
        .orderBy(asc(telegramChannels.telegramChatId), asc(messages.telegramMessageId))
        .limit(pageSize);
      for (const row of rows) {
        const hidden = row.tombstonedAt !== null;
        const record = archiveMessageRecordSchema.parse({
          currentRevisionNumber: row.currentRevisionNumber,
          publishedAt: canonicalTimestamp(row.publishedAt),
          recordType: 'message',
          telegramChatId: row.telegramChatId.toString(),
          telegramMessageId: row.telegramMessageId.toString(),
          visibility: {
            changedAt: hidden ? canonicalTimestamp(row.tombstonedAt as Date) : null,
            state: hidden ? 'hidden' : 'public',
          },
        });
        await visit(visitor, 'messages', record, signal);
        counts.messages += 1;
        if (hidden) counts.hiddenMessages += 1;
        else counts.visibleMessages += 1;
      }
      if (rows.length < pageSize) return;
      const last = rows.at(-1) ?? failDatabaseState();
      cursor = { chatId: last.telegramChatId, messageId: last.telegramMessageId };
    }
  }

  private async visitRevisions(
    transaction: ArchiveTransaction,
    selectedChannelIds: readonly string[] | null,
    pageSize: number,
    visitor: ArchiveExportRecordVisitor,
    counts: ArchiveCounts,
    signal?: AbortSignal,
  ): Promise<void> {
    let cursor: RevisionCursor | null = null;
    while (true) {
      assertActive(signal);
      const currentCursor: RevisionCursor | null = cursor;
      const rows: RevisionRow[] = await transaction
        .select({
          authorSignature: messageRevisions.authorSignature,
          contentKind: messageRevisions.contentKind,
          editedAt: messageRevisions.editedAt,
          entities: messageRevisions.entities,
          mediaGroupId: messageRevisions.mediaGroupId,
          revisionNumber: messageRevisions.revisionNumber,
          telegramChatId: telegramChannels.telegramChatId,
          telegramMessageId: messages.telegramMessageId,
          text: messageRevisions.text,
        })
        .from(messageRevisions)
        .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
        .innerJoin(telegramChannels, eq(telegramChannels.id, messages.channelId))
        .where(
          and(
            channelScope(messages.channelId, selectedChannelIds),
            currentCursor === null
              ? undefined
              : or(
                  gt(telegramChannels.telegramChatId, currentCursor.chatId),
                  and(
                    eq(telegramChannels.telegramChatId, currentCursor.chatId),
                    gt(messages.telegramMessageId, currentCursor.messageId),
                  ),
                  and(
                    eq(telegramChannels.telegramChatId, currentCursor.chatId),
                    eq(messages.telegramMessageId, currentCursor.messageId),
                    gt(messageRevisions.revisionNumber, currentCursor.revisionNumber),
                  ),
                ),
          ),
        )
        .orderBy(
          asc(telegramChannels.telegramChatId),
          asc(messages.telegramMessageId),
          asc(messageRevisions.revisionNumber),
        )
        .limit(pageSize);
      for (const row of rows) {
        const record = archiveRevisionRecordSchema.parse({
          authorSignature: row.authorSignature,
          contentKind: row.contentKind,
          editedAt: row.editedAt === null ? null : canonicalTimestamp(row.editedAt),
          entities: row.entities,
          mediaGroupId: row.mediaGroupId,
          recordType: 'revision',
          revisionNumber: row.revisionNumber,
          telegramChatId: row.telegramChatId.toString(),
          telegramMessageId: row.telegramMessageId.toString(),
          text: row.text,
        });
        await visit(visitor, 'revisions', record, signal);
        counts.revisions += 1;
      }
      if (rows.length < pageSize) return;
      const last = rows.at(-1) ?? failDatabaseState();
      cursor = {
        chatId: last.telegramChatId,
        messageId: last.telegramMessageId,
        revisionNumber: last.revisionNumber,
      };
    }
  }

  private async visitRevisionMedia(
    transaction: ArchiveTransaction,
    selectedChannelIds: readonly string[] | null,
    pageSize: number,
    visitor: ArchiveExportRecordVisitor,
    counts: ArchiveCounts,
    signal?: AbortSignal,
  ): Promise<void> {
    let cursor: RevisionMediaCursor | null = null;
    while (true) {
      assertActive(signal);
      const currentCursor: RevisionMediaCursor | null = cursor;
      const rows: RevisionMediaRow[] = await transaction
        .select({
          availabilityReason: messageMedia.availabilityReason,
          blobByteLength: mediaCacheBlobs.byteLength,
          blobDetectedMime: mediaCacheBlobs.detectedMime,
          blobSha256: mediaCacheBlobs.sha256,
          duration: messageMedia.duration,
          fileName: messageMedia.fileName,
          fileSize: messageMedia.fileSize,
          height: messageMedia.height,
          kind: messageMedia.kind,
          mimeType: messageMedia.mimeType,
          position: messageMedia.position,
          revisionNumber: messageRevisions.revisionNumber,
          sourceKind: messageMedia.sourceKind,
          sourceMediaType: messageMedia.sourceMediaType,
          telegramChatId: telegramChannels.telegramChatId,
          telegramFileId: messageMedia.telegramFileId,
          telegramFileUniqueId: messageMedia.telegramFileUniqueId,
          telegramMessageId: messages.telegramMessageId,
          width: messageMedia.width,
        })
        .from(messageMedia)
        .innerJoin(messageRevisions, eq(messageRevisions.id, messageMedia.revisionId))
        .innerJoin(messages, eq(messages.id, messageRevisions.messageId))
        .innerJoin(telegramChannels, eq(telegramChannels.id, messages.channelId))
        .leftJoin(
          mediaCacheObjects,
          and(
            eq(mediaCacheObjects.canonicalMediaId, messageMedia.id),
            eq(mediaCacheObjects.revisionId, messageRevisions.id),
            eq(mediaCacheObjects.variant, 'original'),
            eq(mediaCacheObjects.recipeVersion, 1),
          ),
        )
        .leftJoin(mediaCacheBlobs, eq(mediaCacheBlobs.sha256, mediaCacheObjects.blobSha256))
        .where(
          and(
            channelScope(messages.channelId, selectedChannelIds),
            currentCursor === null
              ? undefined
              : or(
                  gt(telegramChannels.telegramChatId, currentCursor.chatId),
                  and(
                    eq(telegramChannels.telegramChatId, currentCursor.chatId),
                    gt(messages.telegramMessageId, currentCursor.messageId),
                  ),
                  and(
                    eq(telegramChannels.telegramChatId, currentCursor.chatId),
                    eq(messages.telegramMessageId, currentCursor.messageId),
                    gt(messageRevisions.revisionNumber, currentCursor.revisionNumber),
                  ),
                  and(
                    eq(telegramChannels.telegramChatId, currentCursor.chatId),
                    eq(messages.telegramMessageId, currentCursor.messageId),
                    eq(messageRevisions.revisionNumber, currentCursor.revisionNumber),
                    gt(messageMedia.position, currentCursor.position),
                  ),
                ),
          ),
        )
        .orderBy(
          asc(telegramChannels.telegramChatId),
          asc(messages.telegramMessageId),
          asc(messageRevisions.revisionNumber),
          asc(messageMedia.position),
        )
        .limit(pageSize);
      for (const row of rows) {
        const hasOriginal = row.blobSha256 !== null;
        if (
          hasOriginal !== (row.blobByteLength !== null) ||
          hasOriginal !== (row.blobDetectedMime !== null)
        ) {
          failDatabaseState();
        }
        const record = archiveRevisionMediaRecordSchema.parse({
          availability: availability(row.availabilityReason),
          duration: row.duration,
          fileName: row.fileName,
          fileSize: row.fileSize?.toString() ?? null,
          height: row.height,
          kind: row.kind,
          mimeType: row.mimeType,
          original: hasOriginal
            ? {
                byteLength: (row.blobByteLength as bigint).toString(),
                detectedMimeType: row.blobDetectedMime as string,
                included: false,
                sha256: row.blobSha256 as string,
              }
            : null,
          position: row.position,
          recordType: 'revision-media',
          revisionNumber: row.revisionNumber,
          source: {
            kind: row.sourceKind,
            mediaType: row.sourceMediaType,
            metadata: {},
            telegramFileId: row.telegramFileId,
            telegramFileUniqueId: row.telegramFileUniqueId,
          },
          telegramChatId: row.telegramChatId.toString(),
          telegramMessageId: row.telegramMessageId.toString(),
          width: row.width,
        });
        await visit(visitor, 'revision-media', record, signal);
        counts.revisionMedia += 1;
      }
      if (rows.length < pageSize) return;
      const last = rows.at(-1) ?? failDatabaseState();
      cursor = {
        chatId: last.telegramChatId,
        messageId: last.telegramMessageId,
        position: last.position,
        revisionNumber: last.revisionNumber,
      };
    }
  }

  private async visitProvenanceObservations(
    transaction: ArchiveTransaction,
    selectedChannelIds: readonly string[] | null,
    pageSize: number,
    visitor: ArchiveExportRecordVisitor,
    counts: ArchiveCounts,
    signal?: AbortSignal,
  ): Promise<void> {
    await transaction.execute(sql`
      declare archive_provenance_observations no scroll cursor for
      ${this.provenanceBase(selectedChannelIds)}
      select *
      from portable_provenance
      order by "sortKey" collate "C", "observationId"
    `);
    try {
      while (true) {
        assertActive(signal);
        const rows = await transaction.execute<ProvenanceRow>(sql`
          fetch forward ${sql.raw(pageSize.toString())} from archive_provenance_observations
        `);
        for (const row of rows) {
          this.assertProvenanceRow(row);
          const source = this.provenanceSource(row);
          const payload =
            row.payloadType === 'message' || row.payloadType === 'service'
              ? { type: row.payloadType }
              : {};
          const record = archiveProvenanceObservationRecordSchema.parse({
            metadata: {},
            observedAt: row.observedAt === null ? null : canonicalTimestamp(row.observedAt),
            payload,
            recordType: 'provenance-observation',
            revisionNumber: row.revisionNumber,
            source,
            telegramChatId: row.telegramChatId.toString(),
            telegramMessageId: row.telegramMessageId.toString(),
          });
          await visit(visitor, 'provenance-observations', record, signal);
          counts.provenanceObservations += 1;
        }
        if (rows.length < pageSize) return;
      }
    } finally {
      await transaction.execute(sql`close archive_provenance_observations`).catch(() => undefined);
    }
  }

  private async visitProvenanceMedia(
    transaction: ArchiveTransaction,
    selectedChannelIds: readonly string[] | null,
    pageSize: number,
    visitor: ArchiveExportRecordVisitor,
    counts: ArchiveCounts,
    signal?: AbortSignal,
  ): Promise<void> {
    await transaction.execute(sql`
      declare archive_provenance_media no scroll cursor for
      ${this.provenanceBase(selectedChannelIds)}
      select
        pp.*,
        msmo.position,
        msmo.media_kind as "mediaKind",
        msmo.availability::text as "availability",
        msmo.telegram_file_id as "telegramFileId",
        msmo.telegram_file_unique_id as "telegramFileUniqueId"
      from portable_provenance pp
      inner join message_source_media_observations msmo
        on msmo.observation_id = pp."observationId"
        and msmo.source_kind = pp."sourceKind"
      order by pp."sortKey" collate "C", msmo.position, pp."observationId"
    `);
    try {
      while (true) {
        assertActive(signal);
        const rows = await transaction.execute<ProvenanceMediaRow>(sql`
          fetch forward ${sql.raw(pageSize.toString())} from archive_provenance_media
        `);
        for (const row of rows) {
          this.assertProvenanceRow(row);
          const record = archiveProvenanceMediaRecordSchema.parse({
            availability: availability(row.availability),
            kind: row.mediaKind,
            mediaType: null,
            metadata: {},
            position: row.position,
            recordType: 'provenance-media',
            revisionNumber: row.revisionNumber,
            source: this.provenanceSource(row),
            telegramChatId: row.telegramChatId.toString(),
            telegramFileId: row.telegramFileId,
            telegramFileUniqueId: row.telegramFileUniqueId,
            telegramMessageId: row.telegramMessageId.toString(),
          });
          await visit(visitor, 'provenance-media', record, signal);
          counts.provenanceMedia += 1;
        }
        if (rows.length < pageSize) return;
      }
    } finally {
      await transaction.execute(sql`close archive_provenance_media`).catch(() => undefined);
    }
  }

  private provenanceSource(row: ProvenanceRow) {
    if (row.sourceKind === 'telegram_bot_update') {
      if (row.telegramUpdateId === null || row.updateType === null) failDatabaseState();
      return {
        kind: 'telegram_bot_update' as const,
        telegramUpdateId: row.telegramUpdateId.toString(),
        updateType: row.updateType,
      };
    }
    if (row.sourceFileSha256 === null || row.sourceChatId === null) failDatabaseState();
    return {
      kind: 'telegram_desktop_json' as const,
      sourceChatId: row.sourceChatId,
      sourceFileSha256: row.sourceFileSha256,
      sourceMessageId: row.sourceMessageId.toString(),
    };
  }

  private assertProvenanceRow(row: ProvenanceRow): void {
    if (
      !row.channelIdMatches ||
      !row.desktopMappingValid ||
      !row.revisionBelongsToMessage ||
      !row.telegramMessageIdMatches
    ) {
      failDatabaseState();
    }
  }

  private provenanceBase(selectedChannelIds: readonly string[] | null): SQL {
    return sql`
      with desktop_link_candidates as (
        select
          mso.id as observation_id,
          ir.source_file_sha256,
          selected_chat.value ->> 'sourceChatId' as source_chat_id
        from message_source_observations mso
        left join import_run_observations iro on iro.observation_id = mso.id
        left join import_runs ir on ir.id = iro.run_id
        left join lateral jsonb_array_elements(
          case
            when jsonb_typeof(ir.report -> 'selectedChats') = 'array'
              then ir.report -> 'selectedChats'
            else '[]'::jsonb
          end
        ) selected_chat(value)
          on selected_chat.value ->> 'canonicalChannelId' = (
            select tc_inner.telegram_chat_id::text
            from telegram_channels tc_inner
            where tc_inner.id = mso.channel_id
          )
        where mso.source_kind = 'telegram_desktop_json'
          ${rawObservationChannelScope(selectedChannelIds)}
      ), desktop_links as (
        select
          observation_id,
          source_file_sha256,
          min(source_chat_id) as source_chat_id,
          count(distinct source_chat_id) = 1 as mapping_valid
        from desktop_link_candidates
        group by observation_id, source_file_sha256
      ), provenance_rows as (
        select
          tc.telegram_chat_id as "telegramChatId",
          m.telegram_message_id as "telegramMessageId",
          mso.telegram_message_id as "sourceMessageId",
          mr.revision_number as "revisionNumber",
          mso.id as "observationId",
          mso.source_kind as "sourceKind",
          mso.observed_at as "observedAt",
          case
            when mso.raw_json ->> 'type' in ('message', 'service') then mso.raw_json ->> 'type'
            else null
          end as "payloadType",
          mso.telegram_update_id as "telegramUpdateId",
          tu.update_type as "updateType",
          null::text as "sourceFileSha256",
          null::text as "sourceChatId",
          mso.telegram_message_id = m.telegram_message_id as "telegramMessageIdMatches",
          coalesce(mr.message_id = mso.message_id, mso.revision_id is null)
            as "revisionBelongsToMessage",
          tu.channel_id = mso.channel_id and m.channel_id = mso.channel_id as "channelIdMatches",
          true as "desktopMappingValid"
        from message_source_observations mso
        inner join telegram_channels tc on tc.id = mso.channel_id
        inner join messages m on m.id = mso.message_id
        left join message_revisions mr on mr.id = mso.revision_id
        left join telegram_updates tu on tu.telegram_update_id = mso.telegram_update_id
        where mso.source_kind = 'telegram_bot_update'
          ${rawChannelScope(selectedChannelIds)}

        union all

        select
          tc.telegram_chat_id as "telegramChatId",
          m.telegram_message_id as "telegramMessageId",
          mso.telegram_message_id as "sourceMessageId",
          mr.revision_number as "revisionNumber",
          mso.id as "observationId",
          mso.source_kind as "sourceKind",
          mso.observed_at as "observedAt",
          case
            when mso.raw_json ->> 'type' in ('message', 'service') then mso.raw_json ->> 'type'
            else null
          end as "payloadType",
          null::bigint as "telegramUpdateId",
          null::text as "updateType",
          dl.source_file_sha256 as "sourceFileSha256",
          dl.source_chat_id as "sourceChatId",
          mso.telegram_message_id = m.telegram_message_id as "telegramMessageIdMatches",
          coalesce(mr.message_id = mso.message_id, mso.revision_id is null)
            as "revisionBelongsToMessage",
          m.channel_id = mso.channel_id as "channelIdMatches",
          coalesce(dl.mapping_valid, false) as "desktopMappingValid"
        from message_source_observations mso
        inner join telegram_channels tc on tc.id = mso.channel_id
        inner join messages m on m.id = mso.message_id
        left join message_revisions mr on mr.id = mso.revision_id
        left join desktop_links dl on dl.observation_id = mso.id
        where mso.source_kind = 'telegram_desktop_json'
          ${rawChannelScope(selectedChannelIds)}
      ), portable_provenance as (
        select
          provenance_rows.*,
          (
            lpad(("telegramChatId"::numeric + 9223372036854775808)::text, 20, '0') || ':' ||
            lpad(("telegramMessageId"::numeric + 9223372036854775808)::text, 20, '0') || ':' ||
            case
              when "revisionNumber" is null then '0'
              else '1' || lpad(("revisionNumber"::bigint + 2147483648)::text, 10, '0')
            end || ':' ||
            case
              when "sourceKind" = 'telegram_bot_update' then
                '0:' || coalesce(
                  lpad(("telegramUpdateId"::numeric + 9223372036854775808)::text, 20, '0'),
                  '!'
                ) || ':' || coalesce("updateType", '!')
              else
                '1:' || coalesce("sourceFileSha256", '!') || ':' ||
                case
                  when "sourceChatId" ~ '^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$'
                    and "sourceChatId"::numeric between -9223372036854775808 and 9223372036854775807
                    then lpad(("sourceChatId"::numeric + 9223372036854775808)::text, 20, '0')
                  else '!'
                end || ':' ||
                lpad(("sourceMessageId"::numeric + 9223372036854775808)::text, 20, '0')
            end
          ) as "sortKey"
        from provenance_rows
      )
    `;
  }
}
