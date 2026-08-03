import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import {
  ArchiveValidationError,
  type ArchiveValidationResult,
  validateTarZstdArchive,
} from '@koharu-suite/archive-format';
import { ArchiveArtifactError, archiveArtifactReason } from './report.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UNSAFE_DIRECTORY_MODE_MASK = 0o022;

export interface PrepareArchiveArtifactInput {
  outputPath: string;
  overwrite?: boolean;
  signal?: AbortSignal;
}

export interface WriteValidatedArchiveArtifactInput extends PrepareArchiveArtifactInput {
  write: (output: Writable, signal?: AbortSignal) => Promise<void>;
}

export interface ArchiveArtifactWorkspace {
  /** Private sibling directory for bounded export spools. Never report this path. */
  readonly workDirectory: string;
  /** Private sibling file used until the complete archive passes validation. */
  readonly stagingPath: string;
  /** Creates the only writable stream for this workspace. */
  createArchiveWriteStream(): Writable;
  /** Durably closes, validates, and atomically publishes the staged archive. */
  validateAndPublish(): Promise<ArchiveValidationResult>;
  /** Idempotently removes only this workspace's random staging resources. */
  cleanup(): Promise<void>;
}

interface TrustedOutputParent {
  directory: FileHandle;
  effectiveUserId: number;
  finalPath: string;
  identity: Pick<Stats, 'dev' | 'ino'>;
  parentPath: string;
}

interface OpenedArchive {
  file: FileHandle;
  initial: Readonly<Stats>;
}

export interface ArchiveArtifactOperations {
  syncParentDirectory(directory: FileHandle): Promise<void>;
}

const defaultOperations: ArchiveArtifactOperations = {
  syncParentDirectory: (directory) => directory.sync(),
};

