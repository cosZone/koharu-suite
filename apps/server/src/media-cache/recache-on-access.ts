import type { PostgresMediaCacheCommandQueue } from './command-queue.js';

export interface MediaRecacheObserver {
  observe(objectId: string, backendId: string): void;
}

export class DurableMediaRecacheObserver implements MediaRecacheObserver {
  constructor(private readonly commands: PostgresMediaCacheCommandQueue) {}

  observe(objectId: string, backendId: string): void {
    if (backendId === 'local') return;
    void this.commands
      .enqueueRecacheOnAccess({ objectId, sourceBackendId: backendId })
      .catch(() => {
        // Public delivery already succeeded. Scheduling is durable and best-effort.
      });
  }
}
