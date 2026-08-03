import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  ARCHIVE_FORMAT_NAME,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveManifest,
  type ArchiveWriteEntry,
  archiveManifestSchema,
  canonicalJsonBytes,
  renderChecksumFile,
  sha256Hex,
  writeTarZstd,
} from '@koharu-suite/archive-format';
import { VERSION } from '../version.js';
import { prepareArchiveArtifact } from './artifact-file.js';
import {
  ArchiveExportError,
  type ArchiveExportReport,
  createCleanArchiveExportReport,
  createFatalArchiveExportReport,
} from './export-report.js';
import {
  type ArchiveExportRecordVisitor,
  ArchiveExportRepositoryError,
  type ArchiveExportSnapshotOptions,
  type ArchiveExportSnapshotSummary,
  type CompleteArchiveExportRunInput,
  type CreateArchiveExportRunInput,
  type FailArchiveExportRunInput,
} from './export-repository.js';
import { ArchiveArtifactError } from './report.js';
import { ArchiveSpool } from './spool.js';

export interface ExportArchiveArtifactInput {
  includeProvenance: boolean;
  outputPath: string;
  overwrite: boolean;
  selection: ArchiveManifest['selection'];
  signal?: AbortSignal;
}

export interface ArchiveExportRepositoryPort {
  acquireExportLease(signal?: AbortSignal): Promise<{
    assertActive(signal?: AbortSignal): Promise<void>;
    release(): Promise<void>;
  }>;
  completeRun(id: string, input: CompleteArchiveExportRunInput): Promise<void>;
  createRun(input: CreateArchiveExportRunInput): Promise<string>;
  failRun(id: string, input: FailArchiveExportRunInput): Promise<void>;
  readSnapshot(
    options: ArchiveExportSnapshotOptions,
    visitor: ArchiveExportRecordVisitor,
  ): Promise<ArchiveExportSnapshotSummary>;
}

function sameCounts(left: ArchiveManifest['counts'], right: ArchiveManifest['counts']): boolean {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof ArchiveManifest['counts']] ===
      right[key as keyof ArchiveManifest['counts']],
  );
}

function safeFailureCode(error: unknown): string {
  if (error instanceof ArchiveExportError) return error.code;
  if (error instanceof ArchiveArtifactError) return error.code;
  if (error instanceof ArchiveExportRepositoryError) return error.code;
  return 'archive_export_failed';
}

function runStatus(error: unknown, signal?: AbortSignal): 'failed' | 'interrupted' {
  if (signal?.aborted) return 'interrupted';
  if (
    (error instanceof ArchiveArtifactError && error.code === 'archive_aborted') ||
    (error instanceof ArchiveExportRepositoryError && error.code === 'archive_export_aborted')
  ) {
    return 'interrupted';
  }
  return 'failed';
}

function reportStatus(error: unknown, signal?: AbortSignal): 'fatal' | 'interrupted' {
  return runStatus(error, signal) === 'interrupted' ? 'interrupted' : 'fatal';
}

function publishedBy(error: unknown, published: boolean): boolean {
  return published || (error instanceof ArchiveArtifactError && error.artifactPublished);
}

export class ArchiveExportService {
  constructor(private readonly repository: ArchiveExportRepositoryPort) {}

