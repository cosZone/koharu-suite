import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PostgresWorkerRuntimeRepository } from '../../src/worker-runtime-repository.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';

describe('worker runtime heartbeat', () => {
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

  it('reports running, stale, and stopped states without exposing the instance ID', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const repository = new PostgresWorkerRuntimeRepository(connection.db);
    const startedAt = new Date('2026-07-24T12:00:00.000Z');

    await expect(repository.getStatus(startedAt)).resolves.toEqual({
      heartbeatAt: null,
      lastTelegramSuccessAt: null,
      startedAt: null,
      state: 'stopped',
      version: null,
    });

    await repository.claim('worker-one', '0.1.0', startedAt);
    await expect(repository.getStatus(startedAt)).resolves.toMatchObject({
      heartbeatAt: startedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      state: 'stopped',
      version: '0.1.0',
    });

    const runningAt = new Date(startedAt.getTime() + 1_000);
    await repository.markRunning('worker-one', runningAt);
    await repository.recordTelegramSuccess('worker-one', new Date(startedAt.getTime() + 2_000));
    await expect(
      repository.getStatus(new Date(startedAt.getTime() + 29_000)),
    ).resolves.toMatchObject({
      lastTelegramSuccessAt: new Date(startedAt.getTime() + 2_000).toISOString(),
      state: 'running',
    });
    await expect(
      repository.getStatus(new Date(startedAt.getTime() + 31_001)),
    ).resolves.toMatchObject({ state: 'stale' });

    await repository.markStopping('worker-one', new Date(startedAt.getTime() + 33_000));
    await expect(
      repository.getStatus(new Date(startedAt.getTime() + 33_001)),
    ).resolves.toMatchObject({ state: 'stopped' });
  });

  it('fences obsolete instances and health-checks only the current fresh owner', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const repository = new PostgresWorkerRuntimeRepository(connection.db);
    const now = new Date('2026-07-24T13:00:00.000Z');

    await repository.claim('worker-old', '0.1.0', now);
    await repository.markRunning('worker-old', now);
    await repository.claim('worker-current', '0.1.0', new Date(now.getTime() + 1_000));
    await repository.markRunning('worker-current', new Date(now.getTime() + 1_000));

    await expect(repository.heartbeat('worker-old', now)).rejects.toThrow('ownership was lost');
    await expect(repository.markStopping('worker-old', now)).resolves.toBe(false);
    await expect(
      repository.getHealthyInstance('worker-old', new Date(now.getTime() + 2_000)),
    ).resolves.toBeNull();
    await expect(
      repository.getHealthyInstance('worker-current', new Date(now.getTime() + 2_000)),
    ).resolves.toMatchObject({
      instanceId: 'worker-current',
      version: '0.1.0',
    });
    await expect(
      repository.getHealthyInstance('worker-current', new Date(now.getTime() + 32_000)),
    ).resolves.toBeNull();
  });
});
