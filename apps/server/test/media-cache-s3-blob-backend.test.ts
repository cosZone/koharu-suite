import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  PutObjectCommand,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { MediaBlobIdentity } from '../src/media-cache/blob-store.js';
import {
  type S3BlobCommand,
  type S3BlobCommandClient,
  type S3BlobCommandOutput,
  S3MediaBlobBackend,
  S3MediaBlobBackendError,
  S3MediaBlobIntegrityError,
  s3HttpHandlerOptions,
} from '../src/media-cache/s3-blob-backend.js';

class FakeS3Client implements S3BlobCommandClient {
  readonly calls: Array<{ command: S3BlobCommand; signal?: AbortSignal }> = [];

  constructor(
    private readonly handler: (
      command: S3BlobCommand,
      signal?: AbortSignal,
    ) => Promise<S3BlobCommandOutput>,
  ) {}

  async send(
    command: S3BlobCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<S3BlobCommandOutput> {
    this.calls.push({
      command,
      ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
    });
    return this.handler(command, options?.abortSignal);
  }
}

function fixture(
  handler: (command: S3BlobCommand, signal?: AbortSignal) => Promise<S3BlobCommandOutput>,
  overrides: Partial<ConstructorParameters<typeof S3MediaBlobBackend>[0]> = {},
) {
  const client = new FakeS3Client(handler);
  const backend = new S3MediaBlobBackend({
    bucket: 'koharu-media',
    client,
    endpoint: 'http://127.0.0.1:9000',
    forcePathStyle: true,
    prefix: 'suite/v1',
    region: 'us-east-1',
    ...overrides,
  });
  return { backend, client };
}

function identity(content: string): MediaBlobIdentity {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    byteLength: Buffer.byteLength(content),
    relativeKey: `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`,
    sha256,
  };
}

function bytes(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(content));
      controller.close();
    },
  });
}

function getOutput(
  content: string,
  blob: MediaBlobIdentity,
  range?: { end: number; start: number },
): GetObjectCommandOutput {
  const selected = range ? content.slice(range.start, range.end + 1) : content;
  return {
    $metadata: {},
    Body: bytes(selected) as NonNullable<GetObjectCommandOutput['Body']>,
    ContentLength: Buffer.byteLength(selected),
    ...(range ? { ContentRange: `bytes ${range.start}-${range.end}/${blob.byteLength}` } : {}),
    Metadata: { 'koharu-sha256': blob.sha256 },
  };
}

function headOutput(blob: MediaBlobIdentity): HeadObjectCommandOutput {
  return {
    $metadata: {},
    ContentLength: blob.byteLength,
    ETag: '"transport-only-etag"',
    Metadata: { 'koharu-sha256': blob.sha256 },
  };
}

function serviceError(status: number, message = 'private provider diagnostics'): Error {
  const error = new Error(message) as Error & {
    $metadata: { httpStatusCode: number; requestId: string };
  };
  error.$metadata = { httpStatusCode: status, requestId: 'private-request-id' };
  return error;
}

function emptyOutput(): S3BlobCommandOutput {
  return { $metadata: {} };
}

