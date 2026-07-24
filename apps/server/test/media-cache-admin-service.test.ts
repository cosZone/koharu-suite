import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.js';
import { PostgresMediaCacheAdminService } from '../src/media-cache/admin-service.js';
import type { PostgresMediaCacheCommandQueue } from '../src/media-cache/command-queue.js';
import type { PostgresStoragePruneService } from '../src/media-cache/storage-prune-service.js';

describe('media cache Admin service input boundary', () => {
  it('rejects a zero-byte prune preview before calling the planner', async () => {
    const preview = vi.fn();
    const service = new PostgresMediaCacheAdminService({} as Database, {
      storagePrune: { preview } as unknown as PostgresStoragePruneService,
    });

    await expect(
      service.previewPrune({ targetBackendId: 'local', targetBytes: 0n }),
    ).rejects.toThrow('between 1 byte and 5 TiB');
    expect(preview).not.toHaveBeenCalled();
  });

  it('rejects a zero-byte prune command before reading storage state or enqueueing', async () => {
    const enqueue = vi.fn();
    const service = new PostgresMediaCacheAdminService({} as Database, {
      commands: { enqueue } as unknown as PostgresMediaCacheCommandQueue,
      storagePrune: { preview: vi.fn() } as unknown as PostgresStoragePruneService,
    });

    await expect(
      service.prune({
        initiatorId: 'owner-user-id',
        reason: 'zero is not a durable capacity target',
        targetBackendId: 'local',
        targetBytes: 0n,
      }),
    ).rejects.toThrow('between 1 byte and 5 TiB');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
