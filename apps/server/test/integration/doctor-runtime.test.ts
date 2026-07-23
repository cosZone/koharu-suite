import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { EXPECTED_DATABASE_OBJECTS } from '../../src/ops/doctor.js';
import { PostgresDoctorDiagnostics } from '../../src/ops/doctor-runtime.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';

describe('PostgreSQL doctor diagnostics', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let connection: DatabaseConnection | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations(container.getConnectionUri());
    connection = createDatabaseConnection(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await container?.stop();
  }, 30_000);

  it('recognizes PostgreSQL 18 and every expected migrated schema object', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const diagnostics = new PostgresDoctorDiagnostics(connection.db);

    await expect(diagnostics.getPostgresMajorVersion()).resolves.toBe(18);
    await expect(diagnostics.listMissingSchemaObjects(EXPECTED_DATABASE_OBJECTS)).resolves.toEqual(
      [],
    );
    await expect(diagnostics.getBoundTelegramBotId()).resolves.toBeNull();
    await expect(diagnostics.listOwners()).resolves.toEqual([]);
    await expect(diagnostics.listEnabledChannels()).resolves.toEqual([]);
  });
});
