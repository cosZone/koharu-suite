import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  messageMedia,
  messageRevisions,
  messageSourceMediaObservations,
  messageSourceObservations,
  messages,
  telegramChannelAllowlist,
  telegramChannels,
  telegramIngestTasks,
  telegramPollingState,
  telegramPollReceipts,
  workerRuntime,
} from '../db/schema.js';
import { CURRENT_RENDERER_VERSION, renderTelegramMessage } from '../messages/renderer.js';
import type { ReconciliationEvidenceKind, ReconciliationFindingSeverity } from './types.js';

export const RECONCILIATION_SCAN_BATCH_SIZE = 500;
export const RECONCILIATION_SCAN_CHANNEL_LIMIT = 100;
export const RECONCILIATION_ADVISORY_LOCK = 6_309_648_946_926_690;
export const TELEGRAM_RETENTION_RISK_MS = 24 * 60 * 60 * 1_000;

export interface ReconciliationCandidate {
  channelId: string | null;
  evidenceIds?: string[];
  evidenceVersion: number;
  kind: ReconciliationEvidenceKind;
  messageId?: string;
  observationId?: string;
  sanitizedReason: string;
  severity: ReconciliationFindingSeverity;
}

export interface ReconciliationScanSnapshot {
  scanned: number;
}

export type ReconciliationCandidateVisitor = (
  candidate: ReconciliationCandidate,
) => Promise<void> | void;

export interface ReconciliationScanner {
  scanDryRun(
    telegramChannelIds: readonly bigint[],
    now: Date,
    visit: ReconciliationCandidateVisitor,
  ): Promise<ReconciliationScanSnapshot>;
}

export class ReconciliationScopeError extends Error {}

type ReconciliationTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type TaskScanRow = {
  blockedAt: Date | null;
  id: string;
  skippedAt: Date | null;
  telegramChatId: bigint;
  telegramUpdateId: bigint;
};
type ReceiptScanRow = {
  id: string;
  requestedOffset: bigint | null;
  returnedFirstUpdateId: bigint;
};
type ChannelMessageScanRow = {
  channelId: bigint;
  telegramMessageId: bigint;
};
type ObservationScanRow = {
  channelId: bigint;
  id: string;
  messageId: string;
  resolution: 'conflict' | 'created' | 'matched' | 'stale';
};
type MissingMediaScanRow = {
  channelId: bigint;
  messageId: string;
  observationId: string;
  position: number;
};
type CurrentRevisionScanRow = {
  channelId: bigint;
  currentRevisionNumber: number;
  entities: typeof messageRevisions.$inferSelect.entities | null;
  html: string | null;
  messageId: string;
  rendererVersion: number | null;
  revisionId: string | null;
  telegramMessageId: bigint;
  text: string | null;
};

export class PostgresReconciliationRepository implements ReconciliationScanner {
  constructor(private readonly database: Database) {}

