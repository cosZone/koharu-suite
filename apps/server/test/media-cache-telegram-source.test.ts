import type { File } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import {
  TelegramMediaSource,
  TelegramMediaSourcePermanentError,
  TelegramMediaSourceTooLargeError,
  TelegramMediaSourceTransientError,
} from '../src/media-cache/telegram-source.js';
import {
  GrammyTelegramApi,
  type GrammyTelegramGetFileClient,
  type TelegramFileApi,
} from '../src/telegram/api.js';

function telegramFile(overrides: Partial<File> = {}): File {
  return {
    file_id: 'telegram-file-id',
    file_path: 'photos/file_42.jpg',
    file_unique_id: 'telegram-file-unique-id',
    ...overrides,
  };
}

function fileApi(file: File): TelegramFileApi {
  return {
    getFile: vi.fn(async () => file),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  if (resolve === undefined) {
    throw new Error('Deferred promise was not initialized');
  }
  return { promise, resolve };
}

async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('TelegramMediaSource', () => {
  it('rejects an already-aborted grammY getFile call before network I/O', async () => {
    const api = new GrammyTelegramApi('123456:secret-token');
    const abortController = new AbortController();
    const reason = new DOMException('stopped', 'AbortError');
    abortController.abort(reason);

    await expect(api.getFile('telegram-file-id', abortController.signal)).rejects.toBe(reason);
  });

  it('bridges caller aborts to an in-flight grammY getFile request', async () => {
    const requestStarted = deferred();
    const downstreamAborted = deferred();
    const getFile = vi.fn<GrammyTelegramGetFileClient['getFile']>(
      (_fileId, signal) =>
        new Promise<File>((_resolve, reject) => {
          requestStarted.resolve();
          signal?.addEventListener(
            'abort',
            () => {
              downstreamAborted.resolve();
              reject(new DOMException('grammY request aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const api = new GrammyTelegramApi('123456:secret-token', {
      getFileClient: { getFile },
    });
    const abortController = new AbortController();
    const addEventListener = vi.spyOn(abortController.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(abortController.signal, 'removeEventListener');
    const reason = new DOMException('caller stopped', 'AbortError');

    const request = api.getFile('telegram-file-id', abortController.signal);
    await requestStarted.promise;
    abortController.abort(reason);

    await expect(downstreamAborted.promise).resolves.toBeUndefined();
    await expect(request).rejects.toBe(reason);
    expect(getFile).toHaveBeenCalledOnce();
    expect(getFile.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(addEventListener).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it('resolves a Telegram file and returns its bytes as a stream', async () => {
    const fetch = vi.fn(async () => new Response('koharu'));
    const source = new TelegramMediaSource({
      api: fileApi(telegramFile({ file_size: 6 })),
      botToken: '123456:secret-token',
      fetch,
    });

    const opened = await source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1024,
    });

    expect(opened.declaredBytes).toBe(6n);
    await expect(read(opened.stream)).resolves.toBe('koharu');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('builds the tokenized URL from a custom API root without exposing it in the result', async () => {
    const api = fileApi(telegramFile({ file_path: 'nested/media file.jpg' }));
    const fetch = vi.fn(async () => new Response('bytes'));
    const signal = new AbortController().signal;
    const source = new TelegramMediaSource({
      api,
      apiRoot: 'http://bot-api.internal:8081/telegram/',
      botToken: '123456:secret-token',
      fetch,
    });

    const opened = await source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1024,
      signal,
    });

    expect(api.getFile).toHaveBeenCalledWith('telegram-file-id', signal);
    expect(fetch).toHaveBeenCalledWith(
      new URL(
        'http://bot-api.internal:8081/telegram/file/bot123456:secret-token/nested/media%20file.jpg',
      ),
      { signal },
    );
    expect(Object.keys(opened).sort()).toEqual(['declaredBytes', 'stream']);
    expect(JSON.stringify(opened)).not.toContain('secret-token');
  });

  it('supports an independent file root for a custom Bot API deployment', async () => {
    const fetch = vi.fn(async () => new Response('bytes'));
    const source = new TelegramMediaSource({
      api: fileApi(telegramFile()),
      apiRoot: 'http://bot-api.internal:8081/api',
      botToken: '123456:secret-token',
      fetch,
      fileRoot: 'http://bot-files.internal:8082/download/',
    });

    await source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1_024,
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://bot-files.internal:8082/download/bot123456:secret-token/photos/file_42.jpg'),
      {},
    );
  });

  it('reports a stable permanent error when getFile omits the download path', async () => {
    const { file_path: _filePath, ...fileWithoutPath } = telegramFile();
    const source = new TelegramMediaSource({
      api: fileApi(fileWithoutPath),
      botToken: '123456:secret-token',
      fetch: vi.fn(),
    });

    const opened = source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1024,
    });

    await expect(opened).rejects.toMatchObject({
      code: 'telegram_media_source_permanent',
      name: 'TelegramMediaSourcePermanentError',
    });
    await expect(opened).rejects.toBeInstanceOf(TelegramMediaSourcePermanentError);
    await expect(opened).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('secret-token'),
    );
  });

  it('rejects Telegram declared sizes over the caller limit before downloading', async () => {
    const fetch = vi.fn();
    const source = new TelegramMediaSource({
      api: fileApi(telegramFile({ file_size: 1_025 })),
      botToken: '123456:secret-token',
      fetch,
    });

    const opened = source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1_024,
    });

    await expect(opened).rejects.toMatchObject({
      code: 'telegram_media_source_too_large',
      declaredBytes: 1_025n,
      maxBytes: 1_024,
      name: 'TelegramMediaSourceTooLargeError',
    });
    await expect(opened).rejects.toBeInstanceOf(TelegramMediaSourceTooLargeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid Telegram declared size (%s) as permanent',
    async (fileSize) => {
      const fetch = vi.fn();
      const source = new TelegramMediaSource({
        api: fileApi(telegramFile({ file_size: fileSize })),
        botToken: '123456:secret-token',
        fetch,
      });

      await expect(
        source.open({
          fileId: 'telegram-file-id',
          maxBytes: 1_024,
        }),
      ).rejects.toMatchObject({
        code: 'telegram_media_source_permanent',
        message: 'Telegram returned an invalid file size',
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('uses a bounded Content-Length advisory and cancels an oversized response body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { file_size: _fileSize, ...fileWithoutSize } = telegramFile();
    const source = new TelegramMediaSource({
      api: fileApi(fileWithoutSize),
      botToken: '123456:secret-token',
      fetch: vi.fn(
        async () =>
          new Response(body, {
            headers: { 'Content-Length': '1025' },
          }),
      ),
    });

    const opened = source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1_024,
    });

    await expect(opened).rejects.toMatchObject({
      code: 'telegram_media_source_too_large',
      declaredBytes: 1_025n,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps the larger advisory when Telegram and Content-Length disagree', async () => {
    const source = new TelegramMediaSource({
      api: fileApi(telegramFile({ file_size: 6 })),
      botToken: '123456:secret-token',
      fetch: vi.fn(
        async () =>
          new Response('koharu-suite', {
            headers: { 'Content-Length': '12' },
          }),
      ),
    });

    const opened = await source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1_024,
    });

    expect(opened.declaredBytes).toBe(12n);
    await expect(read(opened.stream)).resolves.toBe('koharu-suite');
  });

  it.each(['-1', '+1', '1.5', '9007199254740992', '9'.repeat(128)])(
    'ignores an invalid or unbounded Content-Length advisory (%s)',
    async (contentLength) => {
      const { file_size: _fileSize, ...fileWithoutSize } = telegramFile();
      const source = new TelegramMediaSource({
        api: fileApi(fileWithoutSize),
        botToken: '123456:secret-token',
        fetch: vi.fn(
          async () =>
            new Response('bytes', {
              headers: { 'Content-Length': contentLength },
            }),
        ),
      });

      const opened = await source.open({
        fileId: 'telegram-file-id',
        maxBytes: 1_024,
      });

      expect(opened.declaredBytes).toBeNull();
      await expect(read(opened.stream)).resolves.toBe('bytes');
    },
  );

  it('classifies retryable HTTP failures without exposing the tokenized URL', async () => {
    const source = new TelegramMediaSource({
      api: fileApi(telegramFile()),
      botToken: '123456:secret-token',
      fetch: vi.fn(async () => new Response('unavailable', { status: 503 })),
    });

    const opened = source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1_024,
    });

    await expect(opened).rejects.toMatchObject({
      code: 'telegram_media_source_transient',
      name: 'TelegramMediaSourceTransientError',
    });
    await expect(opened).rejects.toBeInstanceOf(TelegramMediaSourceTransientError);
    await expect(opened).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('secret-token'),
    );
  });

  it('sanitizes network failures as stable transient errors', async () => {
    const source = new TelegramMediaSource({
      api: fileApi(telegramFile()),
      botToken: '123456:secret-token',
      fetch: vi.fn(async () => {
        throw new TypeError(
          'fetch failed for https://api.telegram.org/file/bot123456:secret-token/photos/file.jpg',
        );
      }),
    });

    const opened = source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1_024,
    });

    await expect(opened).rejects.toMatchObject({
      code: 'telegram_media_source_transient',
      message: 'Telegram file download request failed',
    });
    await expect(opened).rejects.not.toHaveProperty('cause');
  });

  it('classifies a non-retryable HTTP response as permanent', async () => {
    const source = new TelegramMediaSource({
      api: fileApi(telegramFile()),
      botToken: '123456:secret-token',
      fetch: vi.fn(async () => new Response('not found', { status: 404 })),
    });

    await expect(
      source.open({
        fileId: 'telegram-file-id',
        maxBytes: 1_024,
      }),
    ).rejects.toMatchObject({
      code: 'telegram_media_source_permanent',
      message: 'Telegram file download failed with HTTP 404',
    });
  });

  it('treats a successful response without a body as transient', async () => {
    const source = new TelegramMediaSource({
      api: fileApi(telegramFile()),
      botToken: '123456:secret-token',
      fetch: vi.fn(async () => new Response(null)),
    });

    await expect(
      source.open({
        fileId: 'telegram-file-id',
        maxBytes: 1_024,
      }),
    ).rejects.toMatchObject({
      code: 'telegram_media_source_transient',
      message: 'Telegram file download returned no response body',
    });
  });

  it('classifies getFile client errors as permanent without returning Telegram details', async () => {
    const api: TelegramFileApi = {
      getFile: vi.fn(async () => {
        throw {
          description: 'bad file_id containing secret details',
          error_code: 400,
        };
      }),
    };
    const source = new TelegramMediaSource({
      api,
      botToken: '123456:secret-token',
      fetch: vi.fn(),
    });

    const opened = source.open({
      fileId: 'sensitive-file-id',
      maxBytes: 1_024,
    });

    await expect(opened).rejects.toMatchObject({
      code: 'telegram_media_source_permanent',
      message: 'Telegram getFile request failed',
    });
    await expect(opened).rejects.not.toHaveProperty('description');
    await expect(opened).rejects.not.toHaveProperty('cause');
  });

  it('aborts the returned stream and cancels its upstream body', async () => {
    const cancel = vi.fn();
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        upstreamController = controller;
      },
    });
    const abortController = new AbortController();
    const source = new TelegramMediaSource({
      api: fileApi(telegramFile()),
      botToken: '123456:secret-token',
      fetch: vi.fn(async () => new Response(body)),
    });
    const opened = await source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1_024,
      signal: abortController.signal,
    });
    const reader = opened.stream.getReader();
    const pendingRead = reader.read();
    const reason = new DOMException('stopped', 'AbortError');

    abortController.abort(reason);
    if (cancel.mock.calls.length === 0) {
      upstreamController?.enqueue(Buffer.from('late bytes'));
    }

    await expect(pendingRead).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
  });

  it('forwards response chunks incrementally without buffering the body', async () => {
    const pulls: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const value of ['ko', 'ha', 'ru']) {
          pulls.push(value);
          controller.enqueue(Buffer.from(value));
        }
        controller.close();
      },
    });
    const source = new TelegramMediaSource({
      api: fileApi(telegramFile()),
      botToken: '123456:secret-token',
      fetch: vi.fn(async () => new Response(body)),
    });
    const opened = await source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1_024,
      signal: new AbortController().signal,
    });
    const received: string[] = [];

    for await (const chunk of opened.stream) {
      received.push(Buffer.from(chunk).toString('utf8'));
    }

    expect(pulls).toEqual(['ko', 'ha', 'ru']);
    expect(received).toEqual(['ko', 'ha', 'ru']);
  });

  it('sanitizes response stream failures without exposing the download URL', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(
          new Error(
            'stream failed for https://api.telegram.org/file/bot123456:secret-token/photos/file.jpg',
          ),
        );
      },
    });
    const source = new TelegramMediaSource({
      api: fileApi(telegramFile()),
      botToken: '123456:secret-token',
      fetch: vi.fn(async () => new Response(body)),
    });
    const opened = await source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1_024,
    });

    const reading = read(opened.stream);
    await expect(reading).rejects.toMatchObject({
      code: 'telegram_media_source_transient',
      message: 'Telegram file download stream failed',
    });
    await expect(reading).rejects.not.toHaveProperty('cause');
  });

  it('sanitizes a non-caller AbortError from the download request', async () => {
    const source = new TelegramMediaSource({
      api: fileApi(telegramFile()),
      botToken: '123456:secret-token',
      fetch: vi.fn(async () => {
        throw new DOMException(
          'aborted https://api.telegram.org/file/bot123456:secret-token/photos/file.jpg',
          'AbortError',
        );
      }),
    });

    const opened = source.open({
      fileId: 'telegram-file-id',
      maxBytes: 1_024,
    });

    await expect(opened).rejects.toMatchObject({
      code: 'telegram_media_source_transient',
      message: 'Telegram file download request failed',
    });
    await expect(opened).rejects.not.toHaveProperty('cause');
    await expect(opened).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('secret-token'),
    );
  });
});
