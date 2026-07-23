import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseConnection {
  close: () => Promise<void>;
  db: Database;
}

export function createDatabaseConnection(
  databaseUrl: string,
  options: { max?: number } = {},
): DatabaseConnection {
  const client = postgres(databaseUrl, options);

  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}
