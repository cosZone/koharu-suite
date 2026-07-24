import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import type {
  NormalizedMessageSnapshot,
  SourceObservation,
  SourceWriteDecision,
  SourceWriteResult,
} from '../messages/types.js';
import {
  type TelegramDesktopCompleteRange,
  validateTelegramDesktopCompleteRanges,
} from './coverage.js';
import type {
  ImportConfiguredChannel,
  ImportRunObservationLink,
  ImportTransaction,
} from './import-repository.js';
import {
  addTelegramDesktopImportIssue,
  createTelegramDesktopImportReport,
  finishTelegramDesktopImportReport,
  sampleTelegramDesktopImportIssue,
  type TelegramDesktopImportReport,
} from './report.js';
import { normalizeTelegramDesktopMessage } from './telegram-desktop-normalize.js';
import {
  type DesktopMatchedChat,
  type DesktopMessageRecord,
  discoverTelegramDesktopChats,
  matchTelegramDesktopChats,
  streamTelegramDesktopSelectedMessages,
  TelegramDesktopInputError,
} from './telegram-desktop-parser.js';

const IMPORT_BATCH_SIZE = 250;

interface ImportCandidate {
  observation: Extract<SourceObservation, { kind: 'telegram_desktop_json' }>;
  snapshot: NormalizedMessageSnapshot;
}

export class RecoverableTelegramDesktopItemWriteError extends Error {}

interface TelegramDesktopParser {
  discover: typeof discoverTelegramDesktopChats;
  match: typeof matchTelegramDesktopChats;
  normalize: typeof normalizeTelegramDesktopMessage;
  stream: typeof streamTelegramDesktopSelectedMessages;
}

interface TelegramDesktopWriter {
  ingestSnapshotInTransaction(
    transaction: ImportTransaction,
    snapshot: NormalizedMessageSnapshot,
    observation: SourceObservation,
  ): Promise<SourceWriteResult>;
  previewSnapshot(
    snapshot: NormalizedMessageSnapshot,
    observation: SourceObservation,
  ): Promise<SourceWriteDecision>;
}

interface TelegramDesktopImportRepository {
  acquireApplyLock(): Promise<void>;
  assertApplyLock(): Promise<void>;
  configuredChannels(channelIds: bigint[]): Promise<ImportConfiguredChannel[]>;
  createRun(report: TelegramDesktopImportReport): Promise<string>;
  linkRunObservation(transaction: ImportTransaction, link: ImportRunObservationLink): Promise<void>;
  persistRunCoverages(
    runId: string,
    ranges: readonly TelegramDesktopCompleteRange[],
  ): Promise<void>;
  transaction<T>(callback: (transaction: ImportTransaction) => Promise<T>): Promise<T>;
  updateRun(
    id: string,
    report: TelegramDesktopImportReport,
    status: 'completed' | 'interrupted' | 'partial' | 'running',
  ): Promise<void>;
}

const defaultParser: TelegramDesktopParser = {
  discover: discoverTelegramDesktopChats,
  match: matchTelegramDesktopChats,
  normalize: normalizeTelegramDesktopMessage,
  stream: streamTelegramDesktopSelectedMessages,
};

async function sha256RegularFile(inputPath: string): Promise<string> {
  try {
    const file = await lstat(inputPath);
    if (!file.isFile()) {
      throw new Error('not a regular file');
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(inputPath)) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  } catch {
    throw new TelegramDesktopInputError(
      'input_unreadable',
      'Input must be a readable regular JSON file',
    );
  }
}

function configuredChannelMap(
  channels: ImportConfiguredChannel[],
): Map<bigint, ImportConfiguredChannel> {
  return new Map(channels.map((channel) => [channel.telegramChatId, channel]));
}

function sourceMessageId(record: DesktopMessageRecord): string | undefined {
  const id = record.id;
  if (typeof id === 'string' && /^[0-9]+$/u.test(id)) {
    return id;
  }
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id.toString() : undefined;
}

function recordDecision(
  report: TelegramDesktopImportReport,
  candidate: ImportCandidate,
  decision: SourceWriteDecision,
): void {
  if (decision.createdMessage) {
    report.counts.createdMessages += 1;
  }
  if (decision.createdRevision) {
    report.counts.createdRevisions += 1;
  }
  if (decision.replayed || decision.resolution === 'matched') {
    report.counts.matchedExisting += 1;
  }
  if (decision.resolution === 'stale') {
    report.counts.stale += 1;
  }
  if (decision.resolution === 'conflict') {
    report.counts.conflicts += 1;
    sampleTelegramDesktopImportIssue(report, {
      code: 'snapshot_conflict',
      sanitizedReason: 'Snapshot time is ambiguous; current content was preserved',
      severity: 'error',
      sourceChatId: candidate.observation.sourceChatId.toString(),
      sourceMessageId: candidate.observation.sourceMessageId.toString(),
    });
  }
}

