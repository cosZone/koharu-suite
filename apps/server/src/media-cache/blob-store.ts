import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STAGED_BLOB_OWNER = Symbol('staged-blob-owner');

export interface MediaBlobLease {
  leaseToken: string;
  planId: string;
}

export interface MediaBlobIdentity {
  byteLength: number;
  relativeKey: string;
  sha256: string;
}

export interface StagedMediaBlob {
  byteLength: number;
  lease: MediaBlobLease;
  objectId: string;
  sha256: string;
}

interface OwnedStagedMediaBlob extends StagedMediaBlob {
  [STAGED_BLOB_OWNER]: string;
}

interface ActiveMediaStage {
  abortController: AbortController;
  done: Promise<void>;
  finish: () => void;
}

export interface StageMediaBlobInput {
  lease: MediaBlobLease;
  maxBytes: number;
  objectId: string;
  signal?: AbortSignal;
  source: ReadableStream<Uint8Array>;
}

export interface PublishedMediaBlob extends MediaBlobIdentity {
  outcome: 'already_present' | 'created';
}

export type MediaBlobSettlement = 'db_committed' | 'db_rolled_back';
export type MediaBlobEvictionResult = 'absent' | 'removed';

export interface DiscardPartialLeaseResult {
  removedBytes: number;
  removedFiles: number;
}

export class MediaBlobStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MediaBlobStoreError';
  }
}

export class MediaBlobTooLargeError extends MediaBlobStoreError {
  constructor(readonly maxBytes: number) {
    super('media_blob_too_large', `Media blob exceeds the ${maxBytes}-byte hard limit`);
    this.name = 'MediaBlobTooLargeError';
  }
}

export class MediaBlobIntegrityError extends MediaBlobStoreError {
  constructor(message: string) {
    super('media_blob_integrity_error', message);
    this.name = 'MediaBlobIntegrityError';
  }
}

export class InvalidMediaBlobHandleError extends MediaBlobStoreError {
  constructor() {
    super(
      'invalid_media_blob_handle',
      'The staged media blob does not belong to this store or is no longer settleable',
    );
    this.name = 'InvalidMediaBlobHandleError';
  }
}

export class MediaBlobLeaseDiscardedError extends MediaBlobStoreError {
  constructor() {
    super('media_blob_lease_discarded', 'The media blob lease was discarded during staging');
    this.name = 'MediaBlobLeaseDiscardedError';
  }
}

export class LocalMediaBlobStore {
  readonly #activeStages = new Map<string, Set<ActiveMediaStage>>();
  readonly #discardedLeases = new Set<string>();
  readonly #ownerId = randomUUID();
  #root: string;
  readonly #staged = new WeakSet<object>();

