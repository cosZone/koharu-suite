import { describe, expect, it } from 'vitest';
import {
  resolveAuthConfig,
  resolveDatabaseUrl,
  resolveMediaCacheConfig,
  resolvePort,
  resolvePublicApiConfig,
  resolveTelegramConfig,
  resolveWorkerInstanceId,
} from '../src/config.js';

describe('configuration', () => {
  it('accepts a valid port', () => {
    expect(resolvePort('4321')).toBe(4321);
  });

  it('uses the container hostname as the fenced worker instance ID', () => {
    expect(resolveWorkerInstanceId({ HOSTNAME: 'worker-container-id' })).toBe(
      'worker-container-id',
    );
    expect(() => resolveWorkerInstanceId({})).toThrow();
  });

  it('rejects an invalid port', () => {
    expect(() => resolvePort('70000')).toThrow();
  });

  it('accepts PostgreSQL URLs only', () => {
    expect(resolveDatabaseUrl('postgresql://localhost/koharu')).toBe(
      'postgresql://localhost/koharu',
    );
    expect(() => resolveDatabaseUrl('https://example.com')).toThrow();
  });

  it('encodes discrete PostgreSQL settings without corrupting reserved password characters', () => {
    expect(
      resolveDatabaseUrl(undefined, {
        POSTGRES_DB: 'koharu',
        POSTGRES_HOST: 'db',
        POSTGRES_PASSWORD: 'slash/pass#word',
        POSTGRES_PORT: '5432',
        POSTGRES_USER: 'koharu',
      }),
    ).toBe('postgresql://koharu:slash%2Fpass%23word@db:5432/koharu');
  });

  it('parses a Telegram token and 64-bit-safe negative channel ID', () => {
    expect(
      resolveTelegramConfig({
        TELEGRAM_BOT_TOKEN: '123456:test-token',
        TELEGRAM_CHANNEL_ID: '-1001234567890',
      }),
    ).toEqual({
      apiRoot: undefined,
      botToken: '123456:test-token',
      legacyChannelId: -1_001_234_567_890n,
      workerConcurrency: 4,
    });
  });

  it('allows no legacy channel and parses bounded worker concurrency', () => {
    expect(
      resolveTelegramConfig({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_WORKER_CONCURRENCY: '16',
      }),
    ).toEqual({
      apiRoot: undefined,
      botToken: 'token',
      legacyChannelId: undefined,
      workerConcurrency: 16,
    });
    expect(() =>
      resolveTelegramConfig({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_WORKER_CONCURRENCY: '17',
      }),
    ).toThrow();
  });

  it('enables a custom Telegram API root only behind the explicit test gate', () => {
    expect(
      resolveTelegramConfig({
        KOHARU_ENABLE_TEST_TELEGRAM_API_ROOT: 'true',
        KOHARU_TEST_TELEGRAM_API_ROOT: 'http://telegram-fixture:8080',
        TELEGRAM_BOT_TOKEN: 'fixture-token',
      }),
    ).toMatchObject({
      apiRoot: 'http://telegram-fixture:8080',
      botToken: 'fixture-token',
    });
    expect(() =>
      resolveTelegramConfig({
        KOHARU_TEST_TELEGRAM_API_ROOT: 'http://telegram-fixture:8080',
        TELEGRAM_BOT_TOKEN: 'fixture-token',
      }),
    ).toThrow('requires KOHARU_ENABLE_TEST_TELEGRAM_API_ROOT=true');
    expect(() =>
      resolveTelegramConfig({
        KOHARU_ENABLE_TEST_TELEGRAM_API_ROOT: 'true',
        TELEGRAM_BOT_TOKEN: 'fixture-token',
      }),
    ).toThrow('requires KOHARU_TEST_TELEGRAM_API_ROOT');
  });

  it('rejects missing token, non-channel IDs, and unsafe Telegram IDs', () => {
    expect(() => resolveTelegramConfig({})).toThrow();
    expect(() =>
      resolveTelegramConfig({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHANNEL_ID: '1234',
      }),
    ).toThrow();
    expect(() =>
      resolveTelegramConfig({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHANNEL_ID: '-0',
      }),
    ).toThrow();
    expect(() =>
      resolveTelegramConfig({
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHANNEL_ID: '-9007199254740992',
      }),
    ).toThrow();
  });

  it('does not echo the bot token when another Telegram setting is invalid', () => {
    const token = '123456:super-secret-token';
    let configurationError: unknown;

    try {
      resolveTelegramConfig({
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_CHANNEL_ID: 'not-a-channel',
      });
    } catch (error) {
      configurationError = error;
    }

    expect(configurationError).toBeDefined();
    expect(String(configurationError)).not.toContain(token);
  });

  it('normalizes an HTTPS or localhost Better Auth origin', () => {
    expect(
      resolveAuthConfig({
        BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
        BETTER_AUTH_URL: 'https://suite.example.com/',
      }),
    ).toEqual({
      baseUrl: 'https://suite.example.com',
      secret: 'test-secret-with-at-least-32-characters',
      trustedOrigin: 'https://suite.example.com',
    });

    expect(
      resolveAuthConfig({
        BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
        BETTER_AUTH_URL: 'http://127.0.0.1:3000',
      }).baseUrl,
    ).toBe('http://127.0.0.1:3000');
  });

  it('rejects weak secrets, insecure remote origins, paths, and credentials', () => {
    expect(() =>
      resolveAuthConfig({
        BETTER_AUTH_SECRET: 'short',
        BETTER_AUTH_URL: 'https://suite.example.com',
      }),
    ).toThrow();
    expect(() =>
      resolveAuthConfig({
        BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
        BETTER_AUTH_URL: 'http://suite.example.com',
      }),
    ).toThrow();
    expect(() =>
      resolveAuthConfig({
        BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
        BETTER_AUTH_URL: 'https://suite.example.com/admin',
      }),
    ).toThrow();
    expect(() =>
      resolveAuthConfig({
        BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
        BETTER_AUTH_URL: 'https://user:password@suite.example.com',
      }),
    ).toThrow();
  });

  it('uses conservative public API defaults', () => {
    const config = resolvePublicApiConfig({});

    expect(config).toEqual({
      corsOrigins: new Set(),
      rateLimitMax: 120,
      rateLimitWindowMs: 60_000,
      trustProxy: false,
    });
  });

  it('keeps the media cache disabled by default with the 5 GiB application budget', () => {
    expect(resolveMediaCacheConfig({})).toEqual({
      downloadConcurrency: 2,
      enabled: false,
      maxBytes: 5 * 1024 * 1024 * 1024,
      root: '/var/lib/koharu/media-cache',
    });
  });

  it('parses explicit bounded media cache settings', () => {
    expect(
      resolveMediaCacheConfig({
        MEDIA_CACHE_DOWNLOAD_CONCURRENCY: '4',
        MEDIA_CACHE_ENABLED: 'true',
        MEDIA_CACHE_MAX_BYTES: String(128 * 1024 * 1024),
        MEDIA_CACHE_ROOT: '/srv/koharu/cache/',
      }),
    ).toEqual({
      downloadConcurrency: 4,
      enabled: true,
      maxBytes: 128 * 1024 * 1024,
      root: '/srv/koharu/cache/',
    });
  });

  it.each([
    { MEDIA_CACHE_DOWNLOAD_CONCURRENCY: '0' },
    { MEDIA_CACHE_DOWNLOAD_CONCURRENCY: '5' },
    { MEDIA_CACHE_ENABLED: '1' },
    { MEDIA_CACHE_MAX_BYTES: '0' },
    { MEDIA_CACHE_MAX_BYTES: String(5 * 1024 * 1024 * 1024 + 1) },
    { MEDIA_CACHE_ROOT: 'relative/cache' },
  ])('rejects unsafe media cache configuration: %j', (environment) => {
    expect(() => resolveMediaCacheConfig(environment)).toThrow();
  });

  it('parses exact public origins, rate-limit bounds, and explicit proxy trust', () => {
    const config = resolvePublicApiConfig({
      PUBLIC_CORS_ORIGINS: 'https://blog.example.com, http://localhost:4321',
      PUBLIC_RATE_LIMIT_MAX: '250',
      PUBLIC_RATE_LIMIT_WINDOW_SECONDS: '30',
      TRUST_PROXY: 'true',
    });

    expect(config).toEqual({
      corsOrigins: new Set(['https://blog.example.com', 'http://localhost:4321']),
      rateLimitMax: 250,
      rateLimitWindowMs: 30_000,
      trustProxy: true,
    });
  });

  it.each([
    { PUBLIC_CORS_ORIGINS: '*' },
    { PUBLIC_CORS_ORIGINS: 'https://*.example.com' },
    { PUBLIC_CORS_ORIGINS: 'https://blog.example.com/' },
    { PUBLIC_CORS_ORIGINS: 'https://blog.example.com/path' },
    { PUBLIC_RATE_LIMIT_MAX: '0' },
    { PUBLIC_RATE_LIMIT_MAX: '10001' },
    { PUBLIC_RATE_LIMIT_WINDOW_SECONDS: '0' },
    { PUBLIC_RATE_LIMIT_WINDOW_SECONDS: '3601' },
    { TRUST_PROXY: '1' },
  ])('rejects unsafe public API configuration: %j', (environment) => {
    expect(() => resolvePublicApiConfig(environment)).toThrow();
  });
});
