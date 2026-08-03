import {
  addArchiveReportIssue,
  createArchiveReport,
  finishArchiveReport,
} from '@koharu-suite/archive-format';
import { describe, expect, it, vi } from 'vitest';
import {
  type ArchiveCliDependencies,
  type ArchiveCliInput,
  runArchiveCli,
} from '../src/archive/cli.js';
import {
  ArchiveExportError,
  createCleanArchiveExportReport,
  createFatalArchiveExportReport,
} from '../src/archive/export-report.js';

const BASE_INPUT: ArchiveCliInput = {
  includeProvenance: false,
  json: false,
  overwrite: false,
  subcommand: 'export',
};

function emptyCounts() {
  return {
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
}

function cleanExportReport() {
  return createCleanArchiveExportReport({
    artifactByteLength: '42',
    artifactSha256: 'a'.repeat(64),
    counts: emptyCounts(),
    includeProvenance: false,
    selection: { mode: 'all' },
    snapshotAt: '2026-01-01T00:00:00.000Z',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}

function dependencies() {
  return {
    exportArchive: vi.fn(async () => cleanExportReport()),
    inspectArchive: vi.fn(async () =>
      finishArchiveReport(createArchiveReport({ mode: 'inspect' })),
    ),
    write: vi.fn<(output: string) => void>(),
  } satisfies ArchiveCliDependencies;
}

describe('archive CLI', () => {
  it('sorts a unique scoped export before invoking its only dependency', async () => {
    const deps = dependencies();
    const signal = new AbortController().signal;
    const exitCode = await runArchiveCli(
      {
        ...BASE_INPUT,
        channels: ['-1009876543210', '-1001234567890'],
        includeProvenance: true,
        outputPath: '/safe/archive.tar.zst',
        overwrite: true,
        signal,
      },
      deps,
    );

    expect(exitCode).toBe(0);
    expect(deps.exportArchive).toHaveBeenCalledWith({
      includeProvenance: true,
      outputPath: '/safe/archive.tar.zst',
      overwrite: true,
      selection: {
        mode: 'channels',
        telegramChatIds: ['-1009876543210', '-1001234567890'],
      },
      signal,
    });
    expect(deps.inspectArchive).not.toHaveBeenCalled();
    expect(deps.write).toHaveBeenCalledWith(
      expect.stringContaining('Portable archive EXPORT: CLEAN\n'),
    );
  });

  it('runs inspect without touching the export dependency and writes one JSON object', async () => {
    const deps = dependencies();
    const report = createArchiveReport({
      artifactByteLength: '42',
      artifactSha256: 'a'.repeat(64),
      mode: 'inspect',
    });
    addArchiveReportIssue(report, {
      code: 'test_issue',
      sanitizedReason: 'test_issue',
      severity: 'error',
    });
    deps.inspectArchive.mockResolvedValue(finishArchiveReport(report));
    const exitCode = await runArchiveCli(
      {
        ...BASE_INPUT,
        inputPath: '/safe/archive.tar.zst',
        json: true,
        subcommand: 'inspect',
      },
      deps,
    );

    expect(exitCode).toBe(2);
    expect(deps.inspectArchive).toHaveBeenCalledWith({ inputPath: '/safe/archive.tar.zst' });
    expect(deps.exportArchive).not.toHaveBeenCalled();
    const output = deps.write.mock.calls[0]?.[0] as string;
    expect(output.endsWith('\n')).toBe(true);
    expect(output.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(output)).toMatchObject({
      artifactByteLength: '42',
      status: 'partial',
    });
  });

  it.each([
    [{ ...BASE_INPUT }, 'archive export requires --output'],
    [
      { ...BASE_INPUT, inputPath: '/input.tar.zst', outputPath: '/output.tar.zst' },
      'archive export does not accept --input',
    ],
    [
      {
        ...BASE_INPUT,
        inputPath: '/input.tar.zst',
        outputPath: '/output.tar.zst',
        subcommand: 'inspect',
      },
      'archive inspect does not accept --output',
    ],
    [
      {
        ...BASE_INPUT,
        channels: ['-1001234567890'],
        inputPath: '/input.tar.zst',
        subcommand: 'inspect',
      },
      'archive inspect does not accept --channel',
    ],
    [
      {
        ...BASE_INPUT,
        includeProvenance: true,
        inputPath: '/input.tar.zst',
        subcommand: 'inspect',
      },
      'archive inspect does not accept --include-provenance',
    ],
    [
      { ...BASE_INPUT, inputPath: '/input.tar.zst', overwrite: true, subcommand: 'inspect' },
      'archive inspect does not accept --overwrite',
    ],
    [{ ...BASE_INPUT, subcommand: 'restore' }, 'archive command must be export or inspect'],
    [
      { ...BASE_INPUT, channels: ['not-a-channel'], outputPath: '/output.tar.zst' },
      'archive export received an invalid --channel',
    ],
    [
      {
        ...BASE_INPUT,
        channels: ['-1001234567890', '-1001234567890'],
        outputPath: '/output.tar.zst',
      },
      'archive export does not accept duplicate --channel',
    ],
  ] satisfies Array<[ArchiveCliInput, string]>)(
    'rejects an invalid parameter combination',
    async (input, message) => {
      const deps = dependencies();
      const exitCode = await runArchiveCli({ ...input, json: true }, deps);

      expect(exitCode).toBe(1);
      expect(deps.exportArchive).not.toHaveBeenCalled();
      expect(deps.inspectArchive).not.toHaveBeenCalled();
      expect(JSON.parse(deps.write.mock.calls[0]?.[0] as string)).toEqual({
        error: { code: 'invalid_arguments', message },
        operation:
          input.subcommand === 'export' || input.subcommand === 'inspect'
            ? input.subcommand
            : 'archive',
        schemaVersion: 1,
        status: 'fatal',
      });
    },
  );

  it('uses all-channel selection when --channel is absent', async () => {
    const deps = dependencies();
    await runArchiveCli({ ...BASE_INPUT, outputPath: '/safe/archive.tar.zst' }, deps);
    expect(deps.exportArchive).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { mode: 'all' } }),
    );
  });

  it('does not expose a dependency error or host path in JSON output', async () => {
    const deps = dependencies();
    deps.inspectArchive.mockRejectedValue(new Error('ENOENT /Users/owner/private.tar.zst'));
    const exitCode = await runArchiveCli(
      {
        ...BASE_INPUT,
        inputPath: '/Users/owner/private.tar.zst',
        json: true,
        subcommand: 'inspect',
      },
      deps,
    );

    expect(exitCode).toBe(1);
    const output = deps.write.mock.calls[0]?.[0] as string;
    expect(output).not.toContain('/Users/owner/private.tar.zst');
    expect(JSON.parse(output)).toMatchObject({
      error: { code: 'archive_command_failed' },
      operation: 'inspect',
      status: 'fatal',
    });
  });

  it('emits the safe export report carried by ArchiveExportError', async () => {
    const deps = dependencies();
    const report = createFatalArchiveExportReport({
      code: 'output_exists',
      includeProvenance: false,
      selection: { mode: 'all' },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    deps.exportArchive.mockRejectedValue(new ArchiveExportError('output_exists', report));

    const exitCode = await runArchiveCli(
      { ...BASE_INPUT, json: true, outputPath: '/safe/archive.tar.zst' },
      deps,
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(deps.write.mock.calls[0]?.[0] as string)).toEqual(report);
  });
});
