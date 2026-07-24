import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.js';
import { sanitizeMediaCacheCommandResult } from '../src/media-cache/admin-repository.js';
import {
  type ClaimedMediaCacheCommand,
  type CommandStorageOperationInput,
  type CommandStorageOperations,
  type MediaCacheCommandInput,
  MediaCacheCommandProcessor,
  type MediaCacheCommandQueueControl,
  PostgresMediaCacheCommandQueue,
} from '../src/media-cache/command-queue.js';

const COMMAND_ID = '00000000-0000-4000-8000-000000000001';

function createEnqueueHarness() {
  const values = vi.fn((value: unknown) => ({
    returning: vi.fn(async () => [{ id: COMMAND_ID }]),
    value,
  }));
  const insert = vi.fn(() => ({ values }));
  return {
    database: { insert } as unknown as Database,
    insert,
    values,
  };
}

describe('media cache command payloads', () => {
  it.each([
    {
      expected: { objectId: 'object-1', operation: 'evict' },
      input: { objectId: ' object-1 ', operation: 'evict' },
    },
    {
      expected: { operation: 'reconcile' },
      input: { operation: 'reconcile' },
    },
    {
      expected: {
        objectId: 'object-1',
        operation: 'migrate',
        sourceBackendId: 'local',
        targetBackendId: 's3-default',
      },
      input: {
        objectId: ' object-1 ',
        operation: 'migrate',
        sourceBackendId: ' local ',
        targetBackendId: ' s3-default ',
      },
    },
    {
      expected: {
        operation: 'migrate',
        sourceBackendId: 'local',
        targetBackendId: 's3-default',
      },
      input: {
        operation: 'migrate',
        sourceBackendId: 'local',
        targetBackendId: 's3-default',
      },
    },
    {
      expected: {
        objectId: 'object-1',
        operation: 'restore',
        targetBackendId: 'local',
      },
      input: {
        objectId: ' object-1 ',
        operation: 'restore',
        targetBackendId: ' local ',
      },
    },
    {
      expected: {
        operation: 'prune',
        targetBackendId: 's3-default',
        targetBytes: 1024n,
      },
      input: {
        operation: 'prune',
        targetBackendId: ' s3-default ',
        targetBytes: 1024n,
      },
    },
  ] satisfies Array<{
    expected: Record<string, unknown>;
    input: Omit<MediaCacheCommandInput, 'initiatorId' | 'reason'>;
  }>)('normalizes and enqueues $input.operation payloads', async ({ expected, input }) => {
    const harness = createEnqueueHarness();
    const queue = new PostgresMediaCacheCommandQueue(harness.database);

    await expect(
      queue.enqueue({
        ...input,
        initiatorId: ' owner ',
        reason: ' requested ',
      } as MediaCacheCommandInput),
    ).resolves.toEqual({
      commandId: COMMAND_ID,
      operation: input.operation,
      state: 'pending',
    });
    expect(harness.values).toHaveBeenCalledWith({
      ...expected,
      initiatorId: 'owner',
      reason: 'requested',
    });
  });

  it.each([
    { objectId: '', operation: 'evict' },
    { objectId: 'unexpected', operation: 'reconcile' },
    {
      operation: 'migrate',
      sourceBackendId: ' local ',
      targetBackendId: 'local',
    },
    {
      operation: 'migrate',
      sourceBackendId: ' ',
      targetBackendId: 's3-default',
    },
    {
      objectId: ' ',
      operation: 'restore',
      targetBackendId: 'local',
    },
    {
      operation: 'prune',
      targetBackendId: 's3-default',
      targetBytes: -1n,
    },
    {
      operation: 'prune',
      targetBackendId: 's3-default',
      targetBytes: 10,
    },
  ])('rejects invalid $operation payloads before touching PostgreSQL', async (input) => {
    const harness = createEnqueueHarness();
    const queue = new PostgresMediaCacheCommandQueue(harness.database);

    await expect(
      queue.enqueue({
        ...input,
        initiatorId: 'owner',
        reason: 'requested',
      } as never),
    ).rejects.toThrow(TypeError);
    expect(harness.insert).not.toHaveBeenCalled();
  });
});

