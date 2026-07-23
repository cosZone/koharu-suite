import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65_535);
const databaseUrlSchema = z.url({ protocol: /^postgres(?:ql)?$/ });
const telegramIdLowerBound = -((1n << 52n) - 1n);
const telegramChannelIdSchema = z
  .string()
  .trim()
  .regex(/^-\d+$/, 'must be a negative Telegram channel ID')
  .transform((value) => BigInt(value))
  .refine((value) => value >= telegramIdLowerBound, 'is outside Telegram safe integer range');
const telegramEnvironmentSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1),
  TELEGRAM_CHANNEL_ID: telegramChannelIdSchema,
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
  channelId: bigint;
}

export function resolveTelegramConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TelegramConfig {
  const parsed = telegramEnvironmentSchema.parse(environment);

  return {
    botToken: parsed.TELEGRAM_BOT_TOKEN,
    channelId: parsed.TELEGRAM_CHANNEL_ID,
  };
}
