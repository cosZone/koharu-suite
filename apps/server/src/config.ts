import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65_535);
const databaseUrlSchema = z.url({ protocol: /^postgres(?:ql)?$/ });

export function resolvePort(value = process.env.PORT): number {
  return portSchema.parse(value ?? 3000);
}

export function resolveDatabaseUrl(value = process.env.DATABASE_URL): string {
  return databaseUrlSchema.parse(value);
}