describe('S3MediaBlobBackend', () => {
  it('publishes with create-only semantics and verifies the complete remote object', async () => {
    const content = 'durable koharu blob';
    const blob = identity(content);
    const { backend, client } = fixture(async (command) => {
      if (command instanceof PutObjectCommand) {
        return { $metadata: {} } satisfies PutObjectCommandOutput;
      }
      if (command instanceof HeadObjectCommand) {
        return headOutput(blob);
      }
      if (command instanceof GetObjectCommand) {
        return getOutput(content, blob);
      }
      throw new Error('unexpected command');
    });

    await expect(backend.put({ identity: blob, source: bytes(content) })).resolves.toEqual({
      outcome: 'created',
    });

    const put = client.calls[0]?.command;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect((put as PutObjectCommand).input).toMatchObject({
      Bucket: 'koharu-media',
      ContentLength: blob.byteLength,
      IfNoneMatch: '*',
      Key: `suite/v1/${blob.relativeKey}`,
      Metadata: { 'koharu-sha256': blob.sha256 },
    });
    expect(Buffer.from((put as PutObjectCommand).input.Body as Uint8Array).toString()).toBe(
      content,
    );
    expect(client.calls.map(({ command }) => command.constructor)).toEqual([
      PutObjectCommand,
      HeadObjectCommand,
      GetObjectCommand,
    ]);
  });

  it('treats a conditional collision as idempotent only after HEAD and full verification', async () => {
    const content = 'already durable';
    const blob = identity(content);
    const { backend, client } = fixture(async (command) => {
      if (command instanceof PutObjectCommand) {
        throw serviceError(412);
      }
      if (command instanceof HeadObjectCommand) {
        return headOutput(blob);
      }
      if (command instanceof GetObjectCommand) {
        return getOutput(content, blob);
      }
      throw new Error('unexpected command');
    });

    await expect(backend.put({ identity: blob, source: bytes(content) })).resolves.toEqual({
      outcome: 'already_present',
    });
    expect(client.calls.filter(({ command }) => command instanceof PutObjectCommand)).toHaveLength(
      1,
    );
  });

  it('never overwrites a conditional collision with conflicting metadata', async () => {
    const content = 'expected';
    const blob = identity(content);
    const { backend, client } = fixture(async (command) => {
      if (command instanceof PutObjectCommand) {
        throw serviceError(409);
      }
      if (command instanceof HeadObjectCommand) {
        return {
          ...headOutput(blob),
          Metadata: { 'koharu-sha256': '0'.repeat(64) },
        };
      }
      throw new Error('unexpected command');
    });

    await expect(backend.put({ identity: blob, source: bytes(content) })).rejects.toBeInstanceOf(
      S3MediaBlobIntegrityError,
    );
    expect(client.calls.filter(({ command }) => command instanceof PutObjectCommand)).toHaveLength(
      1,
    );
  });

  it('rejects a post-write body checksum mismatch despite matching metadata and length', async () => {
    const content = 'expected';
    const blob = identity(content);
    const { backend } = fixture(async (command) => {
      if (command instanceof PutObjectCommand) {
        return emptyOutput();
      }
      if (command instanceof HeadObjectCommand) {
        return headOutput(blob);
      }
      if (command instanceof GetObjectCommand) {
        return getOutput('tampered', blob);
      }
      throw new Error('unexpected command');
    });

    await expect(backend.put({ identity: blob, source: bytes(content) })).rejects.toThrow(
      'checksum does not match',
    );
  });

  it('rejects a short post-write body even when the provider claims the expected length', async () => {
    const content = 'expected content';
    const blob = identity(content);
    const { backend } = fixture(async (command) => {
      if (command instanceof PutObjectCommand) {
        return emptyOutput();
      }
      if (command instanceof HeadObjectCommand) {
        return headOutput(blob);
      }
      if (command instanceof GetObjectCommand) {
        return {
          ...getOutput(content, blob),
          Body: bytes('short') as NonNullable<GetObjectCommandOutput['Body']>,
        };
      }
      throw new Error('unexpected command');
    });

    await expect(backend.put({ identity: blob, source: bytes(content) })).rejects.toThrow(
      'ended before its expected byte length',
    );
  });

  it('redacts a provider response stream failure during post-write verification', async () => {
    const content = 'expected content';
    const blob = identity(content);
    const { backend } = fixture(async (command) => {
      if (command instanceof PutObjectCommand) {
        return emptyOutput();
      }
      if (command instanceof HeadObjectCommand) {
        return headOutput(blob);
      }
      if (command instanceof GetObjectCommand) {
        return {
          ...getOutput(content, blob),
          Body: new ReadableStream<Uint8Array>({
            pull() {
              throw new Error('https://key:secret@private.example/bucket/key');
            },
          }) as NonNullable<GetObjectCommandOutput['Body']>,
        };
      }
      throw new Error('unexpected command');
    });

    await expect(backend.put({ identity: blob, source: bytes(content) })).rejects.toMatchObject({
      code: 's3_media_blob_stream_failed',
      message: 'The S3 media blob stream became unavailable',
    });
  });

  it('times out and cancels a stalled post-write verification body', async () => {
    const content = 'stalled verification';
    const blob = identity(content);
    const cancel = vi.fn();
    const { backend } = fixture(
      async (command) => {
        if (command instanceof PutObjectCommand) {
          return emptyOutput();
        }
        if (command instanceof HeadObjectCommand) {
          return headOutput(blob);
        }
        if (command instanceof GetObjectCommand) {
          return {
            ...getOutput(content, blob),
            Body: new ReadableStream<Uint8Array>({
              cancel,
              pull: () => new Promise(() => undefined),
            }) as NonNullable<GetObjectCommandOutput['Body']>,
          };
        }
        throw new Error('unexpected command');
      },
      { requestTimeoutMs: 10 },
    );

    await expect(backend.put({ identity: blob, source: bytes(content) })).rejects.toMatchObject({
      code: 's3_media_blob_timeout',
      message: 'The S3 media operation exceeded its deadline',
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('validates the complete upload source before issuing PutObject', async () => {
    const blob = identity('expected content');
    const { backend, client } = fixture(async () => emptyOutput());

    await expect(backend.put({ identity: blob, source: bytes('short') })).rejects.toThrow(
      'ended before its expected byte length',
    );
    expect(client.calls).toEqual([]);

    const sameLengthMismatch = 'xxxxxxxxxxxxxxxx';
    expect(Buffer.byteLength(sameLengthMismatch)).toBe(blob.byteLength);
    await expect(
      backend.put({ identity: blob, source: bytes(sameLengthMismatch) }),
    ).rejects.toThrow('upload checksum does not match');
    expect(client.calls).toEqual([]);
  });

  it('reads one inclusive range through a single-use cancellable handle', async () => {
    const content = '0123456789';
    const blob = identity(content);
    const { backend, client } = fixture(async (command) => {
      if (command instanceof HeadObjectCommand) {
        return headOutput(blob);
      }
      if (command instanceof GetObjectCommand) {
        return getOutput(content, blob, { end: 6, start: 3 });
      }
      throw new Error('unexpected command');
    });
    const handle = await backend.read(blob);
    const stream = handle.stream({ end: 6, start: 3 });

    await expect(new Response(stream).text()).resolves.toBe('3456');
    const get = client.calls.find(({ command }) => command instanceof GetObjectCommand)?.command;
    expect(get).toBeInstanceOf(GetObjectCommand);
    expect((get as GetObjectCommand).input.Range).toBe('bytes=3-6');
    expect(() => handle.stream()).toThrow('already consumed or closed');
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('cancels an in-flight GetObject when the read handle closes', async () => {
    const blob = identity('close pending read');
    let getSignal: AbortSignal | undefined;
    const { backend } = fixture(async (command, signal) => {
      if (command instanceof HeadObjectCommand) {
        return headOutput(blob);
      }
      if (command instanceof GetObjectCommand) {
        getSignal = signal;
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('private abort detail')), {
            once: true,
          });
        });
      }
      throw new Error('unexpected command');
    });
    const handle = await backend.read(blob);
    const reader = handle.stream().getReader();
    const pending = reader.read();

    await vi.waitFor(() => expect(getSignal).toBeDefined());
    await expect(handle.close()).resolves.toBeUndefined();
    expect(getSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('times out and cancels a stalled normal read body after response headers', async () => {
    const content = 'stalled public read';
    const blob = identity(content);
    const cancel = vi.fn();
    const { backend } = fixture(
      async (command) => {
        if (command instanceof HeadObjectCommand) {
          return headOutput(blob);
        }
        if (command instanceof GetObjectCommand) {
          return {
            ...getOutput(content, blob),
            Body: new ReadableStream<Uint8Array>({
              cancel,
              pull: () => new Promise(() => undefined),
            }) as NonNullable<GetObjectCommandOutput['Body']>,
          };
        }
        throw new Error('unexpected command');
      },
      { requestTimeoutMs: 10 },
    );
    const handle = await backend.read(blob);

    await expect(new Response(handle.stream()).arrayBuffer()).rejects.toMatchObject({
      code: 's3_media_blob_timeout',
      message: 'The S3 media operation exceeded its deadline',
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('waits for pending GetObject abort cleanup before close resolves', async () => {
    const blob = identity('delayed close cleanup');
    let cleanupDone = false;
    let getStarted = false;
    const { backend } = fixture(
      async (command, signal) => {
        if (command instanceof HeadObjectCommand) {
          return headOutput(blob);
        }
        if (command instanceof GetObjectCommand) {
          getStarted = true;
          return new Promise((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                setTimeout(() => {
                  cleanupDone = true;
                  reject(new Error('private delayed cleanup detail'));
                }, 20);
              },
              { once: true },
            );
          });
        }
        throw new Error('unexpected command');
      },
      { requestTimeoutMs: 100 },
    );
    const handle = await backend.read(blob);
    const reader = handle.stream().getReader();
    const pending = reader.read();
    await vi.waitFor(() => expect(getStarted).toBe(true));

    const closing = handle.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cleanupDone).toBe(false);
    await expect(closing).resolves.toBeUndefined();
    expect(cleanupDone).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 's3_media_blob_aborted' });
  });

  it('honors caller abort and an internal command deadline with stable errors', async () => {
    const blob = identity('abort me');
    const handler = async (
      _command: S3BlobCommand,
      signal?: AbortSignal,
    ): Promise<S3BlobCommandOutput> =>
      new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('secret endpoint')), {
          once: true,
        });
      });

    const caller = new AbortController();
    const callerFixture = fixture(handler);
    const pending = callerFixture.backend.head(blob, { signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 's3_media_blob_aborted',
      message: 'The S3 media operation was cancelled',
    });

    const deadlineFixture = fixture(handler, { requestTimeoutMs: 5 });
    await expect(deadlineFixture.backend.head(blob)).rejects.toMatchObject({
      code: 's3_media_blob_timeout',
      message: 'The S3 media operation exceeded its deadline',
    });
  });

  it('returns null for absence and redacts provider diagnostics from other failures', async () => {
    const blob = identity('redaction');
    const absent = fixture(async () => {
      throw serviceError(404, 'https://key:secret@private.example/bucket/key');
    });
    await expect(absent.backend.head(blob)).resolves.toBeNull();

    const failing = fixture(async () => {
      throw serviceError(503, 'https://key:secret@private.example/bucket/key');
    });
    let error: unknown;
    try {
      await failing.backend.head(blob);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(S3MediaBlobBackendError);
    expect(error).toMatchObject({
      code: 's3_media_blob_temporarily_unavailable',
      message: 'The S3 media backend is temporarily unavailable',
    });
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(String(error)).not.toContain('private.example');
  });

  it('issues an idempotent canonical DeleteObject command', async () => {
    const blob = identity('delete');
    const { backend, client } = fixture(async (command) => {
      if (command instanceof DeleteObjectCommand) {
        return emptyOutput();
      }
      throw new Error('unexpected command');
    });

    await expect(backend.delete(blob)).resolves.toBe('absent_or_deleted');
    const command = client.calls[0]?.command;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect((command as DeleteObjectCommand).input).toEqual({
      Bucket: 'koharu-media',
      Key: `suite/v1/${blob.relativeKey}`,
    });
  });

  it('rejects prefix traversal and non-canonical blob keys before any request', () => {
    const client = new FakeS3Client(async () => emptyOutput());
    for (const prefix of [
      '../escape',
      'safe/../escape',
      '/absolute',
      'trailing/',
      'double//slash',
    ]) {
      expect(
        () =>
          new S3MediaBlobBackend({
            bucket: 'bucket',
            client,
            prefix,
            region: 'us-east-1',
          }),
      ).toThrow('canonical relative key prefix');
    }

    const blob = identity('canonical');
    const { backend } = fixture(async () => emptyOutput());
    expect(() => backend.key({ ...blob, relativeKey: '../escape' })).toThrow(
      'identity is not canonical',
    );
    expect(client.calls).toEqual([]);
  });

  it('builds explicit bounded Node HTTP connection and socket timeout options', () => {
    expect(s3HttpHandlerOptions({})).toEqual({
      connectionTimeout: 5_000,
      socketTimeout: 30_000,
    });
    expect(s3HttpHandlerOptions({ connectTimeoutMs: 2_500, requestTimeoutMs: 45_000 })).toEqual({
      connectionTimeout: 2_500,
      socketTimeout: 45_000,
    });
    expect(() => s3HttpHandlerOptions({ connectTimeoutMs: 249 })).toThrow(
      'connect timeout must be between 250',
    );
  });
});
