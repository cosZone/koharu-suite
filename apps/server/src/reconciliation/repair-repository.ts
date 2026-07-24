import { and, asc, eq, sql } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import type { Database } from '../db/client.js';
import {
  importRunObservations,
  importRuns,
  messageMedia,
  messageRevisions,
  messageSourceMediaObservations,
  messageSourceObservations,
  messages,
  reconciliationActions,
  reconciliationFindings,
  reconciliationRuns,
  telegramChannels,
} from '../db/schema.js';
import { normalizeTelegramDesktopMessage } from '../imports/telegram-desktop-normalize.js';
import type { DesktopMessageRecord } from '../imports/telegram-desktop-parser.js';
import {
  CURRENT_MESSAGE_FINGERPRINT_VERSION,
  fingerprintMessageSnapshot,
} from '../messages/fingerprint.js';
import { CURRENT_RENDERER_VERSION, renderTelegramMessage } from '../messages/renderer.js';
import { lockSourceEvidenceDiscovery } from '../messages/source-evidence-coordination.js';
import type { NormalizedMessageSnapshot, SourceNeutralMedia } from '../messages/types.js';
import { normalizeChannelUpdate } from '../telegram/normalize.js';
import type {
  DeterministicRepairActionKind,
  DeterministicRepairRepository,
  ReconciliationRepairInput,
  ReconciliationRepairResult,
} from './repair.js';
import {
  addReconciliationFinding,
  createReconciliationReport,
  finishReconciliationReport,
  type ReconciliationReport,
} from './report.js';
import { RECONCILIATION_ADVISORY_LOCK } from './repository.js';

const MAX_REPAIR_REVISIONS = 500;
const MAX_REPAIR_MEDIA = 100;

export type RepairTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Finding = typeof reconciliationFindings.$inferSelect;

export class PostgresDeterministicRepairRepository implements DeterministicRepairRepository {
  constructor(private readonly database: Database) {}

