import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.js';
import type { CommandStorageOperationInput } from '../src/media-cache/command-queue.js';
import type {
  PersistentBlobBackend,
  PersistentBlobBackendRegistry,
} from '../src/media-cache/local-persistent-blob-backend.js';
import { PostgresStoragePruneService } from '../src/media-cache/storage-prune-service.js';

function pruneInput(
  targetBytes: bigint,
  signal?: AbortSignal,
): CommandStorageOperationInput<'prune'> {
  return {
    command: {
      id: randomUUID(),
      initiatorId: 'owner',
      initiatorKind: 'owner_session',
      objectId: null,
      operation: 'prune',
      reason: 'unit test prune',
      sourceBackendId: null,
      targetBackendId: 's3-default',
      targetBytes,
      token: randomUUID(),
    },
    renewLease: vi.fn(async () => undefined),
    ...(signal ? { signal } : {}),
  };
}

function service(input: { backend?: PersistentBlobBackend } = {}): PostgresStoragePruneService {
  const backend =
    input.backend ??
    ({
      id: 's3-default',
    } as PersistentBlobBackend);
  const registry = {
    get: vi.fn(() => backend),
  } as unknown as PersistentBlobBackendRegistry;
  return new PostgresStoragePruneService({} as Database, registry);
}

describe('PostgresStoragePruneService input boundary', () => {
  it('rejects a negative preview or apply target before touching storage', async () => {
    const prune = service();

    await expect(
      prune.preview({ targetBackendId: 's3-default', targetBytes: -1n }),
    ).rejects.toThrow('must not be negative');
    await expect(prune.apply(pruneInput(-1n))).rejects.toThrow('must not be negative');
  });

  it('honors an already-aborted command before renewing a lease or deleting a blob', async () => {
    const deleteBlob = vi.fn(async () => 'absent_or_deleted' as const);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const input = pruneInput(0n, controller.signal);
    const prune = service({
      backend: {
        delete: deleteBlob,
        id: 's3-default',
      } as unknown as PersistentBlobBackend,
    });

    await expect(prune.apply(input)).rejects.toThrow('cancelled');
    expect(input.renewLease).not.toHaveBeenCalled();
    expect(deleteBlob).not.toHaveBeenCalled();
  });
});
