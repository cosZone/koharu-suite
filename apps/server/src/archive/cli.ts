import {
  type ArchiveManifest,
  type ArchiveReport,
  archiveReportExitCode,
  archiveSelectionSchema,
} from '@koharu-suite/archive-format';
import { parseTelegramChannelId } from '../config.js';
import {
  ArchiveExportError,
  type ArchiveExportReport,
  archiveExportReportExitCode,
  renderArchiveExportReportText,
} from './export-report.js';
import { renderArchiveReportText } from './report.js';

export type ArchiveCliExitCode = 0 | 1 | 2;

export interface ArchiveCliInput {
  channels?: readonly string[];
  includeProvenance: boolean;
  inputPath?: string;
  json: boolean;
  outputPath?: string;
  overwrite: boolean;
  signal?: AbortSignal;
  subcommand: string | undefined;
}

export interface ArchiveExportCliInput {
  includeProvenance: boolean;
  outputPath: string;
  overwrite: boolean;
  selection: ArchiveManifest['selection'];
  signal?: AbortSignal;
}

export interface ArchiveInspectCliInput {
  inputPath: string;
  signal?: AbortSignal;
}

export interface ArchiveCliDependencies {
  exportArchive?: (input: ArchiveExportCliInput) => Promise<ArchiveExportReport>;
  inspectArchive?: (input: ArchiveInspectCliInput) => Promise<ArchiveReport>;
  write: (output: string) => void;
}

interface ArchiveCliFailureReport {
  error: {
    code: 'archive_command_failed' | 'invalid_arguments';
    message: string;
  };
  operation: 'archive' | 'export' | 'inspect';
  schemaVersion: 1;
  status: 'fatal';
}

type ArchiveCliResult =
  | { kind: 'export'; report: ArchiveExportReport }
  | { kind: 'inspect'; report: ArchiveReport }
  | { kind: 'failure'; report: ArchiveCliFailureReport };

class ArchiveCliUsageError extends Error {}

function requiredPath(value: string | undefined, message: string): string {
  if (value === undefined || value.length === 0) throw new ArchiveCliUsageError(message);
  return value;
}

function exportSelection(channels: readonly string[] | undefined): ArchiveManifest['selection'] {
  if (channels === undefined || channels.length === 0) return { mode: 'all' };
  try {
    const parsed = channels.map((channel) => parseTelegramChannelId(channel).toString());
    if (new Set(parsed).size !== parsed.length) {
      throw new ArchiveCliUsageError('archive export does not accept duplicate --channel');
    }
    const telegramChatIds = parsed.sort((left, right) => {
      const leftId = BigInt(left);
      const rightId = BigInt(right);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    return archiveSelectionSchema.parse({ mode: 'channels', telegramChatIds });
  } catch (error) {
    if (error instanceof ArchiveCliUsageError) throw error;
    throw new ArchiveCliUsageError('archive export received an invalid --channel');
  }
}

function validateExportInput(input: ArchiveCliInput): ArchiveExportCliInput {
  if (input.inputPath !== undefined) {
    throw new ArchiveCliUsageError('archive export does not accept --input');
  }
  const outputPath = requiredPath(input.outputPath, 'archive export requires --output');
  return {
    includeProvenance: input.includeProvenance,
    outputPath,
    overwrite: input.overwrite,
    selection: exportSelection(input.channels),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function validateInspectInput(input: ArchiveCliInput): ArchiveInspectCliInput {
  if (input.outputPath !== undefined) {
    throw new ArchiveCliUsageError('archive inspect does not accept --output');
  }
  if (input.channels !== undefined && input.channels.length > 0) {
    throw new ArchiveCliUsageError('archive inspect does not accept --channel');
  }
  if (input.includeProvenance) {
    throw new ArchiveCliUsageError('archive inspect does not accept --include-provenance');
  }
  if (input.overwrite) {
    throw new ArchiveCliUsageError('archive inspect does not accept --overwrite');
  }
  const inputPath = requiredPath(input.inputPath, 'archive inspect requires --input');
  return {
    inputPath,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function failureReport(
  operation: ArchiveCliFailureReport['operation'],
  code: ArchiveCliFailureReport['error']['code'],
  message: string,
): ArchiveCliFailureReport {
  return {
    error: { code, message },
    operation,
    schemaVersion: 1,
    status: 'fatal',
  };
}

function failureResult(
  operation: ArchiveCliFailureReport['operation'],
  code: ArchiveCliFailureReport['error']['code'],
  message: string,
): ArchiveCliResult {
  return { kind: 'failure', report: failureReport(operation, code, message) };
}

function resultExitCode(result: ArchiveCliResult): ArchiveCliExitCode {
  if (result.kind === 'export') return archiveExportReportExitCode(result.report);
  if (result.kind === 'inspect') return archiveReportExitCode(result.report);
  return 1;
}

function renderFailureReportText(report: ArchiveCliFailureReport): string {
  const label = report.operation === 'archive' ? 'Archive' : `Archive ${report.operation}`;
  return `${label}: FATAL\n${report.error.message}\n`;
}

function serializeResult(result: ArchiveCliResult, json: boolean): string {
  if (!json) {
    if (result.kind === 'export') return renderArchiveExportReportText(result.report);
    if (result.kind === 'inspect') return `${renderArchiveReportText(result.report)}\n`;
    return renderFailureReportText(result.report);
  }
  const serialized = JSON.stringify(result.report);
  if (serialized === undefined || !serialized.startsWith('{')) {
    throw new TypeError('Archive command returned a non-object report');
  }
  return `${serialized}\n`;
}

/** Validate archive CLI arguments, invoke one lazy dependency, and emit exactly one report. */
export async function runArchiveCli(
  input: ArchiveCliInput,
  dependencies: ArchiveCliDependencies,
): Promise<ArchiveCliExitCode> {
  const operation =
    input.subcommand === 'export' || input.subcommand === 'inspect' ? input.subcommand : 'archive';
  let result: ArchiveCliResult;
  try {
    if (input.subcommand === 'export') {
      const normalized = validateExportInput(input);
      if (!dependencies.exportArchive) throw new Error('Archive export dependency is unavailable');
      result = { kind: 'export', report: await dependencies.exportArchive(normalized) };
    } else if (input.subcommand === 'inspect') {
      const normalized = validateInspectInput(input);
      if (!dependencies.inspectArchive)
        throw new Error('Archive inspect dependency is unavailable');
      result = { kind: 'inspect', report: await dependencies.inspectArchive(normalized) };
    } else {
      throw new ArchiveCliUsageError('archive command must be export or inspect');
    }
  } catch (error) {
    if (operation === 'export' && error instanceof ArchiveExportError) {
      result = { kind: 'export', report: error.report };
    } else {
      result =
        error instanceof ArchiveCliUsageError
          ? failureResult(operation, 'invalid_arguments', error.message)
          : failureResult(operation, 'archive_command_failed', `Archive ${operation} failed`);
    }
  }

  let output: string;
  try {
    output = serializeResult(result, input.json);
  } catch {
    result = failureResult(operation, 'archive_command_failed', `Archive ${operation} failed`);
    output = serializeResult(result, input.json);
  }
  dependencies.write(output);
  return resultExitCode(result);
}
