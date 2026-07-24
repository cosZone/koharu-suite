import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { reconciliationRuns, reconciliationSchedule } from '../../src/db/schema.js';
import { PostgresReconciliationScheduleRepository } from '../../src/reconciliation/schedule-repository.js';

const POSTGRES_IMAGE = 'postgres:18-alpine';

describe('reconciliation durable schedule lease', () => {
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

  beforeEach(async () => {
    if (!connection) {
      return;
    }
    await connection.db.delete(reconciliationSchedule);
    await connection.db.delete(reconciliationRuns);
  });

  it('initializes idempotently and does not claim disabled or not-due work', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const repository = new PostgresReconciliationScheduleRepository(connection.db);
    const future = new Date('2999-01-01T00:00:00.000Z');

    await repository.initialize({
      enabled: false,
      intervalSeconds: 600,
      nextRunAt: future,
    });
    const second = await repository.initialize({
      enabled: true,
      intervalSeconds: 1,
      nextRunAt: new Date('2000-01-01T00:00:00.000Z'),
    });

    expect(second).toMatchObject({
      enabled: false,
      intervalSeconds: 600,
      nextRunAt: future.toISOString(),
    });
    await expect(repository.claimDue('worker-one', 10_000)).resolves.toBeNull();

    await connection.db
      .update(reconciliationSchedule)
      .set({ enabled: true })
      .where(eq(reconciliationSchedule.singletonKey, 'telegram'));
    await expect(repository.claimDue('worker-one', 10_000)).resolves.toBeNull();
  });

  it('atomically claims, fences renewal, and interrupts an expired claim on takeover', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const repository = new PostgresReconciliationScheduleRepository(connection.db);
    await repository.initialize({ intervalSeconds: 60 });
    await makeDue(connection);

    const first = await repository.claimDue('worker-one', 30_000, ['-1001']);
    if (!first) {
      throw new Error('First schedule claim failed');
    }
    expect(first).toMatchObject({
      leaseOwner: 'worker-one',
    });
    expect(first.leaseToken).toMatch(/^[a-f0-9-]{36}$/u);
    expect(first.claimedRunId).toBeTruthy();
    await expect(repository.claimDue('worker-two', 30_000)).resolves.toBeNull();

    await connection.db
      .update(reconciliationSchedule)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(reconciliationSchedule.singletonKey, 'telegram'));
    await expect(repository.renew('worker-one', first.leaseToken, 30_000)).rejects.toThrow(
      'ownership was lost',
    );

    const second = await repository.claimDue('worker-two', 30_000, ['-1001']);
    if (!second) {
      throw new Error('Expired schedule takeover failed');
    }
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(second.claimedRunId).not.toBe(first.claimedRunId);
    await expect(repository.renew('worker-one', first.leaseToken, 30_000)).rejects.toThrow(
      'ownership was lost',
    );
    await expect(repository.renew('worker-two', second.leaseToken, 60_000)).resolves.toMatchObject({
      claimedRunId: second.claimedRunId,
      leaseOwner: 'worker-two',
      leaseToken: second.leaseToken,
    });

    const [interrupted] = await connection.db
      .select({
        completedAt: reconciliationRuns.completedAt,
        status: reconciliationRuns.status,
      })
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.id, first.claimedRunId));
    expect(interrupted).toMatchObject({
      status: 'interrupted',
    });
    expect(interrupted?.completedAt).not.toBeNull();
  });

  it('rejects empty, non-channel, and oversized due scope before persisting a run', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const repository = new PostgresReconciliationScheduleRepository(connection.db);
    await repository.initialize({ intervalSeconds: 60 });
    await makeDue(connection);

    await expect(repository.claimDue('worker-one', 30_000)).rejects.toThrow(
      'must include at least one channel',
    );
    await expect(
      repository.claimDue('worker-one', 30_000, ['/Users/operator/private-export']),
    ).rejects.toThrow('canonical channel IDs');
    await expect(
      repository.claimDue(
        'worker-one',
        30_000,
        Array.from({ length: 101 }, (_, index) => `-${index + 1}`),
      ),
    ).rejects.toThrow('at most 100 channels');
    await expect(repository.get()).resolves.toMatchObject({
      claimedRunId: null,
      leaseOwner: null,
      leaseToken: null,
    });
    await expect(connection.db.select().from(reconciliationRuns)).resolves.toEqual([]);
  });

  it('binds finish to the owner, token, and claimed run and records terminal state atomically', async () => {
    if (!connection) {
      throw new Error('Database connection was not created');
    }
    const repository = new PostgresReconciliationScheduleRepository(connection.db);
    await repository.initialize({ intervalSeconds: 60 });
    await makeDue(connection);
    const first = await repository.claimDue('worker-one', 30_000, ['-1001']);
    if (!first) {
      throw new Error('Schedule claim failed');
    }

    await expect(
      repository.complete('worker-one', {
        leaseToken: '00000000-0000-4000-8000-000000000000',
        runId: first.claimedRunId,
        status: 'completed',
      }),
    ).rejects.toThrow('ownership was lost');
    await expect(
      repository.complete('worker-stale', {
        leaseToken: first.leaseToken,
        runId: first.claimedRunId,
        status: 'completed',
      }),
    ).rejects.toThrow('ownership was lost');
    await expect(repository.get()).resolves.toMatchObject({
      claimedRunId: first.claimedRunId,
      leaseOwner: 'worker-one',
      leaseToken: first.leaseToken,
    });

    await expect(
      repository.complete('worker-one', {
        leaseToken: first.leaseToken,
        report: { schemaVersion: 1 },
        runId: first.claimedRunId,
        status: 'completed',
      }),
    ).resolves.toMatchObject({
      claimedRunId: null,
      lastRunId: first.claimedRunId,
      lastStatus: 'completed',
      leaseExpiresAt: null,
      leaseOwner: null,
      leaseToken: null,
    });
    const [completed] = await connection.db
      .select({
        completedAt: reconciliationRuns.completedAt,
        report: reconciliationRuns.report,
        status: reconciliationRuns.status,
      })
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.id, first.claimedRunId));
    expect(completed).toMatchObject({
      report: { schemaVersion: 1 },
      status: 'completed',
    });
    expect(completed?.completedAt).not.toBeNull();

    await makeDue(connection);
    const second = await repository.claimDue('worker-two', 30_000, ['-1001']);
    if (!second) {
      throw new Error('Second schedule claim failed');
    }
    await expect(
      repository.release('worker-two', {
        leaseToken: first.leaseToken,
        runId: first.claimedRunId,
        status: 'failed',
      }),
    ).rejects.toThrow('ownership was lost');
    await expect(
      repository.release('worker-two', {
        leaseToken: second.leaseToken,
        runId: second.claimedRunId,
        status: 'failed',
      }),
    ).resolves.toMatchObject({
      lastRunId: second.claimedRunId,
      lastStatus: 'failed',
    });
  });
});

async function makeDue(connection: DatabaseConnection): Promise<void> {
  await connection.db
    .update(reconciliationSchedule)
    .set({ nextRunAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(reconciliationSchedule.singletonKey, 'telegram'));
}