export async function prepareArchiveArtifact(
  input: PrepareArchiveArtifactInput,
  operations: ArchiveArtifactOperations = defaultOperations,
): Promise<ArchiveArtifactWorkspace> {
  throwArchiveIfAborted(input.signal);
  const trusted = await openTrustedOutputParent(input.outputPath, input.signal);
  const nonce = randomUUID();
  const leaf = basename(trusted.finalPath);
  const workDirectory = join(trusted.parentPath, `.${leaf}.${nonce}.work`);
  const stagingPath = join(trusted.parentPath, `.${leaf}.${nonce}.partial`);
  let stagingFile: FileHandle | undefined;

  try {
    await assertTrustedOutputParent(trusted);
    await mkdir(workDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    await assertTrustedOutputParent(trusted);
    await chmod(workDirectory, PRIVATE_DIRECTORY_MODE);
    stagingFile = await open(
      stagingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await assertTrustedOutputParent(trusted);
    await chmod(stagingPath, PRIVATE_FILE_MODE);
    return new NodeArchiveArtifactWorkspace({
      directory: trusted.directory,
      effectiveUserId: trusted.effectiveUserId,
      finalPath: trusted.finalPath,
      identity: trusted.identity,
      operations,
      overwrite: input.overwrite ?? false,
      parentPath: trusted.parentPath,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      stagingFile,
      stagingPath,
      workDirectory,
    });
  } catch (error) {
    await stagingFile?.close().catch(() => undefined);
    if (await trustedParentStillActive(trusted)) {
      await unlink(stagingPath).catch(() => undefined);
      await rm(workDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
    await trusted.directory.close().catch(() => undefined);
    throw new ArchiveArtifactError(
      archiveArtifactReason(error, 'artifact_write_failed', input.signal),
      { cause: error },
    );
  }
}

export async function writeValidatedArchiveArtifact(
  input: WriteValidatedArchiveArtifactInput,
): Promise<ArchiveValidationResult> {
  const workspace = await prepareArchiveArtifact(input);
  try {
    await input.write(workspace.createArchiveWriteStream(), input.signal);
    return await workspace.validateAndPublish();
  } finally {
    await workspace.cleanup();
  }
}

export async function validateArchiveArtifactFile(
  inputPath: string,
  options: { signal?: AbortSignal } = {},
): Promise<ArchiveValidationResult> {
  options.signal?.throwIfAborted();
  let opened: OpenedArchive | undefined;
  let stream: ReturnType<FileHandle['createReadStream']> | undefined;
  try {
    opened = await openArchiveForValidation(inputPath, options.signal);
    stream = opened.file.createReadStream({
      autoClose: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      start: 0,
    });
    const result = await validateTarZstdArchive(stream, {
      mode: 'inspect',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const final = await opened.file.stat();
    if (!sameOpenedFile(opened.initial, final)) {
      throw new ArchiveArtifactError('input_changed');
    }
    return result;
  } catch (error) {
    if (error instanceof ArchiveValidationError || error instanceof ArchiveArtifactError) {
      throw error;
    }
    throw new ArchiveArtifactError(
      archiveArtifactReason(error, 'input_unavailable', options.signal),
      { cause: error },
    );
  } finally {
    stream?.destroy();
    await opened?.file.close().catch(() => undefined);
  }
}

class NodeArchiveArtifactWorkspace implements ArchiveArtifactWorkspace {
  readonly stagingPath: string;
  readonly workDirectory: string;

  #cleaned = false;
  #directory: FileHandle | undefined;
  readonly #effectiveUserId: number;
  #file: FileHandle | undefined;
  readonly #finalPath: string;
  readonly #identity: Pick<Stats, 'dev' | 'ino'>;
  readonly #operations: ArchiveArtifactOperations;
  readonly #overwrite: boolean;
  readonly #parentPath: string;
  readonly #signal: AbortSignal | undefined;
  #stream: Writable | undefined;
  #streamError: unknown;

  constructor(input: {
    directory: FileHandle;
    effectiveUserId: number;
    finalPath: string;
    identity: Pick<Stats, 'dev' | 'ino'>;
    operations: ArchiveArtifactOperations;
    overwrite: boolean;
    parentPath: string;
    signal?: AbortSignal;
    stagingFile: FileHandle;
    stagingPath: string;
    workDirectory: string;
  }) {
    this.#directory = input.directory;
    this.#effectiveUserId = input.effectiveUserId;
    this.#file = input.stagingFile;
    this.#finalPath = input.finalPath;
    this.#identity = input.identity;
    this.#operations = input.operations;
    this.#overwrite = input.overwrite;
    this.#parentPath = input.parentPath;
    this.#signal = input.signal;
    this.stagingPath = input.stagingPath;
    this.workDirectory = input.workDirectory;
  }

  createArchiveWriteStream(): Writable {
    if (this.#stream !== undefined || this.#file === undefined || this.#cleaned) {
      throw new ArchiveArtifactError('artifact_not_written');
    }
    const file = this.#file;
    this.#stream = new Writable({
      emitClose: false,
      write(chunk: Buffer | string, encoding, callback) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
        writeAll(file, bytes).then(
          () => callback(),
          (error: unknown) => callback(error as Error),
        );
      },
    });
    this.#stream.on('error', (error) => {
      this.#streamError = error;
    });
    return this.#stream;
  }

  async validateAndPublish(): Promise<ArchiveValidationResult> {
    if (this.#cleaned || this.#file === undefined || this.#directory === undefined) {
      throw new ArchiveArtifactError('artifact_not_written');
    }
    if (this.#stream === undefined || !this.#stream.writableFinished || this.#streamError) {
      throw new ArchiveArtifactError('artifact_not_written', { cause: this.#streamError });
    }

    try {
      this.#signal?.throwIfAborted();
      await this.#assertTrustedParent();
      await this.#file.sync();
      await this.#file.close();
      this.#file = undefined;

      const validation = await validateArchiveArtifactFile(this.stagingPath, {
        ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      });
      this.#signal?.throwIfAborted();
      await this.#assertTrustedParent();
      await publishStaging({
        assertParent: () => this.#assertTrustedParent(),
        finalPath: this.#finalPath,
        overwrite: this.#overwrite,
        stagingPath: this.stagingPath,
      });
      let published: Stats;
      try {
        await this.#assertTrustedParent();
        published = await lstat(this.#finalPath);
      } catch (error) {
        throw new ArchiveArtifactError('finalization_failed', {
          artifactPublished: true,
          cause: error,
          validationReport: validation.report,
        });
      }
      if (
        !published.isFile() ||
        published.isSymbolicLink() ||
        (published.mode & 0o777) !== PRIVATE_FILE_MODE
      ) {
        throw new ArchiveArtifactError('finalization_failed', {
          artifactPublished: true,
          validationReport: validation.report,
        });
      }

      try {
        await this.#operations.syncParentDirectory(this.#directory);
      } catch (error) {
        throw new ArchiveArtifactError('finalization_durability_unknown', {
          artifactPublished: true,
          cause: error,
          validationReport: validation.report,
        });
      }
      return validation;
    } catch (error) {
      if (error instanceof ArchiveArtifactError) throw error;
      if (error instanceof ArchiveValidationError) {
        throw new ArchiveArtifactError('artifact_validation_failed', {
          cause: error,
          validationReport: error.report,
        });
      }
      throw new ArchiveArtifactError(
        archiveArtifactReason(error, 'artifact_write_failed', this.#signal),
        { cause: error },
      );
    }
  }

  async cleanup(): Promise<void> {
    if (this.#cleaned) return;
    this.#cleaned = true;
    this.#stream?.destroy();
    await this.#file?.close().catch(() => undefined);
    this.#file = undefined;
    if (await this.#parentStillActive()) {
      await unlink(this.stagingPath).catch(() => undefined);
      await rm(this.workDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
    await this.#directory?.close().catch(() => undefined);
    this.#directory = undefined;
  }

  async #assertTrustedParent(): Promise<void> {
    const directory = this.#directory;
    if (directory === undefined) throw new ArchiveArtifactError('output_parent_untrusted');
    await assertTrustedOutputParent({
      directory,
      effectiveUserId: this.#effectiveUserId,
      finalPath: this.#finalPath,
      identity: this.#identity,
      parentPath: this.#parentPath,
    });
  }

  async #parentStillActive(): Promise<boolean> {
    try {
      await this.#assertTrustedParent();
      return true;
    } catch {
      return false;
    }
  }
}

async function openTrustedOutputParent(
  outputPath: string,
  signal?: AbortSignal,
): Promise<TrustedOutputParent> {
  if (!isAbsolute(outputPath) || outputPath.includes('\0')) {
    throw new ArchiveArtifactError('output_invalid');
  }
  signal?.throwIfAborted();
  const requestedPath = resolve(outputPath);
  const leaf = basename(requestedPath);
  if (leaf.length === 0 || leaf === '.' || leaf === '..') {
    throw new ArchiveArtifactError('output_invalid');
  }

  let parentPath: string;
  let directory: FileHandle | undefined;
  try {
    parentPath = await realpath(dirname(requestedPath));
    directory = await open(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const metadata = await directory.stat();
    const effectiveUserId = process.geteuid?.();
    if (
      !metadata.isDirectory() ||
      effectiveUserId === undefined ||
      metadata.uid !== effectiveUserId ||
      (metadata.mode & UNSAFE_DIRECTORY_MODE_MASK) !== 0
    ) {
      throw new ArchiveArtifactError('output_parent_untrusted');
    }
    await assertTrustedAncestorChain(parentPath, effectiveUserId);
    signal?.throwIfAborted();
    return {
      directory,
      effectiveUserId,
      finalPath: join(parentPath, leaf),
      identity: { dev: metadata.dev, ino: metadata.ino },
      parentPath,
    };
  } catch (error) {
    await directory?.close().catch(() => undefined);
    if (error instanceof ArchiveArtifactError) throw error;
    throw new ArchiveArtifactError(
      archiveArtifactReason(error, 'output_parent_unavailable', signal),
      { cause: error },
    );
  }
}

async function openArchiveForValidation(
  inputPath: string,
  signal?: AbortSignal,
): Promise<OpenedArchive> {
  signal?.throwIfAborted();
  let file: FileHandle | undefined;
  try {
    file = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await file.stat();
    if (!initial.isFile()) {
      throw new ArchiveArtifactError('input_not_regular');
    }
    signal?.throwIfAborted();
    return { file, initial };
  } catch (error) {
    if (error instanceof ArchiveArtifactError) {
      await file?.close().catch(() => undefined);
      throw error;
    }
    await file?.close().catch(() => undefined);
    throw new ArchiveArtifactError(archiveArtifactReason(error, 'input_unavailable', signal), {
      cause: error,
    });
  }
}

function sameOpenedFile(initial: Readonly<Stats>, final: Readonly<Stats>): boolean {
  return (
    initial.dev === final.dev &&
    initial.ino === final.ino &&
    initial.size === final.size &&
    initial.mtimeMs === final.mtimeMs &&
    initial.ctimeMs === final.ctimeMs
  );
}

async function publishStaging(input: {
  assertParent: () => Promise<void>;
  finalPath: string;
  overwrite: boolean;
  stagingPath: string;
}): Promise<void> {
  let artifactPublished = false;
  try {
    await input.assertParent();
    if (!input.overwrite) {
      await link(input.stagingPath, input.finalPath);
      artifactPublished = true;
      await unlink(input.stagingPath);
      return;
    }

    try {
      await input.assertParent();
      const existing = await lstat(input.finalPath);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new ArchiveArtifactError('output_not_regular');
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    await input.assertParent();
    await rename(input.stagingPath, input.finalPath);
    artifactPublished = true;
  } catch (error) {
    if (error instanceof ArchiveArtifactError) throw error;
    if (isNodeError(error, 'EEXIST')) {
      throw new ArchiveArtifactError('output_exists', { cause: error });
    }
    throw new ArchiveArtifactError('finalization_failed', {
      artifactPublished,
      cause: error,
    });
  }
}

async function assertTrustedAncestorChain(
  parentPath: string,
  effectiveUserId: number,
): Promise<void> {
  let current = parentPath;
  while (true) {
    const metadata = await lstat(current);
    const sticky = (metadata.mode & 0o1000) !== 0;
    const writableByOthers = (metadata.mode & UNSAFE_DIRECTORY_MODE_MASK) !== 0;
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.uid !== 0 && metadata.uid !== effectiveUserId) ||
      (writableByOthers && !sticky)
    ) {
      throw new ArchiveArtifactError('output_parent_untrusted');
    }
    const next = dirname(current);
    if (next === current) return;
    current = next;
  }
}

async function assertTrustedOutputParent(trusted: TrustedOutputParent): Promise<void> {
  const [resolved, pathMetadata, handleMetadata] = await Promise.all([
    realpath(trusted.parentPath),
    lstat(trusted.parentPath),
    trusted.directory.stat(),
  ]);
  if (
    resolved !== trusted.parentPath ||
    !pathMetadata.isDirectory() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.dev !== trusted.identity.dev ||
    pathMetadata.ino !== trusted.identity.ino ||
    handleMetadata.dev !== trusted.identity.dev ||
    handleMetadata.ino !== trusted.identity.ino ||
    pathMetadata.uid !== trusted.effectiveUserId ||
    (pathMetadata.mode & UNSAFE_DIRECTORY_MODE_MASK) !== 0
  ) {
    throw new ArchiveArtifactError('output_parent_untrusted');
  }
}

async function trustedParentStillActive(trusted: TrustedOutputParent): Promise<boolean> {
  try {
    await assertTrustedOutputParent(trusted);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function throwArchiveIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ArchiveArtifactError('archive_aborted', { cause: signal.reason });
  }
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error('archive write made no progress');
    offset += result.bytesWritten;
  }
}
