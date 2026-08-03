import { type ArchiveReport, ArchiveValidationError } from '@koharu-suite/archive-format';
import { validateArchiveArtifactFile } from './artifact-file.js';
import {
  ArchiveArtifactError,
  archiveArtifactReason,
  createFatalArchiveInspectReport,
} from './report.js';

export interface InspectArchiveArtifactInput {
  inputPath: string;
  signal?: AbortSignal;
}

/** Validates one local artifact without opening configuration or PostgreSQL. */
export async function inspectArchiveArtifact(
  input: InspectArchiveArtifactInput,
): Promise<ArchiveReport> {
  const startedAt = new Date();
  try {
    return (
      await validateArchiveArtifactFile(input.inputPath, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    ).report;
  } catch (error) {
    if (error instanceof ArchiveValidationError) return error.report;
    const reason =
      error instanceof ArchiveArtifactError
        ? error.code
        : archiveArtifactReason(error, 'input_unavailable', input.signal);
    return createFatalArchiveInspectReport(reason, startedAt);
  }
}
