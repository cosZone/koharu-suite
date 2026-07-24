import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { parseCorsOriginAllowlist } from './http/public-policy.js';

const portSchema = z.coerce.number().int().min(1).max(65_535);
const workerInstanceIdSchema = z.string().trim().min(1).max(255);
const databaseUrlSchema = z.url({ protocol: /^postgres(?:ql)?$/ });
const telegramIdLowerBound = -((1n << 52n) - 1n);
const telegramChannelIdSchema = z
  .string()
  .trim()
  .regex(/^-\d+$/, 'must be a negative Telegram channel ID')
  .transform((value) => BigInt(value))
  .refine((value) => value < 0n, 'must be a negative Telegram channel ID')
  .refine((value) => value >= telegramIdLowerBound, 'is outside Telegram safe integer range');
const telegramEnvironmentSchema = z.object({
  KOHARU_ENABLE_TEST_TELEGRAM_API_ROOT: z.enum(['false', 'true']).default('false'),
  KOHARU_TEST_TELEGRAM_API_ROOT: z.url().optional(),
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1),
  TELEGRAM_CHANNEL_ID: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    telegramChannelIdSchema.optional(),
  ),
  TELEGRAM_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
});
const authEnvironmentSchema = z.object({
  BETTER_AUTH_SECRET: z.string().trim().min(32),
  BETTER_AUTH_URL: z.string().trim().min(1),
});
const publicApiEnvironmentSchema = z.object({
  PUBLIC_CORS_ORIGINS: z.string().optional(),
  PUBLIC_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(120),
  PUBLIC_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
  TRUST_PROXY: z
    .enum(['false', 'true'])
    .default('false')
    .transform((value) => value === 'true'),
});
const postgresEnvironmentSchema = z.object({
  POSTGRES_DB: z.string().min(1),
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PASSWORD: z.string(),
  POSTGRES_PORT: portSchema,
  POSTGRES_USER: z.string().min(1),
});
const MEDIA_CACHE_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const mediaCacheEnvironmentSchema = z.object({
  MEDIA_CACHE_DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  MEDIA_CACHE_ENABLED: z
    .enum(['false', 'true'])
    .default('false')
    .transform((value) => value === 'true'),
  MEDIA_CACHE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(MEDIA_CACHE_MAX_BYTES)
    .default(MEDIA_CACHE_MAX_BYTES),
  MEDIA_CACHE_ROOT: z.string().trim().min(1).default('/var/lib/koharu/media-cache'),
});

function databaseUrlFromEnvironment(environment: NodeJS.ProcessEnv): string {
  const postgresEnvironment = postgresEnvironmentSchema.parse(environment);
  const databaseUrl = new URL('postgresql://localhost');

  databaseUrl.hostname = postgresEnvironment.POSTGRES_HOST;
  databaseUrl.port = String(postgresEnvironment.POSTGRES_PORT);
  databaseUrl.username = postgresEnvironment.POSTGRES_USER;
  databaseUrl.password = postgresEnvironment.POSTGRES_PASSWORD;
  databaseUrl.pathname = `/${postgresEnvironment.POSTGRES_DB}`;

  return databaseUrl.toString();
}

export function resolvePort(value = process.env.PORT): number {
  return portSchema.parse(value ?? 3000);
}

export function resolveWorkerInstanceId(environment: NodeJS.ProcessEnv = process.env): string {
  return workerInstanceIdSchema.parse(environment.HOSTNAME);
}

export function resolveDatabaseUrl(
  value = process.env.DATABASE_URL,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return databaseUrlSchema.parse(value ?? databaseUrlFromEnvironment(environment));
}

export interface TelegramConfig {
  apiRoot: string | undefined;
  botToken: string;
  legacyChannelId: bigint | undefined;
  workerConcurrency: number;
}

export interface AuthConfig {
  baseUrl: string;
  secret: string;
  trustedOrigin: string;
}

export interface PublicApiConfig {
  corsOrigins: ReadonlySet<string>;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  trustProxy: boolean;
}

export interface MediaCacheConfig {
  downloadConcurrency: number;
  enabled: boolean;
  maxBytes: number;
  root: string;
}

function parseAuthBaseUrl(value: string): string {
  const url = new URL(value);
  const isLocalHttp =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');

  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('BETTER_AUTH_URL must use HTTPS, except for localhost development');
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('BETTER_AUTH_URL must be a canonical origin without credentials or a path');
  }

  return url.origin;
}

export function resolveAuthConfig(environment: NodeJS.ProcessEnv = process.env): AuthConfig {
  const parsed = authEnvironmentSchema.parse(environment);
  const baseUrl = parseAuthBaseUrl(parsed.BETTER_AUTH_URL);

  return {
    baseUrl,
    secret: parsed.BETTER_AUTH_SECRET,
    trustedOrigin: baseUrl,
  };
}

export function resolvePublicApiConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PublicApiConfig {
  const parsed = publicApiEnvironmentSchema.parse(environment);
  return {
    corsOrigins: parseCorsOriginAllowlist(parsed.PUBLIC_CORS_ORIGINS),
    rateLimitMax: parsed.PUBLIC_RATE_LIMIT_MAX,
    rateLimitWindowMs: parsed.PUBLIC_RATE_LIMIT_WINDOW_SECONDS * 1_000,
    trustProxy: parsed.TRUST_PROXY,
  };
}

export function resolveMediaCacheConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MediaCacheConfig {
  const parsed = mediaCacheEnvironmentSchema.parse(environment);
  if (!isAbsolute(parsed.MEDIA_CACHE_ROOT)) {
    throw new Error('MEDIA_CACHE_ROOT must be an absolute path');
  }
  return {
    downloadConcurrency: parsed.MEDIA_CACHE_DOWNLOAD_CONCURRENCY,
    enabled: parsed.MEDIA_CACHE_ENABLED,
    maxBytes: parsed.MEDIA_CACHE_MAX_BYTES,
    root: normalize(parsed.MEDIA_CACHE_ROOT),
  };
}

export function resolveTelegramConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TelegramConfig {
  const parsed = telegramEnvironmentSchema.parse(environment);
  const testApiRootEnabled = parsed.KOHARU_ENABLE_TEST_TELEGRAM_API_ROOT === 'true';
  if (parsed.KOHARU_TEST_TELEGRAM_API_ROOT && !testApiRootEnabled) {
    throw new Error(
      'KOHARU_TEST_TELEGRAM_API_ROOT requires KOHARU_ENABLE_TEST_TELEGRAM_API_ROOT=true',
    );
  }
  if (testApiRootEnabled && !parsed.KOHARU_TEST_TELEGRAM_API_ROOT) {
    throw new Error(
      'KOHARU_ENABLE_TEST_TELEGRAM_API_ROOT=true requires KOHARU_TEST_TELEGRAM_API_ROOT',
    );
  }

  return {
    apiRoot: testApiRootEnabled ? parsed.KOHARU_TEST_TELEGRAM_API_ROOT : undefined,
    botToken: parsed.TELEGRAM_BOT_TOKEN,
    legacyChannelId: parsed.TELEGRAM_CHANNEL_ID,
    workerConcurrency: parsed.TELEGRAM_WORKER_CONCURRENCY,
  };
}

export function parseTelegramChannelId(value: string): bigint {
  return telegramChannelIdSchema.parse(value);
}