  constructor(root: string) {
    if (!root || !isAbsolute(root)) {
      throw new TypeError('Media blob store root must be an absolute path');
    }
    this.#root = resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { mode: 0o700, recursive: true });
    this.#root = await realpath(this.#root);
    await Promise.all([
      mkdir(join(this.#root, '.tmp'), { mode: 0o700, recursive: true }),
      mkdir(join(this.#root, 'blobs'), { mode: 0o700, recursive: true }),
    ]);
    await Promise.all([
      this.#assertDirectoryContained(join(this.#root, '.tmp')),
      this.#assertDirectoryContained(join(this.#root, 'blobs')),
    ]);
  }

  async stage(input: StageMediaBlobInput): Promise<StagedMediaBlob> {
    assertLease(input.lease);
    assertUuid('objectId', input.objectId);
    assertMaxBytes(input.maxBytes);

    const active = this.#registerActiveStage(input.lease);
    const signal = input.signal
      ? AbortSignal.any([input.signal, active.abortController.signal])
      : active.abortController.signal;
    const partialPath = this.#partialPath(input.lease, input.objectId);
    const stagedPath = this.#stagedPath(input.lease, input.objectId);
    let stagingDirectory: string | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let file: FileHandle | undefined;
    let byteLength = 0;
    const hash = createHash('sha256');
    let abort: ReturnType<typeof abortPromise>;

    try {
      reader = input.source.getReader();
      stagingDirectory = await this.#prepareStagingDirectory(input.lease);
      throwIfAborted(signal);
      abort = abortPromise(signal);
      file = await open(partialPath, 'wx', 0o600);
      while (true) {
        const result = await (abort ? Promise.race([reader.read(), abort.promise]) : reader.read());
        if (result.done) {
          break;
        }
        const chunk = result.value;
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError('Media source yielded a non-Uint8Array chunk');
        }
        if (byteLength + chunk.byteLength > input.maxBytes) {
          throw new MediaBlobTooLargeError(input.maxBytes);
        }
        await writeAll(file, chunk);
        hash.update(chunk);
        byteLength += chunk.byteLength;
      }
      throwIfAborted(signal);
      await file.sync();
      await file.close();
      file = undefined;

      await link(partialPath, stagedPath);
      await unlink(partialPath);
      await this.#syncDirectory(stagingDirectory);

      return this.#own({
        byteLength,
        lease: { ...input.lease },
        objectId: input.objectId,
        sha256: hash.digest('hex'),
      });
    } catch (error) {
      await file?.close().catch(() => undefined);
      await reader?.cancel(error).catch(() => undefined);
      await unlinkIfPresent(partialPath);
      if (stagingDirectory && (await this.#assertDirectoryContained(stagingDirectory))) {
        await this.#syncDirectory(stagingDirectory);
      }
      throw error;
    } finally {
      abort?.removeListener();
      reader?.releaseLock();
      active.finish();
    }
  }

  async publish(staged: StagedMediaBlob): Promise<PublishedMediaBlob> {
    this.#assertOwned(staged);
    const stagedPath = this.#stagedPath(staged.lease, staged.objectId);
    await assertFileMatches(stagedPath, staged.sha256, staged.byteLength);

    const relativeKey = relativeKeyForHash(staged.sha256);
    const finalPath = this.#resolveRelativeKey(relativeKey);
    const finalDirectory = await this.#prepareBlobDirectory(staged.sha256);

    let outcome: PublishedMediaBlob['outcome'] = 'created';
    try {
      await link(stagedPath, finalPath);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
      outcome = 'already_present';
      await assertFileMatches(finalPath, staged.sha256, staged.byteLength);
    }
    await this.#syncDirectory(finalDirectory);

    return {
      byteLength: staged.byteLength,
      outcome,
      relativeKey,
      sha256: staged.sha256,
    };
  }

  async recoverLease(lease: MediaBlobLease): Promise<readonly StagedMediaBlob[]> {
    assertLease(lease);
    const stagingDirectory = this.#stagingDirectory(lease);
    if (!(await this.#assertDirectoryContained(stagingDirectory))) {
      return [];
    }
    const entries = await readLeaseEntries(stagingDirectory);
    const recovered: StagedMediaBlob[] = [];

    for (const entry of entries) {
      if (entry.name.endsWith('.part')) {
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.staged')) {
        throw new MediaBlobIntegrityError('Lease staging tree contains an unexpected entry');
      }
      const objectId = entry.name.slice(0, -'.staged'.length);
      assertUuid('staged objectId', objectId);
      const identity = await identifyFile(join(stagingDirectory, entry.name));
      recovered.push(
        this.#own({
          ...identity,
          lease: { ...lease },
          objectId,
        }),
      );
    }

    return recovered.sort((left, right) => left.objectId.localeCompare(right.objectId));
  }

  async settle(staged: StagedMediaBlob, settlement: MediaBlobSettlement): Promise<void> {
    this.#assertOwned(staged);
    const stagingPath = this.#stagedPath(staged.lease, staged.objectId);
    const finalPath = this.#resolveRelativeKey(relativeKeyForHash(staged.sha256));
    await this.#assertRequiredDirectoryContained(this.#stagingDirectory(staged.lease));
    const stagingMetadata = await assertFileMatches(stagingPath, staged.sha256, staged.byteLength);

    if (settlement === 'db_committed') {
      await this.#assertRequiredDirectoryContained(dirname(finalPath));
      await assertFileMatches(finalPath, staged.sha256, staged.byteLength);
    } else if (settlement === 'db_rolled_back') {
      const finalDirectoryExists = await this.#assertDirectoryContained(dirname(finalPath));
      const finalMetadata = finalDirectoryExists ? await lstatIfPresent(finalPath) : undefined;
      if (finalMetadata) {
        if (!finalMetadata.isFile() || finalMetadata.isSymbolicLink()) {
          throw new MediaBlobIntegrityError('Content-addressed blob is not a regular file');
        }
        await assertFileMatches(finalPath, staged.sha256, staged.byteLength);
        if (
          finalMetadata.dev === stagingMetadata.dev &&
          finalMetadata.ino === stagingMetadata.ino
        ) {
          await unlink(finalPath);
          await this.#syncDirectory(dirname(finalPath));
        }
      }
    } else {
      throw new TypeError('Unknown media blob settlement');
    }

    await unlink(stagingPath);
    await this.#syncDirectory(this.#stagingDirectory(staged.lease));
    this.#staged.delete(staged);
    await this.#removeEmptyLeaseDirectories(staged.lease);
  }

  async discardPartialLease(lease: MediaBlobLease): Promise<DiscardPartialLeaseResult> {
    assertLease(lease);
    await this.#quiesceActiveStages(lease);
    const stagingDirectory = this.#stagingDirectory(lease);
    if (!(await this.#assertDirectoryContained(stagingDirectory))) {
      return { removedBytes: 0, removedFiles: 0 };
    }
    const entries = await readLeaseEntries(stagingDirectory);
    let removedBytes = 0;
    let removedFiles = 0;

    for (const entry of entries) {
      if (entry.name.endsWith('.staged')) {
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.part')) {
        throw new MediaBlobIntegrityError('Lease staging tree contains an unexpected entry');
      }
      const objectId = entry.name.slice(0, -'.part'.length);
      assertUuid('partial objectId', objectId);
      const path = join(stagingDirectory, entry.name);
      const metadata = await stat(path);
      await unlink(path);
      removedBytes += metadata.size;
      removedFiles += 1;
    }

    if (removedFiles > 0) {
      await this.#syncDirectory(stagingDirectory);
    }
    await this.#removeEmptyLeaseDirectories(lease);
    return { removedBytes, removedFiles };
  }

  async openStaged(staged: StagedMediaBlob): Promise<FileHandle> {
    this.#assertOwned(staged);
    const path = this.#stagedPath(staged.lease, staged.objectId);
    await this.#assertRequiredDirectoryContained(dirname(path));
    return openRegularFile(path, staged.byteLength);
  }

  async open(blob: MediaBlobIdentity): Promise<FileHandle> {
    assertBlobIdentity(blob);
    const path = this.#resolveRelativeKey(blob.relativeKey);
    await this.#assertRequiredDirectoryContained(dirname(path));
    return openRegularFile(path, blob.byteLength);
  }

  async evict(blob: MediaBlobIdentity): Promise<MediaBlobEvictionResult> {
    assertBlobIdentity(blob);
    const path = this.#resolveRelativeKey(blob.relativeKey);
    const parent = dirname(path);
    await this.#assertRequiredDirectoryContained(parent);
    let file: FileHandle;
    try {
      file = await openRegularFile(path, blob.byteLength);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        await this.#syncDirectory(parent);
        return 'absent';
      }
      throw error;
    }

    try {
      const [openMetadata, pathMetadata] = await Promise.all([file.stat(), lstat(path)]);
      if (
        pathMetadata.isSymbolicLink() ||
        !pathMetadata.isFile() ||
        openMetadata.dev !== pathMetadata.dev ||
        openMetadata.ino !== pathMetadata.ino
      ) {
        throw new MediaBlobIntegrityError('Media blob changed before eviction');
      }
      let result: MediaBlobEvictionResult = 'removed';
      await unlink(path).catch((error: unknown) => {
        if (!hasErrorCode(error, 'ENOENT')) {
          throw error;
        }
        result = 'absent';
      });
      await this.#syncDirectory(parent);
      return result;
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  #assertOwned(staged: StagedMediaBlob): asserts staged is OwnedStagedMediaBlob {
    if (
      !this.#staged.has(staged) ||
      (staged as Partial<OwnedStagedMediaBlob>)[STAGED_BLOB_OWNER] !== this.#ownerId
    ) {
      throw new InvalidMediaBlobHandleError();
    }
  }

  #own(staged: StagedMediaBlob): StagedMediaBlob {
    const owned: OwnedStagedMediaBlob = Object.freeze({
      ...staged,
      [STAGED_BLOB_OWNER]: this.#ownerId,
      lease: Object.freeze({ ...staged.lease }),
    });
    this.#staged.add(owned);
    return owned;
  }

  #resolveRelativeKey(relativeKey: string): string {
    const path = resolve(this.#root, relativeKey);
    if (!path.startsWith(`${this.#root}${sep}`)) {
      throw new MediaBlobIntegrityError('Media blob relative key escapes the store root');
    }
    return path;
  }

  #stagingDirectory(lease: MediaBlobLease): string {
    return join(this.#root, '.tmp', lease.planId, lease.leaseToken);
  }

  #partialPath(lease: MediaBlobLease, objectId: string): string {
    return join(this.#stagingDirectory(lease), `${objectId}.part`);
  }

  #stagedPath(lease: MediaBlobLease, objectId: string): string {
    return join(this.#stagingDirectory(lease), `${objectId}.staged`);
  }

  #registerActiveStage(lease: MediaBlobLease): ActiveMediaStage {
    const key = leaseKey(lease);
    if (this.#discardedLeases.has(key)) {
      throw new MediaBlobLeaseDiscardedError();
    }
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    let finished = false;
    const active: ActiveMediaStage = {
      abortController: new AbortController(),
      done,
      finish: () => {
        if (finished) {
          return;
        }
        finished = true;
        resolveDone();
        const stages = this.#activeStages.get(key);
        stages?.delete(active);
        if (stages?.size === 0) {
          this.#activeStages.delete(key);
        }
      },
    };
    const stages = this.#activeStages.get(key) ?? new Set<ActiveMediaStage>();
    stages.add(active);
    this.#activeStages.set(key, stages);
    return active;
  }