export interface TelegramDesktopImportOptions {
  apply: boolean;
  channelIds: bigint[];
  completeRanges?: TelegramDesktopCompleteRange[];
  inputPath: string;
  signal?: AbortSignal;
}

function assertImportNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new TelegramDesktopInputError(
      'import_interrupted',
      'Telegram Desktop import was interrupted',
    );
  }
}

export class TelegramDesktopImportService {
  constructor(
    private readonly repository: TelegramDesktopImportRepository,
    private readonly writer: TelegramDesktopWriter,
    private readonly parser: TelegramDesktopParser = defaultParser,
  ) {}

  async run(options: TelegramDesktopImportOptions): Promise<TelegramDesktopImportReport> {
    const completeRanges = validateTelegramDesktopCompleteRanges(
      options.completeRanges ?? [],
      options.channelIds,
      options.apply,
    );
    assertImportNotAborted(options.signal);
    const initialFileSha256 = await sha256RegularFile(options.inputPath);
    assertImportNotAborted(options.signal);
    const descriptors = await this.parser.discover(options.inputPath);
    assertImportNotAborted(options.signal);
    const fileSha256 = await sha256RegularFile(options.inputPath);
    assertImportNotAborted(options.signal);
    if (fileSha256 !== initialFileSha256) {
      throw new TelegramDesktopInputError(
        'input_changed',
        'Input JSON file changed during prevalidation',
      );
    }
    const matchedChats = this.parser.match(descriptors, options.channelIds);
    const channels = await this.repository.configuredChannels(options.channelIds);
    const channelsById = configuredChannelMap(channels);
    if (
      channels.length !== options.channelIds.length ||
      options.channelIds.some((id) => !channelsById.has(id))
    ) {
      throw new TelegramDesktopInputError(
        'channel_not_configured',
        'Every selected channel must already exist in the database allowlist',
      );
    }

    const report = createTelegramDesktopImportReport({
      fileSha256,
      mode: options.apply ? 'apply' : 'dry-run',
      selectedChats: matchedChats.map((chat) => ({
        canonicalChannelId: chat.telegramChatId.toString(),
        name: channelsById.get(chat.telegramChatId)?.title ?? chat.name,
        source: chat.source,
        sourceChatId: chat.id.toString(),
      })),
    });
    let runId: string | undefined;

    try {
      if (options.apply) {
        await this.repository.acquireApplyLock();
        await this.repository.assertApplyLock();
        assertImportNotAborted(options.signal);
        runId = await this.repository.createRun(report);
        report.runId = runId;
        assertImportNotAborted(options.signal);
        await this.repository.updateRun(runId, report, 'running');
      }

      await this.processChats(
        options.inputPath,
        matchedChats,
        channelsById,
        report,
        options.signal,
      );
      assertImportNotAborted(options.signal);
      if ((await sha256RegularFile(options.inputPath)) !== fileSha256) {
        throw new TelegramDesktopInputError(
          'input_changed',
          'Input JSON file changed during import',
        );
      }

      assertImportNotAborted(options.signal);
      finishTelegramDesktopImportReport(report);
      if (runId) {
        await this.repository.assertApplyLock();
        assertImportNotAborted(options.signal);
        if (report.status === 'clean') {
          await this.repository.persistRunCoverages(runId, completeRanges);
        }
        await this.repository.updateRun(
          runId,
          report,
          report.status === 'partial' ? 'partial' : 'completed',
        );
      }
      return report;
    } catch (error) {
      if (runId) {
        report.status = 'fatal';
        finishTelegramDesktopImportReport(report);
        await this.repository.updateRun(runId, report, 'interrupted').catch(() => undefined);
      }
      if (error instanceof TelegramDesktopInputError) {
        throw error;
      }
      throw new TelegramDesktopInputError(
        'import_interrupted',
        'Telegram Desktop import was interrupted',
      );
    }
  }

