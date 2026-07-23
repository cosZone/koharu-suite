import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const MIGRATION_LOCK_NAMESPACE = 1_267_663_173;
const MIGRATION_LOCK_KEY = 1;
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(
  databaseUrl: string,
  options: { migrationsFolder?: string } = {},
): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 });

  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_KEY})`;

    try {
      await migrate(drizzle(client), {
        migrationsFolder: options.migrationsFolder ?? migrationsFolder,
      });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await client.end();
  }
}