  async #quiesceActiveStages(lease: MediaBlobLease): Promise<void> {
    const key = leaseKey(lease);
    this.#discardedLeases.add(key);
    const stages = [...(this.#activeStages.get(key) ?? [])];
    if (stages.length === 0) {
      return;
    }
    const reason = new MediaBlobLeaseDiscardedError();
    for (const stage of stages) {
      stage.abortController.abort(reason);
    }
    await Promise.all(stages.map((stage) => stage.done));
  }

  async #prepareStagingDirectory(lease: MediaBlobLease): Promise<string> {
    const temporaryRoot = join(this.#root, '.tmp');
    await this.#assertRequiredDirectoryContained(temporaryRoot);
    const planDirectory = join(temporaryRoot, lease.planId);
    await mkdir(planDirectory, { mode: 0o700, recursive: true });
    await this.#assertRequiredDirectoryContained(planDirectory);
    const leaseDirectory = join(planDirectory, lease.leaseToken);
    await mkdir(leaseDirectory, { mode: 0o700, recursive: true });
    await this.#assertRequiredDirectoryContained(leaseDirectory);
    return leaseDirectory;
  }

  async #prepareBlobDirectory(sha256: string): Promise<string> {
    const blobsRoot = join(this.#root, 'blobs');
    await this.#assertRequiredDirectoryContained(blobsRoot);
    const firstShard = join(blobsRoot, sha256.slice(0, 2));
    await mkdir(firstShard, { mode: 0o700, recursive: true });
    await this.#assertRequiredDirectoryContained(firstShard);
    const secondShard = join(firstShard, sha256.slice(2, 4));
    await mkdir(secondShard, { mode: 0o700, recursive: true });
    await this.#assertRequiredDirectoryContained(secondShard);
    return secondShard;
  }

  async #assertRequiredDirectoryContained(path: string): Promise<void> {
    if (!(await this.#assertDirectoryContained(path))) {
      throw new MediaBlobIntegrityError('Required media blob directory is missing');
    }
  }

  async #assertDirectoryContained(path: string): Promise<boolean> {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(path);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return false;
      }
      throw error;
    }
    if (canonicalPath !== this.#root && !canonicalPath.startsWith(`${this.#root}${sep}`)) {
      throw new MediaBlobIntegrityError('Media blob directory escapes the store root');
    }
    return true;
  }

  async #removeEmptyLeaseDirectories(lease: MediaBlobLease): Promise<void> {
    const planDirectory = join(this.#root, '.tmp', lease.planId);
    await rmdir(this.#stagingDirectory(lease)).catch(ignoreAbsentOrNotEmpty);
    await rmdir(planDirectory).catch(ignoreAbsentOrNotEmpty);
  }

  async #syncDirectory(path: string): Promise<void> {
    let directory: FileHandle | undefined;
    try {
      directory = await open(path, 'r');
      await directory.sync();
    } catch (error) {
      if (
        !hasErrorCode(error, 'EINVAL') &&
        !hasErrorCode(error, 'ENOTSUP') &&
        !hasErrorCode(error, 'EPERM')
      ) {
        throw error;
      }
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }
}

