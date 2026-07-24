import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  type DeleteObjectCommandOutput,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  PutObjectCommand,
  type PutObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  type MediaBlobIdentity,
  type MediaBlobReadHandle,
  type MediaBlobReadRange,
  MediaBlobStoreError,
} from './blob-store.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_S3_BLOB_BYTES = 20 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONNECT_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const SHA256_METADATA_KEY = 'koharu-sha256';

export type S3BlobCommand =
  | DeleteObjectCommand
  | GetObjectCommand
  | HeadObjectCommand
  | PutObjectCommand;

export type S3BlobCommandOutput =
  | DeleteObjectCommandOutput
  | GetObjectCommandOutput
  | HeadObjectCommandOutput
  | PutObjectCommandOutput;

export interface S3BlobCommandClient {
  send(
    command: S3BlobCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<S3BlobCommandOutput>;
}

export interface S3BlobBackendCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3BlobBackendOptions {
  bucket: string;
  client?: S3BlobCommandClient;
  connectTimeoutMs?: number;
  credentials?: S3BlobBackendCredentials;
  endpoint?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  region: string;
  requestTimeoutMs?: number;
}

export interface S3BlobOperationOptions {
  signal?: AbortSignal;
}

export interface PutS3BlobInput extends S3BlobOperationOptions {
  identity: MediaBlobIdentity;
  source: ReadableStream<Uint8Array>;
}

export interface S3BlobHead {
  byteLength: number;
  etag?: string;
  lastModified?: Date;
  sha256: string;
}

export interface PutS3BlobResult {
  outcome: 'already_present' | 'created';
}

export type DeleteS3BlobResult = 'absent_or_deleted';

export interface S3HttpHandlerOptions {
  connectionTimeout: number;
  socketTimeout: number;
}

export function s3HttpHandlerOptions(
  options: Pick<S3BlobBackendOptions, 'connectTimeoutMs' | 'requestTimeoutMs'>,
): S3HttpHandlerOptions {
  return {
    connectionTimeout: connectTimeout(options.connectTimeoutMs),
    socketTimeout: requestTimeout(options.requestTimeoutMs),
  };
}

export class S3MediaBlobBackendError extends MediaBlobStoreError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'S3MediaBlobBackendError';
  }
}

export class S3MediaBlobIntegrityError extends S3MediaBlobBackendError {
  constructor(message: string) {
    super('s3_media_blob_integrity_error', message);
    this.name = 'S3MediaBlobIntegrityError';
  }
}

interface S3OperationDeadline {
  beforeTimeout<T>(operation: Promise<T>): Promise<T>;
  dispose(): void;
  error(): S3MediaBlobBackendError;
  signal: AbortSignal;
}

export class S3MediaBlobBackend {
  readonly #bucket: string;
  readonly #client: S3BlobCommandClient;
  readonly #prefix: string;
  readonly #requestTimeoutMs: number;

  constructor(options: S3BlobBackendOptions) {
    this.#bucket = assertNonEmptyBoundedText(options.bucket, 'S3 bucket', 255);
    const region = assertNonEmptyBoundedText(options.region, 'S3 region', 255);
    this.#prefix = canonicalPrefix(options.prefix);
    this.#requestTimeoutMs = requestTimeout(options.requestTimeoutMs);
    const endpoint = validateEndpoint(options.endpoint);
    const httpHandlerOptions = s3HttpHandlerOptions(options);
    this.#client =
      options.client ??
      new AwsS3BlobCommandClient(
        new S3Client({
          ...(options.credentials ? { credentials: options.credentials } : {}),
          ...(endpoint ? { endpoint } : {}),
          forcePathStyle: options.forcePathStyle ?? false,
          region,
          requestChecksumCalculation: 'WHEN_REQUIRED',
          requestHandler: new NodeHttpHandler(httpHandlerOptions),
        }),
      );
  }