  async scanDryRun(
    telegramChannelIds: readonly bigint[],
    now: Date,
    visit: ReconciliationCandidateVisitor,
  ): Promise<ReconciliationScanSnapshot> {
    const scope = uniqueTelegramIds(telegramChannelIds);
    if (scope.length === 0) {
      throw new ReconciliationScopeError('At least one Telegram channel ID is required');
    }
    if (scope.length > RECONCILIATION_SCAN_CHANNEL_LIMIT) {
      throw new ReconciliationScopeError(
        `A scan may include at most ${RECONCILIATION_SCAN_CHANNEL_LIMIT} channels`,
      );
    }

    return this.database.transaction(
      async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${RECONCILIATION_ADVISORY_LOCK})`,
        );
        return this.scanSnapshot(transaction, scope, now, visit);
      },
      { accessMode: 'read only', isolationLevel: 'repeatable read' },
    );
  }

  private async scanSnapshot(
    transaction: ReconciliationTransaction,
    scope: readonly bigint[],
    now: Date,
    visit: ReconciliationCandidateVisitor,
  ): Promise<ReconciliationScanSnapshot> {
    let scanned = 0;
    const configured = await transaction
      .select({
        disabledAt: telegramChannelAllowlist.disabledAt,
        enabled: telegramChannelAllowlist.enabled,
        telegramChatId: telegramChannelAllowlist.telegramChatId,
      })
      .from(telegramChannelAllowlist)
      .where(inArray(telegramChannelAllowlist.telegramChatId, scope))
      .orderBy(asc(telegramChannelAllowlist.telegramChatId));
    if (configured.length !== scope.length) {
      throw new ReconciliationScopeError('Every scan channel must exist in the allowlist');
    }
    scanned += configured.length;

    for (const channel of configured) {
      if (!channel.enabled) {
        await visit({
          channelId: channel.telegramChatId.toString(),
          evidenceIds: [channel.disabledAt?.toISOString() ?? 'unknown-disabled-window'],
          evidenceVersion: 1,
          kind: 'disabled_window',
          sanitizedReason: 'The channel is currently disabled and may have an unobserved window',
          severity: 'warning',
        });
      }
    }

    await forEachPage<TaskScanRow>(
      (cursor) =>
        transaction
          .select({
            blockedAt: telegramIngestTasks.blockedAt,
            id: telegramIngestTasks.id,
            skippedAt: telegramIngestTasks.skippedAt,
            telegramChatId: telegramIngestTasks.telegramChatId,
            telegramUpdateId: telegramIngestTasks.telegramUpdateId,
          })
          .from(telegramIngestTasks)
          .where(
            and(
              inArray(telegramIngestTasks.telegramChatId, scope),
              or(isNull(telegramIngestTasks.processedAt), isNotNull(telegramIngestTasks.skippedAt)),
              cursor
                ? or(
                    gt(telegramIngestTasks.telegramChatId, cursor.telegramChatId),
                    and(
                      eq(telegramIngestTasks.telegramChatId, cursor.telegramChatId),
                      gt(telegramIngestTasks.telegramUpdateId, cursor.telegramUpdateId),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(
            asc(telegramIngestTasks.telegramChatId),
            asc(telegramIngestTasks.telegramUpdateId),
          )
          .limit(RECONCILIATION_SCAN_BATCH_SIZE),
      async (task) => {
        scanned += 1;
        const common = {
          channelId: task.telegramChatId.toString(),
          evidenceIds: [task.id],
          evidenceVersion: 1,
          sanitizedReason: `Durable ingest task ${task.telegramUpdateId.toString()} requires attention`,
        };
        if (task.skippedAt) {
          await visit({ ...common, kind: 'operator_skipped', severity: 'warning' });
        } else if (task.blockedAt) {
          await visit({ ...common, kind: 'durable_blocked', severity: 'error' });
        } else {
          await visit({ ...common, kind: 'durable_pending', severity: 'warning' });
        }
      },
    );

    const [pollingState] = await transaction.select().from(telegramPollingState).limit(1);
    const [runtime] = await transaction.select().from(workerRuntime).limit(1);
    scanned += 1;
    if (!pollingState) {
      await visit({
        channelId: null,
        evidenceIds: ['telegram_polling_state:missing'],
        evidenceVersion: 1,
        kind: 'retention_risk',
        sanitizedReason: 'No durable Telegram polling state exists for the configured channels',
        severity: 'warning',
      });
    } else {
      const lastSuccessAt = runtime?.lastTelegramSuccessAt ?? pollingState.updatedAt;
      if (now.getTime() - lastSuccessAt.getTime() >= TELEGRAM_RETENTION_RISK_MS) {
        await visit({
          channelId: null,
          evidenceIds: [lastSuccessAt.toISOString()],
          evidenceVersion: 1,
          kind: 'retention_risk',
          sanitizedReason: 'No successful Bot checkpoint has been recorded for at least 24 hours',
          severity: 'warning',
        });
      }
    }

    await forEachPage<ReceiptScanRow>(
      (cursor) =>
        transaction
          .select({
            id: telegramPollReceipts.id,
            requestedOffset: telegramPollReceipts.requestedOffset,
            returnedFirstUpdateId: telegramPollReceipts.returnedFirstUpdateId,
          })
          .from(telegramPollReceipts)
          .where(cursor ? gt(telegramPollReceipts.id, cursor.id) : undefined)
          .orderBy(asc(telegramPollReceipts.id))
          .limit(RECONCILIATION_SCAN_BATCH_SIZE),
      async (receipt) => {
        scanned += 1;
        if (
          receipt.requestedOffset !== null &&
          receipt.returnedFirstUpdateId > receipt.requestedOffset
        ) {
          await visit({
            channelId: null,
            evidenceIds: [
              receipt.requestedOffset.toString(),
              receipt.returnedFirstUpdateId.toString(),
            ],
            evidenceVersion: 1,
            kind: 'transport_id_discontinuity',
            sanitizedReason: `Bot update IDs jump from ${receipt.requestedOffset.toString()} to ${receipt.returnedFirstUpdateId.toString()}`,
            severity: 'warning',
          });
        }
      },
    );

    let previousMessage: { channelId: bigint; telegramMessageId: bigint } | undefined;
    await forEachPage<ChannelMessageScanRow>(
      (cursor) =>
        transaction
          .select({
            channelId: telegramChannels.telegramChatId,
            telegramMessageId: messages.telegramMessageId,
          })
          .from(messages)
          .innerJoin(telegramChannels, eq(telegramChannels.id, messages.channelId))
          .where(
            and(
              inArray(telegramChannels.telegramChatId, scope),
              cursor
                ? or(
                    gt(telegramChannels.telegramChatId, cursor.channelId),
                    and(
                      eq(telegramChannels.telegramChatId, cursor.channelId),
                      gt(messages.telegramMessageId, cursor.telegramMessageId),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(telegramChannels.telegramChatId), asc(messages.telegramMessageId))
          .limit(RECONCILIATION_SCAN_BATCH_SIZE),
      async (message) => {
        scanned += 1;
        const previous = previousMessage;
        if (
          previous?.channelId === message.channelId &&
          message.telegramMessageId > previous.telegramMessageId + 1n
        ) {
          await visit({
            channelId: message.channelId.toString(),
            evidenceIds: [
              previous.telegramMessageId.toString(),
              message.telegramMessageId.toString(),
            ],
            evidenceVersion: 1,
            kind: 'message_id_candidate',
            sanitizedReason: `Channel message IDs jump from ${previous.telegramMessageId.toString()} to ${message.telegramMessageId.toString()}`,
            severity: 'warning',
          });
        }
        previousMessage = message;
      },
    );

    await forEachPage<ObservationScanRow>(
      (cursor) =>
        transaction
          .select({
            channelId: telegramChannels.telegramChatId,
            id: messageSourceObservations.id,
            messageId: messageSourceObservations.messageId,
            resolution: messageSourceObservations.resolution,
          })
          .from(messageSourceObservations)
          .innerJoin(telegramChannels, eq(telegramChannels.id, messageSourceObservations.channelId))
          .where(
            and(
              inArray(telegramChannels.telegramChatId, scope),
              inArray(messageSourceObservations.resolution, ['stale', 'conflict']),
              cursor ? gt(messageSourceObservations.id, cursor.id) : undefined,
            ),
          )
          .orderBy(asc(messageSourceObservations.id))
          .limit(RECONCILIATION_SCAN_BATCH_SIZE),
      async (observation) => {
        scanned += 1;
        await visit({
          channelId: observation.channelId.toString(),
          evidenceVersion: 1,
          kind: observation.resolution === 'stale' ? 'observation_stale' : 'observation_conflict',
          messageId: observation.messageId,
          observationId: observation.id,
          sanitizedReason:
            observation.resolution === 'stale'
              ? 'A source observation is older than the current revision'
              : 'A source observation conflicts with the current revision',
          severity: 'warning',
        });
      },
    );

    let lastMissingMediaObservationId: string | undefined;
    await forEachPage<MissingMediaScanRow>(
      (cursor) =>
        transaction
          .select({
            channelId: telegramChannels.telegramChatId,
            messageId: messageSourceObservations.messageId,
            observationId: messageSourceObservations.id,
            position: messageMedia.position,
          })
          .from(messageSourceObservations)
          .innerJoin(telegramChannels, eq(telegramChannels.id, messageSourceObservations.channelId))
          .innerJoin(
            messageMedia,
            eq(messageMedia.revisionId, messageSourceObservations.revisionId),
          )
          .leftJoin(
            messageSourceMediaObservations,
            and(
              eq(messageSourceMediaObservations.observationId, messageSourceObservations.id),
              eq(messageSourceMediaObservations.position, messageMedia.position),
            ),
          )
          .where(
            and(
              inArray(telegramChannels.telegramChatId, scope),
              isNull(messageSourceMediaObservations.id),
              cursor
                ? or(
                    gt(messageSourceObservations.id, cursor.observationId),
                    and(
                      eq(messageSourceObservations.id, cursor.observationId),
                      gt(messageMedia.position, cursor.position),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(messageSourceObservations.id), asc(messageMedia.position))
          .limit(RECONCILIATION_SCAN_BATCH_SIZE),
      async (media) => {
        scanned += 1;
        if (lastMissingMediaObservationId !== media.observationId) {
          await visit({
            channelId: media.channelId.toString(),
            evidenceVersion: 1,
            kind: 'media_evidence_missing',
            messageId: media.messageId,
            observationId: media.observationId,
            sanitizedReason:
              'A linked source observation is missing canonical-position media evidence',
            severity: 'warning',
          });
          lastMissingMediaObservationId = media.observationId;
        }
      },
    );

    await forEachPage<CurrentRevisionScanRow>(
      (cursor) =>
        transaction
          .select({
            channelId: telegramChannels.telegramChatId,
            currentRevisionNumber: messages.currentRevisionNumber,
            entities: messageRevisions.entities,
            html: messageRevisions.html,
            messageId: messages.id,
            rendererVersion: messageRevisions.rendererVersion,
            revisionId: messageRevisions.id,
            telegramMessageId: messages.telegramMessageId,
            text: messageRevisions.text,
          })
          .from(messages)
          .innerJoin(telegramChannels, eq(telegramChannels.id, messages.channelId))
          .leftJoin(
            messageRevisions,
            and(
              eq(messageRevisions.messageId, messages.id),
              eq(messageRevisions.revisionNumber, messages.currentRevisionNumber),
            ),
          )
          .where(
            and(
              inArray(telegramChannels.telegramChatId, scope),
              cursor
                ? or(
                    gt(telegramChannels.telegramChatId, cursor.channelId),
                    and(
                      eq(telegramChannels.telegramChatId, cursor.channelId),
                      gt(messages.telegramMessageId, cursor.telegramMessageId),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(telegramChannels.telegramChatId), asc(messages.telegramMessageId))
          .limit(RECONCILIATION_SCAN_BATCH_SIZE),
      async (current) => {
        scanned += 1;
        if (!current.revisionId) {
          await visit({
            channelId: current.channelId.toString(),
            evidenceIds: [`revision-number:${current.currentRevisionNumber}`],
            evidenceVersion: 1,
            kind: 'current_pointer_invalid',
            messageId: current.messageId,
            sanitizedReason:
              'The current revision pointer does not resolve to a revision of this message',
            severity: 'error',
          });
          return;
        }

        const expectedHtml =
          current.text === null
            ? null
            : renderTelegramMessage(current.text, current.entities ?? []);
        if (current.rendererVersion !== CURRENT_RENDERER_VERSION || current.html !== expectedHtml) {
          await visit({
            channelId: current.channelId.toString(),
            evidenceIds: [
              current.revisionId,
              `renderer:${current.rendererVersion ?? 'missing'}->${CURRENT_RENDERER_VERSION}`,
              `html:${hashEvidence(current.html)}`,
            ],
            evidenceVersion: 1,
            kind: 'derived_html_drift',
            messageId: current.messageId,
            sanitizedReason:
              'Current revision HTML or renderer version differs from deterministic output',
            severity: 'warning',
          });
        }
      },
    );

    return { scanned };
  }
}

async function forEachPage<T>(
  fetchPage: (cursor: T | undefined) => Promise<T[]>,
  visit: (row: T) => Promise<void> | void,
): Promise<void> {
  let cursor: T | undefined;
  while (true) {
    const rows = await fetchPage(cursor);
    for (const row of rows) {
      await visit(row);
    }
    if (rows.length < RECONCILIATION_SCAN_BATCH_SIZE) {
      return;
    }
    const last = rows.at(-1);
    if (!last) {
      return;
    }
    cursor = last;
  }
}

function uniqueTelegramIds(values: readonly bigint[]): bigint[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function hashEvidence(value: string | null): string {
  return createHash('sha256')
    .update(value ?? '<null>')
    .digest('hex');
}