function assertLease(lease: MediaBlobLease): void {
  assertUuid('planId', lease.planId);
  assertUuid('leaseToken', lease.leaseToken);
}

function leaseKey(lease: MediaBlobLease): string {
  return `${lease.planId}:${lease.leaseToken}`;
}

function assertUuid(name: string, value: string): void {
  if (!CANONICAL_UUID.test(value)) {
    throw new TypeError(`${name} must be a canonical lowercase UUID`);
  }
}

function assertMaxBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }
}

function assertBlobIdentity(blob: MediaBlobIdentity): void {
  if (!Number.isSafeInteger(blob.byteLength) || blob.byteLength < 0) {
    throw new MediaBlobIntegrityError('Media blob byte length is invalid');
  }
  if (!SHA256.test(blob.sha256) || blob.relativeKey !== relativeKeyForHash(blob.sha256)) {
    throw new MediaBlobIntegrityError('Media blob identity is not canonical');
  }
}

function relativeKeyForHash(sha256: string): string {
  if (!SHA256.test(sha256)) {
    throw new MediaBlobIntegrityError('Media blob SHA-256 is not canonical');
  }
  return `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

async function identifyFile(
  path: string,
): Promise<Pick<MediaBlobIdentity, 'byteLength' | 'sha256'>> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new MediaBlobIntegrityError('Staged media blob is not a regular file');
  }
  const file = await open(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let byteLength = 0;
  try {
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      byteLength += bytesRead;
    }
  } finally {
    await file.close();
  }
  if (byteLength !== metadata.size) {
    throw new MediaBlobIntegrityError('Media blob changed while it was being read');
  }
  return { byteLength, sha256: hash.digest('hex') };
}

async function assertFileMatches(path: string, expectedHash: string, expectedBytes: number) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new MediaBlobIntegrityError('Media blob is not a regular file');
  }
  if (metadata.size !== expectedBytes) {
    throw new MediaBlobIntegrityError('Media blob byte length does not match its identity');
  }
  const identity = await identifyFile(path);
  if (identity.sha256 !== expectedHash) {
    throw new MediaBlobIntegrityError('Media blob SHA-256 does not match its identity');
  }
  return metadata;
}

async function openRegularFile(path: string, expectedBytes: number): Promise<FileHandle> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, 'ELOOP')) {
      throw new MediaBlobIntegrityError('Media blob must not be a symbolic link');
    }
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== expectedBytes) {
      throw new MediaBlobIntegrityError('Media blob does not match its expected identity');
    }
    return file;
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

async function writeAll(file: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten === 0) {
      throw new Error('Unable to make progress while writing a staged media blob');
    }
    offset += bytesWritten;
  }
}

async function readLeaseEntries(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  });
}

function abortPromise(signal: AbortSignal | undefined) {
  if (!signal) {
    return undefined;
  }
  if (signal.aborted) {
    const promise = Promise.reject<never>(
      signal.reason ?? new DOMException('The media download was aborted', 'AbortError'),
    );
    void promise.catch(() => undefined);
    return {
      promise,
      removeListener: () => undefined,
    };
  }
  let removeListener: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    removeListener = () => signal.removeEventListener('abort', onAbort);
  });
  void promise.catch(() => undefined);
  return { promise, removeListener };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The media download was aborted', 'AbortError');
  }
}

function ignoreAbsentOrNotEmpty(error: unknown): void {
  if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'ENOTEMPTY')) {
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
