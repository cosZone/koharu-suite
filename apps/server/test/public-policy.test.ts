import { describe, expect, it } from 'vitest';
import {
  FixedWindowRateLimiter,
  InvalidCorsOriginError,
  matchCorsOrigin,
  parseCorsOriginAllowlist,
} from '../src/http/public-policy.js';

describe('fixed-window public rate limiter', () => {
  it('allows up to the limit and returns a rounded-up Retry-After after it', () => {
    let now = 1_250;
    const limiter = new FixedWindowRateLimiter({
      max: 2,
      maxBuckets: 10,
      now: () => now,
      windowMs: 2_000,
    });

    expect(limiter.consume('client-a')).toEqual({
      allowed: true,
      limit: 2,
      remaining: 1,
      resetAt: 2_000,
      retryAfterSeconds: null,
    });
    expect(limiter.consume('client-a')).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.consume('client-a')).toEqual({
      allowed: false,
      limit: 2,
      remaining: 0,
      resetAt: 2_000,
      retryAfterSeconds: 1,
    });

    now = 2_000;
    expect(limiter.consume('client-a')).toEqual({
      allowed: true,
      limit: 2,
      remaining: 1,
      resetAt: 4_000,
      retryAfterSeconds: null,
    });
  });

  it('uses independent keys and an injected deterministic clock', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      max: 1,
      maxBuckets: 10,
      now: () => now,
      windowMs: 3_000,
    });

    expect(limiter.consume('client-a').allowed).toBe(true);
    expect(limiter.consume('client-a')).toMatchObject({
      allowed: false,
      retryAfterSeconds: 3,
    });
    expect(limiter.consume('client-b').allowed).toBe(true);

    now = 1_001;
    expect(limiter.consume('client-a')).toMatchObject({
      allowed: false,
      retryAfterSeconds: 2,
    });
  });

  it('lazily removes expired buckets before applying the memory bound', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      max: 1,
      maxBuckets: 1,
      now: () => now,
      windowMs: 1_000,
    });

    expect(limiter.consume('expired').allowed).toBe(true);
    expect(limiter.consume('expired').allowed).toBe(false);

    now = 1_000;
    expect(limiter.consume('replacement').allowed).toBe(true);
    expect(limiter.consume('replacement').allowed).toBe(false);
  });

  it('evicts the least recently seen live bucket at maxBuckets', () => {
    let now = 10;
    const limiter = new FixedWindowRateLimiter({
      max: 1,
      maxBuckets: 2,
      now: () => now,
      windowMs: 10_000,
    });

    expect(limiter.consume('oldest').allowed).toBe(true);
    now = 20;
    expect(limiter.consume('recent').allowed).toBe(true);
    now = 30;
    expect(limiter.consume('recent').allowed).toBe(false);
    now = 40;
    expect(limiter.consume('new').allowed).toBe(true);

    expect(limiter.consume('oldest').allowed).toBe(true);
  });

  it('rejects invalid bounds and clocks', () => {
    expect(
      () =>
        new FixedWindowRateLimiter({
          max: 0,
          maxBuckets: 1,
          windowMs: 1_000,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new FixedWindowRateLimiter({
          max: 1,
          maxBuckets: 0,
          windowMs: 1_000,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new FixedWindowRateLimiter({
          max: 1,
          maxBuckets: 1,
          windowMs: 0,
        }),
    ).toThrow(RangeError);

    const invalidClock = new FixedWindowRateLimiter({
      max: 1,
      maxBuckets: 1,
      now: () => Number.NaN,
      windowMs: 1_000,
    });
    expect(() => invalidClock.consume('client')).toThrow(RangeError);
  });
});

describe('public CORS origin policy', () => {
  it('defaults to no cross-origin access and matches configured origins exactly', () => {
    const empty = parseCorsOriginAllowlist(undefined);
    const allowlist = parseCorsOriginAllowlist(
      'https://blog.example.com, http://localhost:4321,https://blog.example.com',
    );

    expect(empty.size).toBe(0);
    expect([...allowlist]).toEqual(['https://blog.example.com', 'http://localhost:4321']);
    expect(matchCorsOrigin('https://blog.example.com', allowlist)).toBe('https://blog.example.com');
    expect(matchCorsOrigin('https://BLOG.example.com', allowlist)).toBeNull();
    expect(matchCorsOrigin('https://blog.example.com/', allowlist)).toBeNull();
    expect(matchCorsOrigin('https://other.example.com', allowlist)).toBeNull();
    expect(matchCorsOrigin('null', allowlist)).toBeNull();
    expect(matchCorsOrigin(undefined, allowlist)).toBeNull();
  });

  it.each([
    '*',
    'null',
    'https://*.example.com',
    'https://user:password@example.com',
    'https://example.com/',
    'https://example.com:443',
    'HTTPS://example.com',
    'https://example.com/path',
    'https://example.com?query=true',
    'https://example.com#fragment',
    'ftp://example.com',
    'not-an-origin',
    'https://one.example.com,',
  ])('rejects non-canonical, wildcard, or credentialed origins: %s', (value) => {
    expect(() => parseCorsOriginAllowlist(value)).toThrow(InvalidCorsOriginError);
  });
});
