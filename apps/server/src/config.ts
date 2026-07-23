import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65_535);
const databaseUrlSchema = z.url({ protocol: /^postgres(?:ql)?$/ });
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
