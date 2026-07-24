import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImportTransaction } from '../src/imports/import-repository.js';
import {
  type DesktopMessageRecord,
  type DesktopMessageStreamItem,
  type streamTelegramDesktopSelectedMessages,
  TelegramDesktopInputError,
} from '../src/imports/telegram-desktop-parser.js';
import {
  RecoverableTelegramDesktopItemWriteError,
  TelegramDesktopImportService,
} from '../src/imports/telegram-desktop-service.js';
import type {
  NormalizedMessageSnapshot,
  SourceObservation,
  SourceWriteDecision,
  SourceWriteResult,
} from '../src/messages/types.js';

const temporaryDirectories: string[] = [];

async function inputFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'koharu-import-service-'));
  temporaryDirectories.push(directory);
  const input = join(directory, 'result.json');
  await writeFile(input, '{"fixture":true}');
  return input;
}

function snapshot(id: bigint): NormalizedMessageSnapshot {
  return {
    channel: {
      telegramChatId: -1_002_234_260_754n,
      title: 'Test channel',
      username: 'test_channel',
    },
    media: [],
    message: {
      authorSignature: null,
      contentKind: 'text',
      editedAt: null,
      entities: [],
      mediaGroupId: null,
      publishedAt: new Date('2026-07-24T00:00:00.000Z'),
      telegramMessageId: id,
      text: 'fixture',
    },
  };
}

function observation(id: bigint): Extract<SourceObservation, { kind: 'telegram_desktop_json' }> {
  return {
    importRunId: null,
    kind: 'telegram_desktop_json',
    observedAt: new Date('2026-07-24T00:00:00.000Z'),
    raw: { id: id.toString() },
    sourceChatId: 2_234_260_754n,
    sourceMetadata: {},
    sourceKey: `desktop:${id}`,
    sourceMessageId: id,
  };
}

class FakeRepository {
  acquired = 0;
  asserted = 0;
  createdRuns = 0;
  transactions = 0;
  updates: string[] = [];

  acquireApplyLock = async () => {
    this.acquired += 1;
  };

  assertApplyLock = async () => {
    this.asserted += 1;
  };

  configuredChannels = async () => [
    {
      enabled: true,
      telegramChatId: -1_002_234_260_754n,
      title: 'Test channel',
      username: 'test_channel',
    },
  ];

  createRun = async () => {
    this.createdRuns += 1;
    return '019b-import-run';
  };

  updateRun = async (_id: string, _report: unknown, status: string) => {
    this.updates.push(status);
  };

  transaction = async <T>(callback: (transaction: ImportTransaction) => Promise<T>): Promise<T> => {
    this.transactions += 1;
    const transaction = {
      transaction: async <Value>(savepoint: (value: ImportTransaction) => Promise<Value>) =>
        savepoint({} as ImportTransaction),
    } as unknown as ImportTransaction;
    return callback(transaction);
  };
}