  apply(input: ReconciliationRepairInput): Promise<ReconciliationRepairResult> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${RECONCILIATION_ADVISORY_LOCK})`);
      await lockSourceEvidenceDiscovery(transaction);
      return this.applyInTransaction(transaction, input);
    });
  }

  async applyInTransaction(
    transaction: RepairTransaction,
    input: ReconciliationRepairInput,
    options: { runId?: string } = {},
  ): Promise<ReconciliationRepairResult> {
    await lockSourceEvidenceDiscovery(transaction);
    const [initialFinding] = await transaction
      .select()
      .from(reconciliationFindings)
      .where(eq(reconciliationFindings.id, input.findingId))
      .limit(1);
    if (!initialFinding) {
      throw new Error('Reconciliation finding was not found');
    }
    const actionKind = actionForFinding(initialFinding.kind);
    if (initialFinding.evidenceVersion !== input.expectedEvidenceVersion) {
      throw new Error('Reconciliation finding evidence version changed');
    }
    const message = await lockFindingMessage(transaction, initialFinding);
    const [finding] = await transaction
      .select()
      .from(reconciliationFindings)
      .where(eq(reconciliationFindings.id, input.findingId))
      .limit(1)
      .for('update');
    if (!finding || !sameFindingEvidence(initialFinding, finding)) {
      throw new Error('Reconciliation finding evidence changed while acquiring locks');
    }
    if (finding.evidenceVersion !== input.expectedEvidenceVersion) {
      throw new Error('Reconciliation finding evidence version changed');
    }
    if (finding.state === 'resolved') {
      return {
        actionKind,
        changed: false,
        findingId: finding.id,
        replayed: true,
        runId: null,
      };
    }
    if (finding.state !== 'open') {
      throw new Error('Ignored reconciliation findings cannot be repaired');
    }

    const startedAt = new Date();
    const outcome =
      finding.kind === 'derived_html_drift'
        ? await this.repairDerivedHtml(transaction, finding, message)
        : finding.kind === 'current_pointer_invalid'
          ? await this.repairCurrentPointer(transaction, finding, message)
          : finding.kind === 'import_lineage_missing'
            ? await this.restoreImportLineage(transaction, finding, message)
            : await this.restoreSourceMedia(transaction, finding, message);
    if (finding.telegramChatId === null) {
      throw new Error('Repair run requires a channel-scoped finding');
    }
    const completedAt = new Date();
    const report = createReconciliationReport({
      channelIds: [finding.telegramChatId.toString()],
      mode: 'apply',
      startedAt,
    });
    addReconciliationFinding(report, {
      channelId: finding.telegramChatId.toString(),
      evidenceVersion: finding.evidenceVersion,
      kind: finding.kind,
      ...(finding.messageId === null ? {} : { messageId: finding.messageId }),
      ...(finding.observationId === null ? {} : { observationId: finding.observationId }),
      sanitizedReason: outcome.changed
        ? 'Applied a deterministic repair to verified evidence'
        : 'Resolved the finding because verified evidence is already consistent',
      severity: finding.severity,
      stableKey: finding.stableKey,
      state: 'resolved',
    });
    finishReconciliationReport(report, {
      completedAt,
      repaired: outcome.changed ? 1 : 0,
    });
    let runId = options.runId;
    if (!runId) {
      const [run] = await transaction
        .insert(reconciliationRuns)
        .values({
          completedAt,
          initiatorId: input.initiatorId,
          initiatorKind: input.initiatorKind,
          mode: 'apply',
          report: reportJson(report),
          scope: report.scope.channelIds,
          startedAt,
          status: 'completed',
        })
        .returning({ id: reconciliationRuns.id });
      if (!run) {
        throw new Error('Failed to create reconciliation apply run');
      }
      runId = run.id;
    }
    await transaction.insert(reconciliationActions).values({
      actionKind: outcome.changed ? actionKind : 'resolve_already_consistent',
      afterState: outcome.afterState,
      beforeState: outcome.beforeState,
      findingId: finding.id,
      initiatorId: input.initiatorId,
      initiatorKind: input.initiatorKind,
      reason: input.reason,
      runId,
    });
    const [resolved] = await transaction
      .update(reconciliationFindings)
      .set({
        resolvedAt: sql`clock_timestamp()`,
        state: 'resolved',
      })
      .where(
        and(
          eq(reconciliationFindings.id, finding.id),
          eq(reconciliationFindings.evidenceVersion, input.expectedEvidenceVersion),
          eq(reconciliationFindings.state, 'open'),
        ),
      )
      .returning({ id: reconciliationFindings.id });
    if (!resolved) {
      throw new Error('Failed to resolve the repaired reconciliation finding');
    }
    return {
      actionKind,
      changed: outcome.changed,
      findingId: finding.id,
      replayed: false,
      runId,
    };
  }

  private async repairDerivedHtml(
    transaction: RepairTransaction,
    finding: Finding,
    message: typeof messages.$inferSelect,
  ) {
    const [revision] = await transaction
      .select()
      .from(messageRevisions)
      .where(
        and(
          eq(messageRevisions.messageId, message.id),
          eq(messageRevisions.revisionNumber, message.currentRevisionNumber),
        ),
      )
      .limit(1)
      .for('update');
    if (!revision) {
      throw new Error('Derived HTML repair requires a valid current revision');
    }
    const expectedHtml =
      revision.text === null ? null : renderTelegramMessage(revision.text, revision.entities);
    const changed =
      revision.rendererVersion !== CURRENT_RENDERER_VERSION || revision.html !== expectedHtml;
    if (changed) {
      await transaction
        .update(messageRevisions)
        .set({ html: expectedHtml, rendererVersion: CURRENT_RENDERER_VERSION })
        .where(eq(messageRevisions.id, revision.id));
    }
    return {
      afterState: {
        changed,
        rendererVersion: CURRENT_RENDERER_VERSION,
        revisionId: revision.id,
      },
      beforeState: {
        evidenceVersion: finding.evidenceVersion,
        rendererVersion: revision.rendererVersion,
        revisionId: revision.id,
      },
      changed,
    };
  }

  private async repairCurrentPointer(
    transaction: RepairTransaction,
    finding: Finding,
    message: typeof messages.$inferSelect,
  ) {
    const revisions = await transaction
      .select({ revisionNumber: messageRevisions.revisionNumber })
      .from(messageRevisions)
      .where(eq(messageRevisions.messageId, message.id))
      .orderBy(asc(messageRevisions.revisionNumber))
      .limit(MAX_REPAIR_REVISIONS + 1)
      .for('update');
    if (revisions.length > MAX_REPAIR_REVISIONS) {
      throw new Error('Current pointer repair exceeds the bounded revision limit');
    }
    if (
      revisions.length === 0 ||
      revisions.some((revision, index) => revision.revisionNumber !== index + 1)
    ) {
      throw new Error('Current pointer target cannot be uniquely proven');
    }
    if (revisions.some((revision) => revision.revisionNumber === message.currentRevisionNumber)) {
      return {
        afterState: {
          changed: false,
          currentRevisionNumber: message.currentRevisionNumber,
          messageId: message.id,
        },
        beforeState: {
          currentRevisionNumber: message.currentRevisionNumber,
          evidenceVersion: finding.evidenceVersion,
          messageId: message.id,
        },
        changed: false,
      };
    }
    const targetRevisionNumber = revisions.length;
    await transaction
      .update(messages)
      .set({ currentRevisionNumber: targetRevisionNumber, updatedAt: sql`clock_timestamp()` })
      .where(eq(messages.id, message.id));
    return {
      afterState: {
        changed: true,
        currentRevisionNumber: targetRevisionNumber,
        messageId: message.id,
      },
      beforeState: {
        currentRevisionNumber: message.currentRevisionNumber,
        evidenceVersion: finding.evidenceVersion,
        messageId: message.id,
      },
      changed: true,
    };
  }

  private async restoreSourceMedia(
    transaction: RepairTransaction,
    finding: Finding,
    message: typeof messages.$inferSelect,
  ) {
    if (!finding.observationId || !finding.messageId) {
      throw new Error('Source media repair requires an observation and message');
    }
    const [observation] = await transaction
      .select()
      .from(messageSourceObservations)
      .where(eq(messageSourceObservations.id, finding.observationId))
      .limit(1)
      .for('update');
    if (!observation || observation.messageId !== message.id) {
      throw new Error('Source media observation does not match the finding');
    }
    const [channel] = await transaction
      .select()
      .from(telegramChannels)
      .where(eq(telegramChannels.id, observation.channelId))
      .limit(1);
    if (!channel || channel.telegramChatId !== finding.telegramChatId) {
      throw new Error('Source media observation is outside the finding channel');
    }
    const snapshot = reconstructObservationSnapshot(observation, channel);
    if (
      observation.contentFingerprintVersion !== CURRENT_MESSAGE_FINGERPRINT_VERSION ||
      fingerprintMessageSnapshot(snapshot) !== observation.contentFingerprint
    ) {
      throw new Error('Immutable observation raw does not reproduce its fingerprint');
    }
    if (snapshot.media.length > MAX_REPAIR_MEDIA) {
      throw new Error('Source media repair exceeds the bounded media limit');
    }
    if (observation.revisionId === null) {
      throw new Error('Source media repair requires an observation linked to a revision');
    }
    const canonicalPositions = await transaction
      .select({ position: messageMedia.position })
      .from(messageMedia)
      .where(eq(messageMedia.revisionId, observation.revisionId))
      .orderBy(asc(messageMedia.position))
      .limit(MAX_REPAIR_MEDIA + 1);
    if (canonicalPositions.length > MAX_REPAIR_MEDIA) {
      throw new Error('Source media repair exceeds the bounded media limit');
    }
    if (
      canonicalPositions.length !== snapshot.media.length ||
      canonicalPositions.some((media, index) => media.position !== index)
    ) {
      throw new Error('Source media positions cannot be uniquely rebuilt from immutable raw');
    }
    const existing = await transaction
      .select({ position: messageSourceMediaObservations.position })
      .from(messageSourceMediaObservations)
      .where(eq(messageSourceMediaObservations.observationId, observation.id));
    const positions = new Set(existing.map((row) => row.position));
    const missing = snapshot.media
      .map((media, position) => ({ media, position }))
      .filter(({ position }) => !positions.has(position));
    if (missing.length > 0) {
      await transaction
        .insert(messageSourceMediaObservations)
        .values(
          missing.map(({ media, position }) =>
            sourceMediaEvidence(observation.id, observation.sourceKind, media, position),
          ),
        );
    }
    return {
      afterState: {
        changed: missing.length > 0,
        mediaEvidenceCount: existing.length + missing.length,
        observationId: observation.id,
      },
      beforeState: {
        evidenceVersion: finding.evidenceVersion,
        mediaEvidenceCount: existing.length,
        observationId: observation.id,
      },
      changed: missing.length > 0,
    };
  }

  private async restoreImportLineage(
    transaction: RepairTransaction,
    finding: Finding,
    message: typeof messages.$inferSelect,
  ) {
    if (!finding.observationId) {
      throw new Error('Import lineage repair requires a Desktop observation');
    }
    const [observation] = await transaction
      .select()
      .from(messageSourceObservations)
      .where(eq(messageSourceObservations.id, finding.observationId))
      .limit(1)
      .for('update');
    if (
      !observation ||
      observation.messageId !== message.id ||
      observation.sourceKind !== 'telegram_desktop_json' ||
      observation.importRunId === null
    ) {
      throw new Error('Import lineage cannot be uniquely rebuilt from the observation');
    }
    const [channel] = await transaction
      .select({ telegramChatId: telegramChannels.telegramChatId })
      .from(telegramChannels)
      .where(eq(telegramChannels.id, observation.channelId))
      .limit(1);
    if (!channel || channel.telegramChatId !== finding.telegramChatId) {
      throw new Error('Import lineage observation is outside the finding channel');
    }
    const [run] = await transaction
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, observation.importRunId))
      .limit(1)
      .for('update');
    if (
      run?.sourceKind !== 'telegram_desktop_json' ||
      run.status === 'running' ||
      !run.selectedChannels.includes(channel.telegramChatId.toString())
    ) {
      throw new Error('Import lineage cannot be uniquely rebuilt from a terminal Desktop run');
    }
    const [existing] = await transaction
      .select({ runId: importRunObservations.runId })
      .from(importRunObservations)
      .where(
        and(
          eq(importRunObservations.runId, run.id),
          eq(importRunObservations.observationId, observation.id),
        ),
      )
      .limit(1)
      .for('update');
    if (!existing) {
      await transaction.insert(importRunObservations).values({
        observationId: observation.id,
        replayed: false,
        resolutionAtRun: observation.resolution,
        runId: run.id,
        sourceKind: 'telegram_desktop_json',
      });
    }
    return {
      afterState: {
        changed: !existing,
        observationId: observation.id,
        runId: run.id,
      },
      beforeState: {
        evidenceVersion: finding.evidenceVersion,
        linked: Boolean(existing),
        observationId: observation.id,
        runId: run.id,
      },
      changed: !existing,
    };
  }
}

function actionForFinding(kind: Finding['kind']): DeterministicRepairActionKind {
  switch (kind) {
    case 'derived_html_drift':
      return 'derived_html.rerender';
    case 'current_pointer_invalid':
      return 'current_pointer.repair';
    case 'import_lineage_missing':
      return 'import_lineage.restore';
    case 'media_evidence_missing':
      return 'source_media.restore';
    default:
      throw new Error('This finding kind has no deterministic safe repair');
  }
}

function sameFindingEvidence(initial: Finding, locked: Finding): boolean {
  return (
    initial.id === locked.id &&
    initial.stableKey === locked.stableKey &&
    initial.kind === locked.kind &&
    initial.telegramChatId === locked.telegramChatId &&
    initial.messageId === locked.messageId &&
    initial.observationId === locked.observationId &&
    initial.evidenceVersion === locked.evidenceVersion
  );
}

async function lockFindingMessage(transaction: RepairTransaction, finding: Finding) {
  if (!finding.messageId || finding.telegramChatId === null) {
    throw new Error('Message repair requires a channel-scoped message finding');
  }
  const [message] = await transaction
    .select()
    .from(messages)
    .where(eq(messages.id, finding.messageId))
    .limit(1)
    .for('update');
  if (!message) {
    throw new Error('Finding message was not found');
  }
  const [channel] = await transaction
    .select({ telegramChatId: telegramChannels.telegramChatId })
    .from(telegramChannels)
    .where(eq(telegramChannels.id, message.channelId))
    .limit(1);
  if (!channel || channel.telegramChatId !== finding.telegramChatId) {
    throw new Error('Finding message is outside the finding channel');
  }
  return message;
}

function reconstructObservationSnapshot(
  observation: typeof messageSourceObservations.$inferSelect,
  channel: typeof telegramChannels.$inferSelect,
): NormalizedMessageSnapshot {
  if (observation.sourceKind === 'telegram_bot_update') {
    const snapshot = normalizeChannelUpdate(observation.rawJson as Update, channel.telegramChatId);
    if (!snapshot || snapshot.message.telegramMessageId !== observation.telegramMessageId) {
      throw new Error('Bot observation raw cannot uniquely reproduce the message');
    }
    return {
      channel: snapshot.channel,
      media: snapshot.media.map((media) => ({
        availabilityReason: null,
        duration: media.duration,
        fileName: media.fileName,
        fileSize: media.fileSize,
        height: media.height,
        kind: media.kind,
        mimeType: media.mimeType,
        sourceMediaType: media.kind,
        sourceMetadata: {},
        sourcePath: null,
        telegramFileId: media.fileId,
        telegramFileUniqueId: media.fileUniqueId,
        width: media.width,
      })),
      message: snapshot.message,
    };
  }
  const normalized = normalizeTelegramDesktopMessage(observation.rawJson as DesktopMessageRecord, {
    channel: {
      telegramChatId: channel.telegramChatId,
      title: channel.title,
      username: channel.username,
    },
    importRunId: observation.importRunId,
    sourceChatId: 1n,
  });
  if (
    normalized.kind !== 'eligible' ||
    normalized.snapshot.message.telegramMessageId !== observation.telegramMessageId
  ) {
    throw new Error('Desktop observation raw cannot uniquely reproduce the message');
  }
  return normalized.snapshot;
}

function sourceMediaEvidence(
  observationId: string,
  sourceKind: 'telegram_bot_update' | 'telegram_desktop_json',
  media: SourceNeutralMedia,
  position: number,
): typeof messageSourceMediaObservations.$inferInsert {
  const availability = media.availabilityReason === null ? 'available' : media.availabilityReason;
  if (
    availability !== 'available' &&
    availability !== 'exceeds_maximum_size' &&
    availability !== 'not_included' &&
    availability !== 'unavailable'
  ) {
    throw new Error('Observation media availability is unsupported');
  }
  return {
    availability,
    desktopSourcePath: sourceKind === 'telegram_desktop_json' ? media.sourcePath : null,
    mediaKind: media.kind,
    observationId,
    position,
    sourceKind,
    sourceMetadata: media.sourceMetadata,
    telegramFileId: sourceKind === 'telegram_bot_update' ? media.telegramFileId : null,
    telegramFileUniqueId: sourceKind === 'telegram_bot_update' ? media.telegramFileUniqueId : null,
  };
}

function reportJson(report: ReconciliationReport): Record<string, unknown> {
  return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
}
