import { describe, expect, it, vi } from 'vitest';
import { ServerRuntime, WorkerRuntime, type WorkerRuntimeDependencies } from '../src/runtime.js';

function pending(): Promise<void> {
  return new Promise(() => {});
}

function workerDependencies(
  order: string[],
  overrides: Partial<WorkerRuntimeDependencies> = {},
): WorkerRuntimeDependencies {
  return {
    closeMainDatabase: vi.fn(async () => {
      order.push('main-database');
    }),
    heartbeat: {
      claim: vi.fn(async () => {
        order.push('heartbeat:starting');
      }),
      heartbeat: vi.fn(async () => {}),
      markRunning: vi.fn(async () => {
        order.push('heartbeat:running');
      }),
      markStopping: vi.fn(async () => {
        order.push('heartbeat:stopping');
        return true;
      }),
    },
    inbox: {
      acquirePollerLock: vi.fn(async () => {
        order.push('lock');
      }),
      close: vi.fn(async () => {
        order.push('polling-database');
      }),
    },
    poller: {
      done: pending(),
      authenticate: vi.fn(async () => {
        order.push('telegram-identity');
      }),
      initialize: vi.fn(async () => {
        order.push('poller:initialize');
      }),
      start: vi.fn(() => {
        order.push('poller:start');
        return pending();
      }),
      stop: vi.fn(async () => {
        order.push('poller:stop');
      }),
    },
    workers: {
      done: pending(),
      start: vi.fn(() => {
        order.push('tasks:start');
        return pending();
      }),
      stop: vi.fn(async () => {
        order.push('tasks:stop');
      }),
    },
    ...overrides,
  };
}

describe('server runtime', () => {
  it('stops HTTP before the database and only once', async () => {
    const order: string[] = [];
    const runtime = new ServerRuntime(
      pending(),
      async () => {
        order.push('http');
      },
      async () => {
        order.push('database');
      },
    );

    await Promise.all([runtime.stop(), runtime.stop()]);

    expect(order).toEqual(['http', 'database']);
  });

  it('continues closing the database after an HTTP close error', async () => {
    const error = new Error('HTTP close failed');
    const closeDatabase = vi.fn(async () => {});
    const runtime = new ServerRuntime(
      pending(),
      async () => {
        throw error;
      },
      closeDatabase,
    );

    await expect(runtime.stop()).rejects.toBe(error);
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});

describe('worker runtime', () => {
  it('owns the leader lock before starting poller and tasks, then stops in order', async () => {
    const order: string[] = [];
    const dependencies = workerDependencies(order);
    const runtime = new WorkerRuntime('worker-one', dependencies, 60_000);

    await runtime.start();
    expect(order).toEqual([
      'lock',
      'telegram-identity',
      'heartbeat:starting',
      'poller:initialize',
      'poller:start',
      'tasks:start',
      'heartbeat:running',
    ]);

    await Promise.all([runtime.stop(), runtime.stop()]);
    await expect(runtime.done).resolves.toBeUndefined();
    expect(order.slice(7)).toEqual([
      'heartbeat:stopping',
      'poller:stop',
      'tasks:stop',
      'polling-database',
      'main-database',
    ]);
  });

  it('refreshes heartbeat on schedule and stops refreshing during shutdown', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const dependencies = workerDependencies(order);
      const runtime = new WorkerRuntime('worker-one', dependencies, 10_000);

      await runtime.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(dependencies.heartbeat.heartbeat).toHaveBeenCalledOnce();

      await runtime.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(dependencies.heartbeat.heartbeat).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails before Telegram, heartbeat, poller, or tasks when the leader lock is held', async () => {
    const order: string[] = [];
    const lockError = new Error('Another Telegram poller already owns this database');
    const dependencies = workerDependencies(order, {
      inbox: {
        acquirePollerLock: vi.fn(async () => {
          order.push('lock');
          throw lockError;
        }),
        close: vi.fn(async () => {
          order.push('polling-database');
        }),
      },
    });
    const runtime = new WorkerRuntime('worker-two', dependencies, 60_000);
    const done = runtime.done.catch((error: unknown) => error);

    await expect(runtime.start()).rejects.toBe(lockError);
    await expect(done).resolves.toBe(lockError);
    expect(order).toEqual([
      'lock',
      'poller:stop',
      'tasks:stop',
      'polling-database',
      'main-database',
    ]);
    expect(dependencies.heartbeat.claim).not.toHaveBeenCalled();
    expect(dependencies.poller.authenticate).not.toHaveBeenCalled();
    expect(dependencies.poller.initialize).not.toHaveBeenCalled();
    expect(dependencies.poller.start).not.toHaveBeenCalled();
    expect(dependencies.workers.start).not.toHaveBeenCalled();
  });
});
