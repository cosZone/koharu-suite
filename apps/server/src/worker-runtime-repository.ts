import { and, eq } from 'drizzle-orm';
import type { Database } from './db/client.js';
import { workerRuntime } from './db/schema.js';

export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_HEARTBEAT_STALE_AFTER_MS = 30_000;

export type CollectorState = 'running' | 'stale' | 'stopped';

export interface WorkerRuntimeStatus {
  heartbeatAt: string | null;
  lastTelegramSuccessAt: string | null;
  startedAt: string | null;
  state: CollectorState;
  version: string | null;
}

export interface WorkerHealth {
  heartbeatAt: string;
  instanceId: string;
  version: string;
}

function publicStatus(
  row:
    | {
        heartbeatAt: Date;
        lastTelegramSuccessAt: Date | null;
        startedAt: Date;
        state: 'running' | 'starting' | 'stopping';
        version: string;
      }
    | undefined,
  now: Date,
): WorkerRuntimeStatus {
  if (!row) {
    return {
      heartbeatAt: null,
      lastTelegramSuccessAt: null,
      startedAt: null,
      state: 'stopped',
      version: null,
    };
  }

  const fresh = now.getTime() - row.heartbeatAt.getTime() <= WORKER_HEARTBEAT_STALE_AFTER_MS;
  const state: CollectorState = row.state === 'running' ? (fresh ? 'running' : 'stale') : 'stopped';

  return {
    heartbeatAt: row.heartbeatAt.toISOString(),
    lastTelegramSuccessAt: row.lastTelegramSuccessAt?.toISOString() ?? null,
    startedAt: row.startedAt.toISOString(),
    state,
    version: row.version,
  };
}

export class PostgresWorkerRuntimeRepository {
  constructor(private readonly database: Database) {}

  async claim(instanceId: string, version: string, now = new Date()): Promise<void> {
    await this.database
      .insert(workerRuntime)
      .values({
        heartbeatAt: now,
        instanceId,
        startedAt: now,
        state: 'starting',
        version,
      })
      .onConflictDoUpdate({
        target: workerRuntime.singletonKey,
        set: {
          heartbeatAt: now,
          instanceId,
          startedAt: now,
          state: 'starting',
          version,
        },
      });
  }

  async markRunning(instanceId: string, now = new Date()): Promise<void> {
    await this.updateOwned(instanceId, {
      heartbeatAt: now,
      state: 'running',
    });
  }

  async heartbeat(instanceId: string, now = new Date()): Promise<void> {
    await this.updateOwned(instanceId, { heartbeatAt: now });
  }

  async recordTelegramSuccess(instanceId: string, now = new Date()): Promise<void> {
    await this.updateOwned(instanceId, {
      lastTelegramSuccessAt: now,
    });
  }

  async markStopping(instanceId: string, now = new Date()): Promise<boolean> {
    const updated = await this.database
      .update(workerRuntime)
      .set({ heartbeatAt: now, state: 'stopping' })
      .where(
        and(eq(workerRuntime.singletonKey, 'telegram'), eq(workerRuntime.instanceId, instanceId)),
      )
      .returning({ singletonKey: workerRuntime.singletonKey });
    return updated.length === 1;
  }

  async getStatus(now = new Date()): Promise<WorkerRuntimeStatus> {
    const [row] = await this.database
      .select({
        heartbeatAt: workerRuntime.heartbeatAt,
        lastTelegramSuccessAt: workerRuntime.lastTelegramSuccessAt,
        startedAt: workerRuntime.startedAt,
        state: workerRuntime.state,
        version: workerRuntime.version,
      })
      .from(workerRuntime)
      .where(eq(workerRuntime.singletonKey, 'telegram'))
      .limit(1);
    return publicStatus(row, now);
  }

  async getHealthyInstance(instanceId: string, now = new Date()): Promise<WorkerHealth | null> {
    const [row] = await this.database
      .select({
        heartbeatAt: workerRuntime.heartbeatAt,
        instanceId: workerRuntime.instanceId,
        state: workerRuntime.state,
        version: workerRuntime.version,
      })
      .from(workerRuntime)
      .where(
        and(
          eq(workerRuntime.singletonKey, 'telegram'),
          eq(workerRuntime.instanceId, instanceId),
          eq(workerRuntime.state, 'running'),
        ),
      )
      .limit(1);

    if (!row || now.getTime() - row.heartbeatAt.getTime() > WORKER_HEARTBEAT_STALE_AFTER_MS) {
      return null;
    }
    return {
      heartbeatAt: row.heartbeatAt.toISOString(),
      instanceId: row.instanceId,
      version: row.version,
    };
  }

  private async updateOwned(
    instanceId: string,
    values: Partial<typeof workerRuntime.$inferInsert>,
  ): Promise<void> {
    const updated = await this.database
      .update(workerRuntime)
      .set(values)
      .where(
        and(eq(workerRuntime.singletonKey, 'telegram'), eq(workerRuntime.instanceId, instanceId)),
      )
      .returning({ singletonKey: workerRuntime.singletonKey });
    if (updated.length !== 1) {
      throw new Error('Worker runtime heartbeat ownership was lost');
    }
  }
}