  private async processChats(
    inputPath: string,
    matchedChats: DesktopMatchedChat[],
    channelsById: Map<bigint, ImportConfiguredChannel>,
    report: TelegramDesktopImportReport,
    signal?: AbortSignal,
  ): Promise<void> {
    const pending: ImportCandidate[] = [];
    const matchedByDescriptor = new Map(
      matchedChats.map((chat) => [`${chat.source}:${chat.index ?? 'root'}`, chat]),
    );
    for await (const item of this.parser.stream(inputPath, matchedChats)) {
      assertImportNotAborted(signal);
      report.counts.scanned += 1;
      const matchedChat = matchedByDescriptor.get(
        `${item.descriptor.source}:${item.descriptor.index ?? 'root'}`,
      );
      if (!matchedChat) {
        throw new Error('Selected message has no matched chat descriptor');
      }
      const channel = channelsById.get(matchedChat.telegramChatId);
      if (!channel) {
        throw new Error('Selected allowlist channel disappeared during import');
      }
      if (item.kind === 'item_error') {
        addTelegramDesktopImportIssue(report, {
          code: item.code,
          sanitizedReason: item.sanitizedReason,
          severity: 'error',
          sourceChatId: matchedChat.id.toString(),
        });
        continue;
      }
      const record = item.record;
      const normalized = this.parser.normalize(record, {
        channel: {
          telegramChatId: channel.telegramChatId,
          title: channel.title,
          username: channel.username,
        },
        importRunId: report.runId ?? null,
        sourceChatId: matchedChat.id,
      });

      if (normalized.kind === 'skipped') {
        if (normalized.reason === 'service') {
          report.counts.skippedService += 1;
        } else {
          report.counts.skippedUnsupported += 1;
        }
        continue;
      }
      if (normalized.kind === 'item_error') {
        const messageId = sourceMessageId(record);
        addTelegramDesktopImportIssue(report, {
          code: normalized.code,
          sanitizedReason: normalized.sanitizedReason,
          severity: 'error',
          sourceChatId: matchedChat.id.toString(),
          ...(messageId ? { sourceMessageId: messageId } : {}),
        });
        continue;
      }

      report.counts.eligible += 1;
      report.counts.mediaMetadata += normalized.snapshot.media.length;
      for (const warning of normalized.warnings) {
        addTelegramDesktopImportIssue(report, {
          code: 'normalization_warning',
          sanitizedReason: warning,
          severity: 'warning',
          sourceChatId: normalized.observation.sourceChatId.toString(),
          sourceMessageId: normalized.observation.sourceMessageId.toString(),
        });
      }

      const candidate = {
        observation: normalized.observation,
        snapshot: normalized.snapshot,
      };
      if (report.mode === 'dry-run') {
        const decision = await this.writer.previewSnapshot(
          candidate.snapshot,
          candidate.observation,
        );
        recordDecision(report, candidate, decision);
      } else {
        pending.push(candidate);
        if (pending.length >= IMPORT_BATCH_SIZE) {
          await this.flushBatch(pending.splice(0), report, signal);
        }
      }
    }

    assertImportNotAborted(signal);
    if (pending.length > 0) {
      await this.flushBatch(pending, report, signal);
    }
  }

  private async flushBatch(
    candidates: ImportCandidate[],
    report: TelegramDesktopImportReport,
    signal?: AbortSignal,
  ): Promise<void> {
    assertImportNotAborted(signal);
    await this.repository.assertApplyLock();
    assertImportNotAborted(signal);
    const outcomes = await this.repository.transaction(async (transaction) => {
      const committed: Array<
        | { candidate: ImportCandidate; decision: SourceWriteDecision; kind: 'written' }
        | { candidate: ImportCandidate; kind: 'item_error' }
      > = [];
      for (const candidate of candidates) {
        assertImportNotAborted(signal);
        try {
          const result = await transaction.transaction(async (savepoint) => {
            const written = await this.writer.ingestSnapshotInTransaction(
              savepoint,
              candidate.snapshot,
              candidate.observation,
            );
            if (!report.runId) {
              throw new Error('Telegram Desktop apply run ID is unavailable');
            }
            await this.repository.linkRunObservation(savepoint, {
              observationId: written.observationId,
              replayed: written.replayed,
              resolutionAtRun: written.resolution,
              runId: report.runId,
            });
            return written;
          });
          committed.push({ candidate, decision: result, kind: 'written' });
        } catch (error) {
          if (!(error instanceof RecoverableTelegramDesktopItemWriteError)) {
            throw error;
          }
          committed.push({ candidate, kind: 'item_error' });
        }
      }
      assertImportNotAborted(signal);
      return committed;
    });
    for (const outcome of outcomes) {
      if (outcome.kind === 'written') {
        recordDecision(report, outcome.candidate, outcome.decision);
      } else {
        addTelegramDesktopImportIssue(report, {
          code: 'item_write_failed',
          sanitizedReason: 'Selected message could not be written',
          severity: 'error',
          sourceChatId: outcome.candidate.observation.sourceChatId.toString(),
          sourceMessageId: outcome.candidate.observation.sourceMessageId.toString(),
        });
      }
    }
    await this.repository.assertApplyLock();
    assertImportNotAborted(signal);
    if (report.runId) {
      await this.repository.updateRun(report.runId, report, 'running');
    }
  }
}