function parser(records: DesktopMessageRecord[]) {
  return {
    discover: async () => [
      {
        id: 2_234_260_754n,
        index: null,
        name: 'Export name',
        source: 'root' as const,
        type: 'public_channel',
      },
    ],
    match: () => [
      {
        id: 2_234_260_754n,
        index: null,
        name: 'Export name',
        source: 'root' as const,
        telegramChatId: -1_002_234_260_754n,
        type: 'public_channel',
      },
    ],
    normalize: (record: DesktopMessageRecord) => {
      const result = record.result;
      if (result === 'service') {
        return { kind: 'skipped' as const, reason: 'service' as const };
      }
      if (result === 'error') {
        return {
          code: 'invalid_message',
          kind: 'item_error' as const,
          sanitizedReason: 'Message is invalid',
        };
      }
      const id = BigInt(String(record.id));
      return {
        kind: 'eligible' as const,
        observation: observation(id),
        snapshot: snapshot(id),
        sourceMetadata: { forwardedFrom: null, replyToMessageId: null },
        warnings: [],
      };
    },
    stream: async function* (
      _inputPath: string,
      descriptors: Parameters<typeof streamTelegramDesktopSelectedMessages>[1],
    ): AsyncGenerator<DesktopMessageStreamItem> {
      const descriptor = descriptors[0];
      if (!descriptor) {
        return;
      }
      for (const record of records) {
        if (record.result === 'stream_error') {
          yield {
            code: 'invalid_message_record',
            descriptor,
            kind: 'item_error',
            sanitizedReason: 'Telegram message record must be an object',
          };
        } else {
          yield { descriptor, kind: 'record', record };
        }
      }
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('Telegram Desktop import service', () => {
  it('keeps dry-run read-only while reporting the writer decision', async () => {
    const repository = new FakeRepository();
    const importWriter = {
      applied: 0,
      ingestSnapshotInTransaction: async () => {
        importWriter.applied += 1;
        throw new Error('dry-run must not apply');
      },
      previewSnapshot: async () => ({
        createdMessage: true,
        createdRevision: true,
        replayed: false,
        resolution: 'created' as const,
      }),
    };
    const service = new TelegramDesktopImportService(
      repository,
      importWriter,
      parser([{ id: '1' }, { id: '2', result: 'service' }]),
    );

    const report = await service.run({
      apply: false,
      channelIds: [-1_002_234_260_754n],
      inputPath: await inputFile(),
    });

    expect(report.counts).toMatchObject({
      createdMessages: 1,
      createdRevisions: 1,
      eligible: 1,
      scanned: 2,
      skippedService: 1,
    });
    expect(importWriter.applied).toBe(0);
    expect(repository).toMatchObject({ acquired: 0, createdRuns: 0, transactions: 0 });
  });

  it('reports a replayed source observation as matched', async () => {
    const repository = new FakeRepository();
    const service = new TelegramDesktopImportService(
      repository,
      {
        ingestSnapshotInTransaction: async () => {
          throw new Error('dry-run must not apply');
        },
        previewSnapshot: async () => ({
          createdMessage: false,
          createdRevision: false,
          replayed: true,
          resolution: 'created',
        }),
      },
      parser([{ id: '1' }]),
    );

    const report = await service.run({
      apply: false,
      channelIds: [-1_002_234_260_754n],
      inputPath: await inputFile(),
    });

    expect(report.counts.matchedExisting).toBe(1);
    expect(report.counts.createdMessages).toBe(0);
    expect(report.status).toBe('clean');
  });

  it('persists an apply run in bounded batches and reports item errors', async () => {
    const repository = new FakeRepository();
    const importWriter = {
      ingestSnapshotInTransaction: async (
        _transaction: ImportTransaction,
        candidate: NormalizedMessageSnapshot,
      ): Promise<SourceWriteResult> => ({
        channelId: '019b-channel',
        createdMessage: true,
        createdRevision: true,
        messageId: candidate.message.telegramMessageId.toString(),
        observationId: '019b-observation',
        replayed: false,
        resolution: 'created',
        revisionId: '019b-revision',
      }),
      previewSnapshot: async (): Promise<SourceWriteDecision> => {
        throw new Error('apply must not preview');
      },
    };
    const records: DesktopMessageRecord[] = Array.from({ length: 251 }, (_, index) => ({
      id: String(index + 1),
    }));
    records.push({ id: '252', result: 'error' });
    records.push({ result: 'stream_error' });
    const service = new TelegramDesktopImportService(repository, importWriter, parser(records));

    const report = await service.run({
      apply: true,
      channelIds: [-1_002_234_260_754n],
      inputPath: await inputFile(),
    });

    expect(report.status).toBe('partial');
    expect(report.counts).toMatchObject({
      createdMessages: 251,
      createdRevisions: 251,
      itemErrors: 2,
      scanned: 253,
    });
    expect(repository.transactions).toBe(2);
    expect(repository.asserted).toBe(6);
    expect(repository.updates.at(-1)).toBe('partial');
  });

  it('isolates only explicitly recoverable item write errors', async () => {
    const repository = new FakeRepository();
    let writes = 0;
    const service = new TelegramDesktopImportService(
      repository,
      {
        ingestSnapshotInTransaction: async (
          _transaction: ImportTransaction,
          candidate: NormalizedMessageSnapshot,
        ): Promise<SourceWriteResult> => {
          writes += 1;
          if (writes === 1) {
            throw new RecoverableTelegramDesktopItemWriteError('fixture item is recoverable');
          }
          return {
            channelId: '019b-channel',
            createdMessage: true,
            createdRevision: true,
            messageId: candidate.message.telegramMessageId.toString(),
            observationId: '019b-observation',
            replayed: false,
            resolution: 'created',
            revisionId: '019b-revision',
          };
        },
        previewSnapshot: async () => {
          throw new Error('apply must not preview');
        },
      },
      parser([{ id: '1' }, { id: '2' }]),
    );

    const report = await service.run({
      apply: true,
      channelIds: [-1_002_234_260_754n],
      inputPath: await inputFile(),
    });

    expect(report.status).toBe('partial');
    expect(report.counts).toMatchObject({
      createdMessages: 1,
      itemErrors: 1,
    });
    expect(repository.updates.at(-1)).toBe('partial');
  });

  it('treats unknown writer failures as an interrupted import', async () => {
    const repository = new FakeRepository();
    const service = new TelegramDesktopImportService(
      repository,
      {
        ingestSnapshotInTransaction: async () => {
          throw new Error('database schema is unavailable');
        },
        previewSnapshot: async () => {
          throw new Error('apply must not preview');
        },
      },
      parser([{ id: '1' }]),
    );

    await expect(
      service.run({
        apply: true,
        channelIds: [-1_002_234_260_754n],
        inputPath: await inputFile(),
      }),
    ).rejects.toMatchObject({ code: 'import_interrupted' });
    expect(repository.updates.at(-1)).toBe('interrupted');
  });

  it('cooperatively interrupts an existing run when cancellation arrives during the scan', async () => {
    const repository = new FakeRepository();
    const controller = new AbortController();
    const controlledParser = parser([{ id: '1' }, { id: '2' }]);
    const baseStream = controlledParser.stream;
    controlledParser.stream = async function* (inputPath, descriptors) {
      let yielded = 0;
      for await (const item of baseStream(inputPath, descriptors)) {
        if (yielded > 0) {
          controller.abort();
        }
        yielded += 1;
        yield item;
      }
    };
    const service = new TelegramDesktopImportService(
      repository,
      {
        ingestSnapshotInTransaction: async () => {
          throw new Error('cancelled candidates must not be written');
        },
        previewSnapshot: async () => {
          throw new Error('apply must not preview');
        },
      },
      controlledParser,
    );

    await expect(
      service.run({
        apply: true,
        channelIds: [-1_002_234_260_754n],
        inputPath: await inputFile(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'import_interrupted' });
    expect(repository.transactions).toBe(0);
    expect(repository.updates.at(-1)).toBe('interrupted');
  });

  it('finishes fatal prevalidation before creating an apply run', async () => {
    const repository = new FakeRepository();
    const failingParser = parser([]);
    failingParser.discover = async () => {
      throw new TelegramDesktopInputError('invalid_json', 'Input is invalid JSON');
    };
    const service = new TelegramDesktopImportService(
      repository,
      {
        ingestSnapshotInTransaction: async () => {
          throw new Error('must not write');
        },
        previewSnapshot: async () => {
          throw new Error('must not preview');
        },
      },
      failingParser,
    );

    await expect(
      service.run({
        apply: true,
        channelIds: [-1_002_234_260_754n],
        inputPath: await inputFile(),
      }),
    ).rejects.toThrow('Input is invalid JSON');
    expect(repository).toMatchObject({ acquired: 0, createdRuns: 0, transactions: 0 });
  });
});
