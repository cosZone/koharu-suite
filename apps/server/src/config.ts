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
const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);
const mediaS3EnvironmentSchema = z.object({
  S3_ALLOW_INSECURE: z
    .enum(['false', 'true'])
    .default('false')
    .transform((value) => value === 'true'),
  S3_BUCKET: optionalTrimmedString,
  S3_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(5_000),
  S3_ENDPOINT: optionalTrimmedString,
  S3_FORCE_PATH_STYLE: z
    .enum(['false', 'true'])
    .default('true')
    .transform((value) => value === 'true'),
  S3_KEY: optionalTrimmedString,
  S3_PREFIX: z.string().trim().default('koharu/media-cache'),
  S3_REGION: z.string().trim().min(1).max(255).default('us-east-1'),
  S3_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  S3_SECRET: optionalTrimmedString,
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

export type MediaS3Config =
  | { enabled: false }
  | {
      accessKeyId: string;
      bucket: string;
      connectTimeoutMs: number;
      enabled: true;
      endpoint: string;
      forcePathStyle: boolean;
      prefix: string;
      region: string;
      requestTimeoutMs: number;
      secretAccessKey: string;
    };

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

export function resolveMediaS3Config(environment: NodeJS.ProcessEnv = process.env): MediaS3Config {
  const coreNames = ['S3_ENDPOINT', 'S3_KEY', 'S3_SECRET', 'S3_BUCKET'] as const;
  if (coreNames.every((name) => !hasEnvironmentValue(environment[name]))) {
    return { enabled: false };
  }
  const parsed = mediaS3EnvironmentSchema.parse(environment);
  const required = [
    ['S3_ENDPOINT', parsed.S3_ENDPOINT],
    ['S3_KEY', parsed.S3_KEY],
    ['S3_SECRET', parsed.S3_SECRET],
    ['S3_BUCKET', parsed.S3_BUCKET],
  ] as const;
  const configured = required.filter(([, value]) => value !== undefined);
  if (configured.length === 0) {
    return { enabled: false };
  }
  if (configured.length !== required.length) {
    const missing = required
      .filter(([, value]) => value === undefined)
      .map(([name]) => name)
      .join(', ');
    throw new Error(`S3 storage configuration is incomplete; missing ${missing}`);
  }

  const endpoint = parseS3Endpoint(parsed.S3_ENDPOINT as string, parsed.S3_ALLOW_INSECURE);
  const prefix = parseS3Prefix(parsed.S3_PREFIX);
  const bucket = parsed.S3_BUCKET as string;
  if (bucket.length > 255 || bucket.includes('/') || bucket.includes('\\')) {
    throw new Error('S3_BUCKET must be a bucket name without path separators');
  }
  return {
    accessKeyId: parsed.S3_KEY as string,
    bucket,
    connectTimeoutMs: parsed.S3_CONNECT_TIMEOUT_MS,
    enabled: true,
    endpoint,
    forcePathStyle: parsed.S3_FORCE_PATH_STYLE,
    prefix,
    region: parsed.S3_REGION,
    requestTimeoutMs: parsed.S3_REQUEST_TIMEOUT_MS,
    secretAccessKey: parsed.S3_SECRET as string,
  };
}

function parseS3Endpoint(value: string, allowInsecure: boolean): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('S3_ENDPOINT must be a valid HTTP or HTTPS origin');
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new Error('S3_ENDPOINT must use HTTP or HTTPS');
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== '/' && endpoint.pathname !== '')
  ) {
    throw new Error('S3_ENDPOINT must be a canonical origin without credentials or a path');
  }
  if (endpoint.protocol === 'http:' && !allowInsecure) {
    throw new Error('HTTP S3_ENDPOINT requires S3_ALLOW_INSECURE=true');
  }
  return endpoint.origin;
}

function hasEnvironmentValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseS3Prefix(value: string): string {
  const prefix = value.replace(/^\/+|\/+$/gu, '');
  const segments = prefix.split('/');
  if (
    !prefix ||
    prefix.length > 512 ||
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9!_.*'()-]+$/u.test(segment),
    )
  ) {
    throw new Error('S3_PREFIX must be a safe relative object-key prefix');
  }
  return prefix;
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