function claimed(operation: ClaimedMediaCacheCommand['operation']): ClaimedMediaCacheCommand {
  const common = {
    id: COMMAND_ID,
    initiatorId: 'owner',
    reason: 'requested',
    token: '00000000-0000-4000-8000-000000000002',
  };
  switch (operation) {
    case 'evict':
      return {
        ...common,
        objectId: 'object-1',
        operation,
        sourceBackendId: null,
        targetBackendId: null,
        targetBytes: null,
      };
    case 'migrate':
      return {
        ...common,
        objectId: 'object-1',
        operation,
        sourceBackendId: 'local',
        targetBackendId: 's3-default',
        targetBytes: null,
      };
    case 'prune':
      return {
        ...common,
        objectId: null,
        operation,
        sourceBackendId: null,
        targetBackendId: 's3-default',
        targetBytes: 1024n,
      };
    case 'reconcile':
      return {
        ...common,
        objectId: null,
        operation,
        sourceBackendId: null,
        targetBackendId: null,
        targetBytes: null,
      };
    case 'restore':
      return {
        ...common,
        objectId: 'object-1',
        operation,
        sourceBackendId: null,
        targetBackendId: 'local',
        targetBytes: null,
      };
  }
}

function createControl(command: ClaimedMediaCacheCommand): MediaCacheCommandQueueControl & {
  fail: ReturnType<typeof vi.fn>;
  renew: ReturnType<typeof vi.fn>;
  succeed: ReturnType<typeof vi.fn>;
} {
  let next: ClaimedMediaCacheCommand | null = command;
  return {
    claim: vi.fn(async () => {
      const result = next;
      next = null;
      return result;
    }),
    fail: vi.fn(async () => undefined),
    renew: vi.fn(async () => undefined),
    succeed: vi.fn(async () => undefined),
  };
}

function createStorageOperations() {
  return {
    migrate: vi.fn(async (input: CommandStorageOperationInput<'migrate'>) => {
      await input.renewLease();
      return {
        alreadyApplied: false,
        endpoint: 'https://secret.invalid',
        migratedBlobCount: 2,
        migratedBytes: '256',
        objectKey: 'blobs/private',
        sourceBackendId: 'local',
        targetBackendId: 's3-default',
      };
    }),
    prune: vi.fn(async (_input: CommandStorageOperationInput<'prune'>) => ({
      hasMore: true,
      providerError: 'AccessKey=secret',
      prunedBlobCount: 3,
      prunedBytes: '384',
      readyBytes: '640',
      targetBackendId: 's3-default',
    })),
    restore: vi.fn(async (_input: CommandStorageOperationInput<'restore'>) => ({
      alreadyApplied: true,
      providerVersion: 'private-version',
      restoredBytes: '128',
      restoredObjectCount: 1,
      targetBackendId: 'local',
    })),
  } satisfies CommandStorageOperations;
}

