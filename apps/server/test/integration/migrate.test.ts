import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';

describe('database migrations', () => {
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it('applies the schema repeatedly without changing the result', async () => {
    if (!container) {
      throw new Error('PostgreSQL test container did not start');
    }

    const databaseUrl = container.getConnectionUri();

    await runMigrations(databaseUrl);
    await runMigrations(databaseUrl);

    const client = postgres(databaseUrl, { max: 1 });

    try {
      const [result] = await client<{ tableName: string | null }[]>`
        select to_regclass('public.app_metadata')::text as "tableName"
      `;

      expect(result?.tableName).toBe('app_metadata');
    } finally {
      await client.end();
    }
  }, 30_000);
});
