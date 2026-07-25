export type KoharuErrorKind = 'aborted' | 'timeout' | 'network' | 'http' | 'invalid_response';

export interface KoharuRateLimit {
  limit: number | null;
  remaining: number | null;
  resetAt: number | null;
}

interface KoharuErrorOptions {
  cause?: unknown;
  code?: string | null;
  kind: KoharuErrorKind;
  message: string;
  rateLimit?: KoharuRateLimit | null;
  retryAfterSeconds?: number | null;
  status?: number | null;
}

const KOHARU_ERROR_TAG = Symbol.for('@coszone/koharu-astro/KoharuError');
const ERROR_KINDS = new Set<KoharuErrorKind>([
  'aborted',
  'timeout',
  'network',
  'http',
  'invalid_response',
]);

export class KoharuError extends Error {
  readonly [KOHARU_ERROR_TAG] = true;
  override readonly cause?: unknown;
  readonly code: string | null;
  readonly kind: KoharuErrorKind;
  readonly rateLimit: KoharuRateLimit | null;
  readonly retryAfterSeconds: number | null;
  readonly status: number | null;

  private constructor(options: KoharuErrorOptions) {
    super(options.message);
    this.name = 'KoharuError';
    this.code = options.code ?? null;
    this.kind = options.kind;
    this.rateLimit = options.rateLimit ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.status = options.status ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  static aborted(): KoharuError {
    return new KoharuError({
      kind: 'aborted',
      message: 'Koharu Suite request was aborted',
    });
  }

  static timeout(): KoharuError {
    return new KoharuError({
      kind: 'timeout',
      message: 'Koharu Suite request timed out',
    });
  }

  static network(cause: unknown): KoharuError {
    return new KoharuError({
      cause,
      kind: 'network',
      message: 'Koharu Suite request failed',
    });
  }

  static http(options: {
    code: string;
    rateLimit: KoharuRateLimit | null;
    retryAfterSeconds: number | null;
    status: number;
  }): KoharuError {
    return new KoharuError({
      code: options.code,
      kind: 'http',
      message: `Koharu Suite returned HTTP ${options.status}`,
      rateLimit: options.rateLimit,
      retryAfterSeconds: options.retryAfterSeconds,
      status: options.status,
    });
  }

  static invalidResponse(): KoharuError {
    return new KoharuError({
      kind: 'invalid_response',
      message: 'Koharu Suite returned an invalid response',
    });
  }
}

export function isKoharuError(value: unknown): value is KoharuError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<KoharuError> & { [KOHARU_ERROR_TAG]?: unknown };
  return (
    candidate[KOHARU_ERROR_TAG] === true &&
    typeof candidate.kind === 'string' &&
    ERROR_KINDS.has(candidate.kind as KoharuErrorKind) &&
    (candidate.status === null || typeof candidate.status === 'number') &&
    (candidate.code === null || typeof candidate.code === 'string')
  );
}