  key(identity: MediaBlobIdentity): string {
    assertBlobIdentity(identity);
    return this.#prefix ? `${this.#prefix}/${identity.relativeKey}` : identity.relativeKey;
  }

  async head(
    identity: MediaBlobIdentity,
    options: S3BlobOperationOptions = {},
  ): Promise<S3BlobHead | null> {
    const key = this.key(identity);
    let output: HeadObjectCommandOutput;
    try {
      output = await this.#send<HeadObjectCommandOutput>(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
        options.signal,
      );
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw this.#classifyError(error);
    }
    verifyRemoteMetadata(output, identity);
    return {
      byteLength: identity.byteLength,
      ...(output.ETag ? { etag: output.ETag } : {}),
      ...(output.LastModified ? { lastModified: output.LastModified } : {}),
      sha256: identity.sha256,
    };
  }

  async put(input: PutS3BlobInput): Promise<PutS3BlobResult> {
    const key = this.key(input.identity);
    const body = await readVerifiedSource(input.source, input.identity, input.signal);
    let outcome: PutS3BlobResult['outcome'] = 'created';
    try {
      await this.#send<PutObjectCommandOutput>(
        new PutObjectCommand({
          Body: body,
          Bucket: this.#bucket,
          ContentLength: input.identity.byteLength,
          IfNoneMatch: '*',
          Key: key,
          Metadata: { [SHA256_METADATA_KEY]: input.identity.sha256 },
        }),
        input.signal,
      );
    } catch (error) {
      if (!isConditionalConflict(error)) {
        throw this.#classifyError(error);
      }
      outcome = 'already_present';
    }

    await this.#verifyRemote(input.identity, input.signal);
    return { outcome };
  }

  async read(
    identity: MediaBlobIdentity,
    options: S3BlobOperationOptions = {},
  ): Promise<MediaBlobReadHandle> {
    const head = await this.head(identity, options);
    if (!head) {
      throw new S3MediaBlobBackendError(
        's3_media_blob_not_found',
        'The S3 media blob is unavailable',
      );
    }
    const key = this.key(identity);
    return s3MediaBlobReadHandle(identity.byteLength, (range, signal) =>
      this.#getStream(identity, key, range, mergeSignals(options.signal, signal)),
    );
  }

  async delete(
    identity: MediaBlobIdentity,
    options: S3BlobOperationOptions = {},
  ): Promise<DeleteS3BlobResult> {
    const key = this.key(identity);
    try {
      await this.#send<DeleteObjectCommandOutput>(
        new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }),
        options.signal,
      );
    } catch (error) {
      throw this.#classifyError(error);
    }
    return 'absent_or_deleted';
  }

  async #verifyRemote(identity: MediaBlobIdentity, signal?: AbortSignal): Promise<void> {
    const head = await this.head(identity, signal ? { signal } : {});
    if (!head) {
      throw new S3MediaBlobIntegrityError('The S3 media blob was not visible after publication');
    }
    const key = this.key(identity);
    const stream = await this.#getStream(identity, key, undefined, signal);
    const verified = await consumeAndHash(stream, identity.byteLength, signal);
    if (verified.sha256 !== identity.sha256) {
      throw new S3MediaBlobIntegrityError('The S3 media blob checksum does not match its identity');
    }
  }

  async #send<TOutput extends S3BlobCommandOutput>(
    command: S3BlobCommand,
    signal?: AbortSignal,
  ): Promise<TOutput> {
    const deadline = commandDeadline(signal, this.#requestTimeoutMs);
    try {
      return await this.#sendBeforeDeadline<TOutput>(command, deadline);
    } finally {
      deadline.dispose();
    }
  }

  async #getStream(
    identity: MediaBlobIdentity,
    key: string,
    range: MediaBlobReadRange | undefined,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const deadline = commandDeadline(signal, this.#requestTimeoutMs);
    try {
      const output = await this.#sendBeforeDeadline<GetObjectCommandOutput>(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
        deadline,
      );
      verifyGetResponse(output, identity, range);
      return deadlineBoundByteStream(responseBodyToWebStream(output.Body), deadline);
    } catch (error) {
      deadline.dispose();
      throw this.#classifyError(error);
    }
  }

  async #sendBeforeDeadline<TOutput extends S3BlobCommandOutput>(
    command: S3BlobCommand,
    deadline: S3OperationDeadline,
  ): Promise<TOutput> {
    try {
      return (await deadline.beforeTimeout(
        this.#client.send(command, { abortSignal: deadline.signal }),
      )) as TOutput;
    } catch (error) {
      if (deadline.signal.aborted) {
        throw deadline.error();
      }
      throw error;
    }
  }

  #classifyError(error: unknown): S3MediaBlobBackendError {
    if (error instanceof S3MediaBlobBackendError) {
      return error;
    }
    if (isNotFound(error)) {
      return new S3MediaBlobBackendError(
        's3_media_blob_not_found',
        'The S3 media blob is unavailable',
      );
    }
    if (isConditionalConflict(error)) {
      return new S3MediaBlobIntegrityError(
        'The canonical S3 media key contains conflicting content',
      );
    }
    return new S3MediaBlobBackendError(
      isRetryableServiceError(error)
        ? 's3_media_blob_temporarily_unavailable'
        : 's3_media_blob_request_failed',
      isRetryableServiceError(error)
        ? 'The S3 media backend is temporarily unavailable'
        : 'The S3 media operation failed',
    );
  }
}