  async run(input: ExportArchiveArtifactInput): Promise<ArchiveExportReport> {
    const startedAt = new Date();
    const workspace = await prepareArchiveArtifact({
      outputPath: input.outputPath,
      overwrite: input.overwrite,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const spool = new ArchiveSpool({
      directory: workspace.workDirectory,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    let artifactPublished = false;
    let counts: ArchiveManifest['counts'] | undefined;
    let lease:
      | { assertActive(signal?: AbortSignal): Promise<void>; release(): Promise<void> }
      | undefined;
    let runId: string | undefined;
    let snapshotAt: string | undefined;

    try {
      input.signal?.throwIfAborted();
      lease = await this.repository.acquireExportLease(input.signal);
      runId = await this.repository.createRun({
        includeProvenance: input.includeProvenance,
        selection: input.selection,
      });
      const snapshot = await this.repository.readSnapshot(
        {
          includeProvenance: input.includeProvenance,
          selection: input.selection,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        (family, record) => spool.write(family, record),
      );
      snapshotAt = snapshot.snapshotAt;
      await lease.assertActive(input.signal);
      const prepared = await spool.finish();
      counts = prepared.counts;
      if (!sameCounts(snapshot.counts, prepared.counts)) {
        throw new ArchiveExportRepositoryError('archive_export_invalid_database_state');
      }

      const checksumBody = Buffer.from(renderChecksumFile(prepared.checksumEntries));
      const manifest = archiveManifestSchema.parse({
        checksumFile: {
          byteLength: checksumBody.byteLength.toString(),
          path: 'checksums.sha256',
          sha256: sha256Hex(checksumBody),
        },
        counts: prepared.counts,
        createdAt: snapshot.createdAt,
        exporter: { name: 'koharu-suite', version: VERSION },
        files: prepared.files,
        format: ARCHIVE_FORMAT_NAME,
        formatVersion: ARCHIVE_FORMAT_VERSION,
        logicalBytes: prepared.logicalBytes,
        missingMedia: prepared.missingMedia,
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        sections: { media: false, provenance: input.includeProvenance },
        selection: snapshot.selection,
        snapshotAt: snapshot.snapshotAt,
      });
      const manifestBody = Buffer.from(canonicalJsonBytes(manifest, { profile: 'manifest' }));
      const entries: ArchiveWriteEntry[] = [
        {
          body: Readable.from([manifestBody]),
          byteLength: manifestBody.byteLength,
          path: 'manifest.json',
        },
        {
          body: Readable.from([checksumBody]),
          byteLength: checksumBody.byteLength,
          path: 'checksums.sha256',
        },
        ...prepared.localEntries.map((entry) => ({
          body: createReadStream(entry.localPath),
          byteLength: entry.byteLength,
          path: entry.path,
        })),
      ];
      await lease.assertActive(input.signal);
      await writeTarZstd(entries, workspace.createArchiveWriteStream(), {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      await lease.assertActive(input.signal);
      const validation = await workspace.validateAndPublish();
      artifactPublished = true;
      if (
        validation.report.status !== 'clean' ||
        validation.artifactByteLength === null ||
        validation.artifactSha256 === null ||
        !sameCounts(validation.manifest.counts, prepared.counts)
      ) {
        throw new ArchiveArtifactError('artifact_validation_failed', {
          artifactPublished: true,
          validationReport: validation.report,
        });
      }
      const report = createCleanArchiveExportReport({
        artifactByteLength: validation.artifactByteLength,
        artifactSha256: validation.artifactSha256,
        counts: prepared.counts,
        includeProvenance: input.includeProvenance,
        selection: snapshot.selection,
        snapshotAt: snapshot.snapshotAt,
        startedAt,
      });
      await lease.assertActive(input.signal);
      await lease.release();
      lease = undefined;
      await this.repository.completeRun(runId, {
        artifactByteLength: validation.artifactByteLength,
        artifactSha256: validation.artifactSha256,
        counts: prepared.counts,
        snapshotAt: snapshot.snapshotAt,
      });
      return report;
    } catch (error) {
      await spool.closeAfterFailure();
      const code = safeFailureCode(error);
      const status = runStatus(error, input.signal);
      if (runId !== undefined) {
        await this.repository.failRun(runId, { code, status }).catch(() => undefined);
      }
      const report = createFatalArchiveExportReport({
        artifactPublished: publishedBy(error, artifactPublished),
        code,
        ...(counts === undefined ? {} : { counts }),
        includeProvenance: input.includeProvenance,
        selection: input.selection,
        ...(snapshotAt === undefined ? {} : { snapshotAt }),
        startedAt,
        status: reportStatus(error, input.signal),
      });
      throw new ArchiveExportError(code, report, { cause: error });
    } finally {
      await workspace.cleanup();
      await lease?.release().catch(() => undefined);
    }
  }
}
