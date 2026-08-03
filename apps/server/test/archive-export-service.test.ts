import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchiveManifest, ArchiveRecord } from '@koharu-suite/archive-format';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveExportError } from '../src/archive/export-report.js';
import { ArchiveExportRepositoryError } from '../src/archive/export-repository.js';
import {
  type ArchiveExportRepositoryPort,
  ArchiveExportService,
} from '../src/archive/export-service.js';
import { inspectArchiveArtifact } from '../src/archive/inspect-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function counts(): ArchiveManifest['counts'] {
  return {
    blobs: 0,
    channels: 1,
    hiddenMessages: 0,
    messages: 1,
    provenanceMedia: 0,
    provenanceObservations: 0,
    revisionMedia: 0,
    revisions: 1,
    visibleMessages: 1,
  };
}

function repository(): ArchiveExportRepositoryPort & {
  assertActive: ReturnType<typeof vi.fn>;
  completeRun: ReturnType<typeof vi.fn>;
  failRun: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn(async () => undefined);
  const assertActive = vi.fn(async () => undefined);
  const completeRun = vi.fn(async () => undefined);
  const failRun = vi.fn(async () => undefined);
  const records: Array<[ArchiveManifest['files'][number]['family'], ArchiveRecord]> = [
    [
      'channels',
      {
        recordType: 'channel',
        telegramChatId: '-1001',
        title: 'Channel',
        username: null,
      },
    ],
    [
      'messages',
      {
        currentRevisionNumber: 1,
        publishedAt: '2026-08-03T00:00:00.000Z',
        recordType: 'message',
        telegramChatId: '-1001',
        telegramMessageId: '1',
        visibility: { changedAt: null, state: 'public' },
      },
    ],
    [
      'revisions',
      {
        authorSignature: null,
        contentKind: 'text',
        editedAt: null,
        entities: [],
        mediaGroupId: null,
        recordType: 'revision',
        revisionNumber: 1,
        telegramChatId: '-1001',
        telegramMessageId: '1',
        text: 'hello',
      },
    ],
  ];
  return {
    acquireExportLease: async () => ({ assertActive, release }),
    assertActive,
    completeRun,
    createRun: async () => '00000000-0000-4000-8000-000000000001',
    failRun,
    readSnapshot: async (_options, visitor) => {
      for (const [family, record] of records) await visitor(family, record);
      return {
        counts: counts(),
        createdAt: '2026-08-03T00:00:01.000Z',
        selection: { mode: 'all' },
        snapshotAt: '2026-08-03T00:00:00.000Z',
      };
    },
    release,
  };
}

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'koharu-archive-export-'));
  roots.push(root);
  return root;
}

describe('ArchiveExportService', () => {
  it('writes, validates, atomically publishes, and records a clean metadata archive', async () => {
    const root = await privateRoot();
    const outputPath = join(root, 'archive.tar.zst');
    const repo = repository();
    const report = await new ArchiveExportService(repo).run({
      includeProvenance: false,
      outputPath,
      overwrite: false,
      selection: { mode: 'all' },
    });

    expect(report).toMatchObject({
      artifactPublished: true,
      counts: counts(),
      status: 'clean',
    });
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect((await inspectArchiveArtifact({ inputPath: outputPath })).status).toBe('clean');
    expect(repo.completeRun).toHaveBeenCalledOnce();
    expect(repo.assertActive).toHaveBeenCalledTimes(4);
    expect(repo.failRun).not.toHaveBeenCalled();
    expect(repo.release).toHaveBeenCalledOnce();
  });

  it('refuses an existing destination and preserves its bytes', async () => {
    const root = await privateRoot();
    const outputPath = join(root, 'archive.tar.zst');
    await writeFile(outputPath, 'sentinel', { mode: 0o600 });
    const repo = repository();

    const error = await new ArchiveExportService(repo)
      .run({
        includeProvenance: false,
        outputPath,
        overwrite: false,
        selection: { mode: 'all' },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArchiveExportError);
    expect((error as ArchiveExportError).code).toBe('output_exists');
    expect((error as ArchiveExportError).report.artifactPublished).toBe(false);
    expect(await readFile(outputPath, 'utf8')).toBe('sentinel');
    expect(repo.failRun).toHaveBeenCalledOnce();
    expect(repo.release).toHaveBeenCalledOnce();
  });

  it('fails instead of completing when the export lease is lost before run completion', async () => {
    const root = await privateRoot();
    const outputPath = join(root, 'archive.tar.zst');
    const repo = repository();
    repo.assertActive
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ArchiveExportRepositoryError('archive_export_lock_lost'));

    const error = await new ArchiveExportService(repo)
      .run({
        includeProvenance: false,
        outputPath,
        overwrite: false,
        selection: { mode: 'all' },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ArchiveExportError);
    expect((error as ArchiveExportError).code).toBe('archive_export_lock_lost');
    expect((error as ArchiveExportError).report.artifactPublished).toBe(true);
    expect(repo.completeRun).not.toHaveBeenCalled();
    expect(repo.failRun).toHaveBeenCalledOnce();
    expect(repo.release).toHaveBeenCalledOnce();
  });

  it('does not return clean when only the terminal lease release detects lock loss', async () => {
    const root = await privateRoot();
    const outputPath = join(root, 'archive.tar.zst');
    const repo = repository();
    repo.release.mockRejectedValueOnce(
      new ArchiveExportRepositoryError('archive_export_lock_lost'),
    );

    const error = await new ArchiveExportService(repo)
      .run({
        includeProvenance: false,
        outputPath,
        overwrite: false,
        selection: { mode: 'all' },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ArchiveExportError);
    expect((error as ArchiveExportError).code).toBe('archive_export_lock_lost');
    expect((error as ArchiveExportError).report.artifactPublished).toBe(true);
    expect(repo.assertActive).toHaveBeenCalledTimes(4);
    expect(repo.completeRun).not.toHaveBeenCalled();
    expect(repo.failRun).toHaveBeenCalledOnce();
    expect(repo.release).toHaveBeenCalledTimes(2);
  });
});
