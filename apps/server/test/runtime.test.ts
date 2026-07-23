import { describe, expect, it, vi } from 'vitest';
import { ApplicationRuntime, type RuntimeCollector } from '../src/runtime.js';

describe('application runtime', () => {
  it('stops collector, HTTP server, and database once in order', async () => {
    const order: string[] = [];
    const collector: RuntimeCollector = {
      done: Promise.resolve(),
      stop: vi.fn(async () => {
        order.push('collector');
      }),
    };
    const runtime = new ApplicationRuntime(
      collector,
      async () => {
        order.push('http');
      },
      async () => {
        order.push('database');
      },
    );

    await Promise.all([runtime.stop(), runtime.stop()]);

    expect(order).toEqual(['collector', 'http', 'database']);
    expect(collector.stop).toHaveBeenCalledOnce();
  });

  it('continues releasing resources after a collector stop error', async () => {
    const error = new Error('collector failed');
    const closeHttp = vi.fn(async () => {});
    const closeDatabase = vi.fn(async () => {});
    const runtime = new ApplicationRuntime(
      {
        done: Promise.reject(error),
        stop: async () => {
          throw error;
        },
      },
      closeHttp,
      closeDatabase,
    );

    await expect(runtime.stop()).rejects.toBe(error);
    expect(closeHttp).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();

    await runtime.done.catch(() => {});
  });
});
