export interface FixedWindowRateLimiterOptions {
  max: number;
  maxBuckets: number;
  now?: () => number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number | null;
}

interface RateLimitBucket {
  count: number;
  lastSeen: number;
  resetAt: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly max: number;
  private readonly maxBuckets: number;
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(options: FixedWindowRateLimiterOptions) {
    this.max = positiveInteger(options.max, 'max');
    this.maxBuckets = positiveInteger(options.maxBuckets, 'maxBuckets');
    this.windowMs = positiveInteger(options.windowMs, 'windowMs');
    this.now = options.now ?? Date.now;
  }

  consume(key: string): RateLimitDecision {
    const now = this.now();
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError('now must return a finite, non-negative timestamp');
    }

    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      if (bucket) {
        this.buckets.delete(key);
      }
      this.pruneExpired(now);
      this.ensureCapacity();

      const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
      bucket = {
        count: 0,
        lastSeen: now,
        resetAt: windowStart + this.windowMs,
      };
      this.buckets.set(key, bucket);
    }

    bucket.lastSeen = now;
    if (bucket.count >= this.max) {
      return {
        allowed: false,
        limit: this.max,
        remaining: 0,
        resetAt: bucket.resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      limit: this.max,
      remaining: this.max - bucket.count,
      resetAt: bucket.resetAt,
      retryAfterSeconds: null,
    };
  }

  private ensureCapacity(): void {
    if (this.buckets.size < this.maxBuckets) {
      return;
    }

    let oldestKey: string | undefined;
    let oldestLastSeen = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastSeen < oldestLastSeen) {
        oldestKey = key;
        oldestLastSeen = bucket.lastSeen;
      }
    }

    if (oldestKey !== undefined) {
      this.buckets.delete(oldestKey);
    }
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key);
      }
    }
  }
}

export class InvalidCorsOriginError extends Error {
  constructor() {
    super('Invalid CORS origin');
    this.name = 'InvalidCorsOriginError';
  }
}

function parseCanonicalHttpOrigin(origin: string): string {
  if (!origin || origin === '*' || origin === 'null' || origin.includes('*')) {
    throw new InvalidCorsOriginError();
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new InvalidCorsOriginError();
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== origin
  ) {
    throw new InvalidCorsOriginError();
  }

  return parsed.origin;
}

export function parseCorsOriginAllowlist(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value.trim() === '') {
    return new Set();
  }

  const origins = value.split(',').map((origin) => origin.trim());
  if (origins.some((origin) => !origin)) {
    throw new InvalidCorsOriginError();
  }

  return new Set(origins.map(parseCanonicalHttpOrigin));
}

export function matchCorsOrigin(
  origin: string | null | undefined,
  allowlist: ReadonlySet<string>,
): string | null {
  return origin !== null && origin !== undefined && allowlist.has(origin) ? origin : null;
}
