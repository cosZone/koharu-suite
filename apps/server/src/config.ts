import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65_535);
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
const postgresEnvironmentSchema = z.object({
  POSTGRES_DB: z.string().min(1),
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PASSWORD: z.string(),
  POSTGRES_PORT: portSchema,
  POSTGRES_USER: z.string().min(1),
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

export function resolveDatabaseUrl(
  value = process.env.DATABASE_URL,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return databaseUrlSchema.parse(value ?? databaseUrlFromEnvironment(environment));
}

export interface TelegramConfig {
  botToken: string;
  legacyChannelId: bigint | undefined;
  workerConcurrency: number;
}

export interface AuthConfig {
  baseUrl: string;
  secret: string;
  trustedOrigin: string;
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

export function resolveTelegramConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TelegramConfig {
  const parsed = telegramEnvironmentSchema.parse(environment);

  return {
    botToken: parsed.TELEGRAM_BOT_TOKEN,
    legacyChannelId: parsed.TELEGRAM_CHANNEL_ID,
    workerConcurrency: parsed.TELEGRAM_WORKER_CONCURRENCY,
  };
}

export function parseTelegramChannelId(value: string): bigint {
  return telegramChannelIdSchema.parse(value);
}