class AwsS3BlobCommandClient implements S3BlobCommandClient {
  constructor(private readonly client: S3Client) {}

  async send(
    command: S3BlobCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<S3BlobCommandOutput> {
    return this.client.send(command as never, options as never) as Promise<S3BlobCommandOutput>;
  }
}

function s3MediaBlobReadHandle(
  byteLength: number,
  open: (
    range: MediaBlobReadRange | undefined,
    signal: AbortSignal,
  ) => Promise<ReadableStream<Uint8Array>>,
): MediaBlobReadHandle {
  let consumed = false;
  let closePromise: Promise<void> | undefined;
  let active:
    | {
        abortController: AbortController;
        done: Promise<void>;
        finish: () => void;
        initialization?: Promise<ReadableStreamDefaultReader<Uint8Array>>;
        reader?: ReadableStreamDefaultReader<Uint8Array>;
      }
    | undefined;

  const close = (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    consumed = true;
    active?.abortController.abort();
    closePromise = (async () => {
      try {
        let reader = active?.reader;
        if (!reader) {
          reader = await active?.initialization?.catch(() => undefined);
        }
        await reader?.cancel().catch(() => undefined);
      } finally {
        active?.finish();
      }
      await active?.done;
    })();
    return closePromise;
  };

  return {
    byteLength,
    close,
    stream(range) {
      if (consumed || closePromise) {
        throw new MediaBlobStoreError(
          'media_blob_read_handle_consumed',
          'Media blob read handle was already consumed or closed',
        );
      }
      if (range) {
        assertMediaBlobReadRange(range, byteLength);
      }
      consumed = true;
      const expectedBytes = range ? range.end - range.start + 1 : byteLength;
      const abortController = new AbortController();
      let finish: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      active = { abortController, done, finish };
      let readBytes = 0;
      const initialization = open(range, abortController.signal).then((stream) => {
        const reader = stream.getReader();
        if (active) {
          active.reader = reader;
        }
        return reader;
      });
      active.initialization = initialization;

      return new ReadableStream<Uint8Array>({
        async cancel() {
          abortController.abort();
          try {
            const reader = await initialization;
            await reader.cancel();
          } catch {
            // A cancelled consumer must not receive provider diagnostics.
          } finally {
            finish();
          }
        },
        async pull(controller) {
          try {
            const reader = await initialization;
            const result = await reader.read();
            if (result.done) {
              if (readBytes !== expectedBytes) {
                throw new S3MediaBlobIntegrityError(
                  'The S3 media blob ended before its expected byte length',
                );
              }
              controller.close();
              finish();
              return;
            }
            readBytes += result.value.byteLength;
            if (readBytes > expectedBytes) {
              await reader.cancel().catch(() => undefined);
              throw new S3MediaBlobIntegrityError(
                'The S3 media blob exceeded its expected byte length',
              );
            }
            controller.enqueue(result.value);
          } catch (error) {
            finish();
            controller.error(
              error instanceof S3MediaBlobBackendError
                ? error
                : new S3MediaBlobBackendError(
                    's3_media_blob_stream_failed',
                    'The S3 media blob stream became unavailable',
                  ),
            );
          }
        },
      });
    },
  };
}

function assertMediaBlobReadRange(range: MediaBlobReadRange, byteLength: number): void {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end >= byteLength
  ) {
    throw new RangeError('Media blob read range must be an inclusive range within the blob');
  }
}