describe('media cache command dispatch', () => {
  it.each([
    {
      expected: {
        alreadyApplied: false,
        migratedBlobCount: 2,
        migratedBytes: '256',
        sourceBackendId: 'local',
        targetBackendId: 's3-default',
      },
      operation: 'migrate' as const,
    },
    {
      expected: {
        hasMore: true,
        prunedBlobCount: 3,
        prunedBytes: '384',
        readyBytes: '640',
        targetBackendId: 's3-default',
      },
      operation: 'prune' as const,
    },
    {
      expected: {
        alreadyApplied: true,
        restoredBytes: '128',
        restoredObjectCount: 1,
        targetBackendId: 'local',
      },
      operation: 'restore' as const,
    },
  ])('dispatches and sanitizes $operation results', async ({ expected, operation }) => {
    const command = claimed(operation);
    const control = createControl(command);
    const operations = createStorageOperations();
    const controller = new AbortController();
    const processor = new MediaCacheCommandProcessor(
      {} as Database,
      control,
      { evict: vi.fn() },
      { reconcile: vi.fn() },
      'worker:test',
      operations,
    );

    await expect(processor.runOnce(controller.signal)).resolves.toBe(true);
    expect(operations[operation]).toHaveBeenCalledOnce();
    expect(operations[operation].mock.calls[0]?.[0]).toMatchObject({
      command,
      signal: controller.signal,
    });
    expect(operations[operation].mock.calls[0]?.[0].renewLease).toBeTypeOf('function');
    expect(control.renew).toHaveBeenCalledWith(command);
    expect(control.renew).toHaveBeenCalledTimes(operation === 'migrate' ? 2 : 1);
    expect(control.succeed).toHaveBeenCalledWith(command, expected);
    expect(JSON.stringify(control.succeed.mock.calls[0]?.[1])).not.toContain('secret');
    expect(JSON.stringify(control.succeed.mock.calls[0]?.[1])).not.toContain('blobs/private');
    expect(control.fail).not.toHaveBeenCalled();
  });

  it('keeps local-only reconcile available without storage operations', async () => {
    const command = claimed('reconcile');
    const control = createControl(command);
    const reconcile = vi.fn(async () => ({
      applied: true,
      checked: 1,
      checksumMismatch: 0,
      hasMore: false,
      ledger: {
        drift: false,
        expectedReadyBytes: '0',
        expectedReservedBytes: '0',
        readyBytes: '0',
        repaired: false,
        reservedBytes: '0',
      },
      missing: 0,
      nextCursor: null,
      orphans: { failed: 0, found: 0, recovered: 0 },
      repairFailed: 0,
      repaired: 0,
    }));
    const processor = new MediaCacheCommandProcessor(
      {} as Database,
      control,
      { evict: vi.fn() },
      { reconcile },
      'worker:test',
    );

    await expect(processor.runOnce()).resolves.toBe(true);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(control.succeed).toHaveBeenCalledWith(command, {
      checked: 1,
      missing: 0,
      orphanFailed: 0,
      orphanFound: 0,
      orphanRecovered: 0,
      pages: 1,
      repairFailed: 0,
      repaired: 0,
    });
  });

  it('fails new operations predictably when no storage implementation is injected', async () => {
    const command = claimed('migrate');
    const control = createControl(command);
    const processor = new MediaCacheCommandProcessor(
      {} as Database,
      control,
      { evict: vi.fn() },
      { reconcile: vi.fn() },
      'worker:test',
    );

    await expect(processor.runOnce()).resolves.toBe(true);
    expect(control.fail).toHaveBeenCalledWith(command, 'storage_operation_unavailable');
    expect(control.succeed).not.toHaveBeenCalled();
  });

  it('classifies provider diagnostics without persisting them', async () => {
    const command = claimed('restore');
    const control = createControl(command);
    const operations = createStorageOperations();
    operations.restore.mockRejectedValueOnce(
      new Error('https://secret.invalid/bucket AccessKey=private'),
    );
    const processor = new MediaCacheCommandProcessor(
      {} as Database,
      control,
      { evict: vi.fn() },
      { reconcile: vi.fn() },
      'worker:test',
      operations,
    );

    await expect(processor.runOnce()).resolves.toBe(true);
    expect(control.fail).toHaveBeenCalledWith(command, 'operation_failed');
    expect(JSON.stringify(control.fail.mock.calls)).not.toContain('secret.invalid');
    expect(JSON.stringify(control.fail.mock.calls)).not.toContain('AccessKey');
  });
});

describe('media cache command result status sanitization', () => {
  it('keeps only operation-specific public storage metrics', () => {
    expect(
      sanitizeMediaCacheCommandResult('migrate', {
        endpoint: 'https://secret.invalid',
        migratedBlobCount: 2,
        migratedBytes: '256',
        objectKey: 'blobs/private',
        prunedBlobCount: 99,
        sourceBackendId: 'local',
        targetBackendId: 's3-default',
      }),
    ).toEqual({
      migratedBlobCount: 2,
      migratedBytes: '256',
      sourceBackendId: 'local',
      targetBackendId: 's3-default',
    });
  });

  it('rejects malformed public metrics instead of coercing them', () => {
    expect(
      sanitizeMediaCacheCommandResult('prune', {
        hasMore: 'true',
        prunedBlobCount: -1,
        prunedBytes: 384,
        readyBytes: '001',
        targetBackendId: 'https://secret.invalid',
      }),
    ).toEqual({});
  });
});
