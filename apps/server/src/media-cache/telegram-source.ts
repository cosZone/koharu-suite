import type { TelegramFileApi } from '../telegram/api.js';

const DEFAULT_TELEGRAM_API_ROOT = 'https://api.telegram.org';
const MAX_SAFE_CONTENT_LENGTH = BigInt(Number.MAX_SAFE_INTEGER);

export interface TelegramMediaSourceOptions {
  api: TelegramFileApi;
  botToken: string;
  apiRoot?: string;
  fileRoot?: string;
  fetch?: typeof globalThis.fetch;
}

export interface OpenTelegramMediaInput {
  fileId: string;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface OpenedTelegramMedia {
  declaredBytes: bigint | null;
  stream: ReadableStream<Uint8Array>;
}

export class TelegramMediaSourcePermanentError extends Error {
  readonly code = 'telegram_media_source_permanent';

  constructor(message: string) {
    super(message);
    this.name = 'TelegramMediaSourcePermanentError';
  }
}

export class TelegramMediaSourceTransientError extends Error {
  readonly code = 'telegram_media_source_transient';

  constructor(message: string) {
    super(message);
    this.name = 'TelegramMediaSourceTransientError';
  }
}

export class TelegramMediaSourceTooLargeError extends Error {
  readonly code = 'telegram_media_source_too_large';

  constructor(
    readonly maxBytes: number,
    readonly declaredBytes: bigint,
  ) {
    super(`Telegram media source exceeds the ${maxBytes}-byte caller limit`);
    this.name = 'TelegramMediaSourceTooLargeError';
  }
}

function downloadUrl(options: {
  apiRoot: string;
  botToken: string;
  filePath: string;
  fileRoot?: string;
}): URL {
  const root = new URL(options.fileRoot ?? `${options.apiRoot.replace(/\/+$/u, '')}/file`);
  const rootPath = root.pathname.replace(/\/+$/u, '');
  root.pathname = `${rootPath}/bot${options.botToken}/${options.filePath}`;
  return root;
}

function parseContentLength(headers: Headers): bigint | null {
  const value = headers.get('content-length')?.trim();
  if (value === undefined || !/^\d+$/u.test(value) || value.length > 16) {
    return null;
  }
  const parsed = BigInt(value);
  return parsed <= MAX_SAFE_CONTENT_LENGTH ? parsed : null;
}

async function cancelQuietly(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await stream?.cancel();
  } catch {
    // The classification error is more useful than a secondary cancellation failure.
  }
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function telegramErrorStatus(error: unknown): number | null {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('error_code' in error) ||
    typeof error.error_code !== 'number'
  ) {
    return null;
  }
  return error.error_code;
}

function cancellableStream(
  source: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;

  const cleanup = () => {
    signal?.removeEventListener('abort', abort);
  };
  const abort = () => {
    if (finished) {
      return;
    }
    finished = true;
    const reason =
      signal?.reason ?? new DOMException('Telegram media stream aborted', 'AbortError');
    controller?.error(reason);
    void reader.cancel(reason).catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    cancel: async (reason) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      await reader.cancel(reason);
    },
    async pull(streamController) {
      try {
        const next = await reader.read();
        if (finished) {
          return;
        }
        if (next.done) {
          finished = true;
          cleanup();
          streamController.close();
          return;
        }
        streamController.enqueue(next.value);
      } catch {
        if (!finished) {
          finished = true;
          cleanup();
          streamController.error(
            signal?.aborted
              ? signal.reason
              : new TelegramMediaSourceTransientError('Telegram file download stream failed'),
          );
        }
      }
    },
    start(streamController) {
      controller = streamController;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
      }
    },
  });
}

export class TelegramMediaSource {
  private readonly api: TelegramFileApi;
  private readonly apiRoot: string;
  private readonly botToken: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly fileRoot: string | undefined;

  constructor(options: TelegramMediaSourceOptions) {
    this.api = options.api;
    this.apiRoot = options.apiRoot ?? DEFAULT_TELEGRAM_API_ROOT;
    this.botToken = options.botToken;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.fileRoot = options.fileRoot;
  }

  async open(input: OpenTelegramMediaInput): Promise<OpenedTelegramMedia> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
      throw new TypeError('Telegram media maxBytes must be a nonnegative safe integer');
    }
    input.signal?.throwIfAborted();
    let file: Awaited<ReturnType<TelegramFileApi['getFile']>>;
    try {
      file = await this.api.getFile(input.fileId, input.signal);
    } catch (error) {
      if (input.signal?.aborted) {
        throw input.signal.reason;
      }
      const status = telegramErrorStatus(error);
      if (status !== null && !isTransientHttpStatus(status)) {
        throw new TelegramMediaSourcePermanentError('Telegram getFile request failed');
      }
      throw new TelegramMediaSourceTransientError('Telegram getFile request failed');
    }
    if (!file.file_path) {
      throw new TelegramMediaSourcePermanentError('Telegram did not return a file path');
    }
    if (
      file.file_size !== undefined &&
      (!Number.isSafeInteger(file.file_size) || file.file_size < 0)
    ) {
      throw new TelegramMediaSourcePermanentError('Telegram returned an invalid file size');
    }
    const telegramDeclaredBytes = file.file_size === undefined ? null : BigInt(file.file_size);
    if (telegramDeclaredBytes !== null && telegramDeclaredBytes > BigInt(input.maxBytes)) {
      throw new TelegramMediaSourceTooLargeError(input.maxBytes, telegramDeclaredBytes);
    }
    let response: Response;
    try {
      response = await this.fetch(
        downloadUrl({
          apiRoot: this.apiRoot,
          botToken: this.botToken,
          filePath: file.file_path,
          ...(this.fileRoot ? { fileRoot: this.fileRoot } : {}),
        }),
        input.signal ? { signal: input.signal } : {},
      );
    } catch {
      if (input.signal?.aborted) {
        throw input.signal.reason;
      }
      throw new TelegramMediaSourceTransientError('Telegram file download request failed');
    }
    if (!response.ok) {
      await cancelQuietly(response.body);
      const message = `Telegram file download failed with HTTP ${response.status}`;
      if (isTransientHttpStatus(response.status)) {
        throw new TelegramMediaSourceTransientError(message);
      }
      throw new TelegramMediaSourcePermanentError(message);
    }
    if (!response.body) {
      throw new TelegramMediaSourceTransientError(
        'Telegram file download returned no response body',
      );
    }
    const contentLength = parseContentLength(response.headers);
    const declaredBytes =
      telegramDeclaredBytes === null
        ? contentLength
        : contentLength === null || telegramDeclaredBytes >= contentLength
          ? telegramDeclaredBytes
          : contentLength;
    if (declaredBytes !== null && declaredBytes > BigInt(input.maxBytes)) {
      await cancelQuietly(response.body);
      throw new TelegramMediaSourceTooLargeError(input.maxBytes, declaredBytes);
    }
    return {
      declaredBytes,
      stream: cancellableStream(response.body, input.signal),
    };
  }
}