function assertBlobIdentity(identity: MediaBlobIdentity): void {
  if (
    !Number.isSafeInteger(identity.byteLength) ||
    identity.byteLength < 0 ||
    identity.byteLength > MAX_S3_BLOB_BYTES
  ) {
    throw new S3MediaBlobIntegrityError('The S3 media blob byte length is invalid');
  }
  const relativeKey = relativeKeyForHash(identity.sha256);
  if (identity.relativeKey !== relativeKey) {
    throw new S3MediaBlobIntegrityError('The S3 media blob identity is not canonical');
  }
}

function relativeKeyForHash(sha256: string): string {
  if (!SHA256.test(sha256)) {
    throw new S3MediaBlobIntegrityError('The S3 media blob SHA-256 is not canonical');
  }
  return `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

function canonicalPrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === '') {
    return '';
  }
  if (
    prefix.length > 512 ||
    prefix.startsWith('/') ||
    prefix.endsWith('/') ||
    prefix.includes('\\') ||
    prefix.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    containsControlCharacter(prefix)
  ) {
    throw new TypeError('S3 media prefix must be a canonical relative key prefix');
  }
  return prefix;
}

function validateEndpoint(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError('S3 endpoint must be an absolute HTTP or HTTPS URL');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError('S3 endpoint must be an absolute HTTP or HTTPS URL without credentials');
  }
  return parsed.toString();
}

function requestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_REQUEST_TIMEOUT_MS) {
    throw new TypeError(`S3 request timeout must be between 1 and ${MAX_REQUEST_TIMEOUT_MS}ms`);
  }
  return timeout;
}

function connectTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_CONNECT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 250 || timeout > MAX_CONNECT_TIMEOUT_MS) {
    throw new TypeError(`S3 connect timeout must be between 250 and ${MAX_CONNECT_TIMEOUT_MS}ms`);
  }
  return timeout;
}

function assertNonEmptyBoundedText(value: string, label: string, maxLength: number): string {
  if (!value || value.length > maxLength || containsControlCharacter(value)) {
    throw new TypeError(`${label} must contain 1-${maxLength} printable characters`);
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

async function readVerifiedSource(
  source: ReadableStream<Uint8Array>,
  identity: MediaBlobIdentity,
  signal?: AbortSignal,
): Promise<Buffer> {
  assertBlobIdentity(identity);
  if (signal?.aborted) {
    throw new S3MediaBlobBackendError(
      's3_media_blob_aborted',
      'The S3 media operation was cancelled',
    );
  }
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  const hash = createHash('sha256');
  let byteLength = 0;
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw new S3MediaBlobBackendError(
          's3_media_blob_aborted',
          'The S3 media operation was cancelled',
        );
      }
      const result = await reader.read();
      if (result.done) {
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > identity.byteLength) {
        throw new S3MediaBlobIntegrityError(
          'The S3 media upload exceeded its expected byte length',
        );
      }
      hash.update(result.value);
      chunks.push(result.value);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  if (signal?.aborted) {
    throw new S3MediaBlobBackendError(
      's3_media_blob_aborted',
      'The S3 media operation was cancelled',
    );
  }
  if (byteLength !== identity.byteLength) {
    throw new S3MediaBlobIntegrityError(
      'The S3 media upload ended before its expected byte length',
    );
  }
  if (hash.digest('hex') !== identity.sha256) {
    throw new S3MediaBlobIntegrityError('The S3 media upload checksum does not match its identity');
  }
  return Buffer.concat(chunks, byteLength);
}

function verifyRemoteMetadata(
  output: Pick<HeadObjectCommandOutput | GetObjectCommandOutput, 'ContentLength' | 'Metadata'>,
  identity: MediaBlobIdentity,
): void {
  if (
    output.ContentLength !== identity.byteLength ||
    output.Metadata?.[SHA256_METADATA_KEY] !== identity.sha256
  ) {
    throw new S3MediaBlobIntegrityError('The canonical S3 media key contains conflicting metadata');
  }
}

function verifyGetResponse(
  output: GetObjectCommandOutput,
  identity: MediaBlobIdentity,
  range?: MediaBlobReadRange,
): void {
  if (!output.Body) {
    throw new S3MediaBlobIntegrityError('The S3 media response has no body');
  }
  if (output.Metadata?.[SHA256_METADATA_KEY] !== identity.sha256) {
    throw new S3MediaBlobIntegrityError('The S3 media response has conflicting metadata');
  }
  const expectedLength = range ? range.end - range.start + 1 : identity.byteLength;
  if (output.ContentLength !== expectedLength) {
    throw new S3MediaBlobIntegrityError('The S3 media response has an invalid byte length');
  }
  if (range && output.ContentRange !== `bytes ${range.start}-${range.end}/${identity.byteLength}`) {
    throw new S3MediaBlobIntegrityError('The S3 media backend did not honor the requested range');
  }
}

async function consumeAndHash(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<{ sha256: string }> {
  const reader = stream.getReader();
  const hash = createHash('sha256');
  let byteLength = 0;
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw new S3MediaBlobBackendError(
          's3_media_blob_aborted',
          'The S3 media operation was cancelled',
        );
      }
      const result = await reader.read();
      if (result.done) {
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > expectedBytes) {
        throw new S3MediaBlobIntegrityError('The S3 media blob exceeded its expected byte length');
      }
      hash.update(result.value);
    }
  } catch (error) {
    if (error instanceof S3MediaBlobBackendError) {
      throw error;
    }
    throw new S3MediaBlobBackendError(
      's3_media_blob_stream_failed',
      'The S3 media blob stream became unavailable',
    );
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  if (signal?.aborted) {
    throw new S3MediaBlobBackendError(
      's3_media_blob_aborted',
      'The S3 media operation was cancelled',
    );
  }
  if (byteLength !== expectedBytes) {
    throw new S3MediaBlobIntegrityError('The S3 media blob ended before its expected byte length');
  }
  return { sha256: hash.digest('hex') };
}

function responseBodyToWebStream(body: GetObjectCommandOutput['Body']): ReadableStream<Uint8Array> {
  if (!body) {
    throw new S3MediaBlobIntegrityError('The S3 media response has no body');
  }
  if (body instanceof ReadableStream) {
    return body;
  }
  if (body instanceof Readable) {
    return Readable.toWeb(body) as ReadableStream<Uint8Array>;
  }
  if ('transformToWebStream' in body && typeof body.transformToWebStream === 'function') {
    try {
      return body.transformToWebStream();
    } catch {
      throw new S3MediaBlobBackendError(
        's3_media_blob_stream_failed',
        'The S3 media blob stream became unavailable',
      );
    }
  }
  if (Symbol.asyncIterator in body) {
    const iterator = (body as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async cancel() {
        await iterator.return?.();
      },
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            return;
          }
          controller.enqueue(
            typeof next.value === 'string' ? Buffer.from(next.value) : Buffer.from(next.value),
          );
        } catch {
          controller.error(
            new S3MediaBlobBackendError(
              's3_media_blob_stream_failed',
              'The S3 media blob stream became unavailable',
            ),
          );
        }
      },
    });
  }
  throw new S3MediaBlobIntegrityError('The S3 media response body is not streamable');
}

function deadlineBoundByteStream(
  stream: ReadableStream<Uint8Array>,
  deadline: S3OperationDeadline,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  const abortBody = () => {
    void reader.cancel().catch(() => undefined);
  };
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    deadline.signal.removeEventListener('abort', abortBody);
    deadline.dispose();
    try {
      reader.releaseLock();
    } catch {
      // A pending read keeps the lock until provider cancellation settles.
    }
  };
  deadline.signal.addEventListener('abort', abortBody, { once: true });

  return new ReadableStream<Uint8Array>({
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
    async pull(controller) {
      try {
        const result = await beforeDeadline(reader.read(), deadline);
        if (result.done) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        abortBody();
        finish();
        controller.error(
          error instanceof S3MediaBlobBackendError
            ? error
            : new S3MediaBlobBackendError(
                's3_media_blob_stream_failed',
                'The S3 media blob stream became unavailable',
              ),
        );
      }
    },
  });
}

function beforeDeadline<T>(operation: Promise<T>, deadline: S3OperationDeadline): Promise<T> {
  if (deadline.signal.aborted) {
    return Promise.reject(deadline.error());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(deadline.error());
    };
    deadline.signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        deadline.signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        deadline.signal.removeEventListener('abort', abort);
        reject(deadline.signal.aborted ? deadline.error() : error);
      },
    );
  });
}

function commandDeadline(parent: AbortSignal | undefined, timeoutMs: number): S3OperationDeadline {
  const controller = new AbortController();
  let timedOut = false;
  let notifyTimeout: () => void = () => undefined;
  const timeoutReached = new Promise<void>((resolve) => {
    notifyTimeout = resolve;
  });
  const abortFromParent = () => controller.abort();
  if (parent?.aborted) {
    controller.abort();
  } else {
    parent?.addEventListener('abort', abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    notifyTimeout();
  }, timeoutMs);
  timeout.unref();
  return {
    beforeTimeout<T>(operation: Promise<T>): Promise<T> {
      return Promise.race([
        operation,
        timeoutReached.then(() => {
          throw new S3MediaBlobBackendError(
            's3_media_blob_timeout',
            'The S3 media operation exceeded its deadline',
          );
        }),
      ]);
    },
    dispose() {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abortFromParent);
    },
    error() {
      return timedOut
        ? new S3MediaBlobBackendError(
            's3_media_blob_timeout',
            'The S3 media operation exceeded its deadline',
          )
        : new S3MediaBlobBackendError(
            's3_media_blob_aborted',
            'The S3 media operation was cancelled',
          );
    },
    signal: controller.signal,
  };
}

function mergeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => signal !== undefined));
}

function isNotFound(error: unknown): boolean {
  return (
    serviceStatus(error) === 404 ||
    serviceName(error) === 'NoSuchKey' ||
    serviceName(error) === 'NotFound'
  );
}

function isConditionalConflict(error: unknown): boolean {
  const status = serviceStatus(error);
  return status === 409 || status === 412;
}

function isRetryableServiceError(error: unknown): boolean {
  const status = serviceStatus(error);
  return status === 408 || status === 429 || (status !== undefined && status >= 500);
}

function serviceStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('$metadata' in error)) {
    return undefined;
  }
  const metadata = error.$metadata;
  if (!metadata || typeof metadata !== 'object' || !('httpStatusCode' in metadata)) {
    return undefined;
  }
  return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}

function serviceName(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('name' in error)) {
    return undefined;
  }
  return typeof error.name === 'string' ? error.name : undefined;
}
