import { type MediaCacheConfig, parseTelegramChannelId } from '../config.js';
import { createDatabaseConnection } from '../db/client.js';
import { PostgresMediaCacheAdminRepository } from './admin-repository.js';
import { LocalMediaBlobStore } from './blob-store.js';
import { PostgresMediaCacheCommandQueue } from './command-queue.js';
import { DesktopImportMediaCacheService } from './desktop-import-service.js';
import { PostgresMediaCacheDiscoveryRepository } from './discovery-repository.js';
import { PersistentBlobBackendRegistry } from './local-persistent-blob-backend.js';
import { MediaCacheMaintenanceService } from './maintenance-service.js';
import { PostgresMediaCacheObjectPolicyService } from './object-policy-service.js';
import { PostgresStoragePruneService } from './storage-prune-service.js';

const MAX_STORAGE_BYTES = 5n * 1024n * 1024n * 1024n * 1024n;
const MAX_SCOPED_SCAN_PAGES = 10_000;
const MEDIA_OBJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STORAGE_BACKEND_IDS = ['local', 's3-default'] as const;

type StorageBackendId = (typeof STORAGE_BACKEND_IDS)[number];

export interface RunMediaCacheCliInput {
  apply: boolean;
  backend?: string;
  channels?: readonly string[];
  databaseUrl: string;
  desktopRoot?: string;
  from?: string;
  importRunId?: string;
  inputPath?: string;
  json: boolean;
  mediaCache: MediaCacheConfig;
  objectId?: string;
  policy?: string;
  reason?: string;
  subcommand: string | undefined;
  targetBytes?: string;
  to?: string;
}

export async function runMediaCacheCli(input: RunMediaCacheCliInput): Promise<void> {
  if (
    ![
      'cache',
      'copy',
      'policy',
      'protect',
      'prune',
      'reconcile',
      'restore',
      'scan',
      'status',
      'unprotect',
    ].includes(input.subcommand ?? '')
  ) {
    throw new Error(
      'media command must be status, scan, cache, copy, restore, protect, unprotect, policy, prune, or reconcile',
    );
  }
  if (input.subcommand === 'cache') {
    if (!input.apply) {
      throw new Error('media cache requires --apply');
    }
    if (!input.importRunId || !input.inputPath || !input.desktopRoot) {
      throw new Error('media cache requires --import-run, --input, and --desktop-root');
    }
    if (!input.mediaCache.enabled) {
      throw new Error('media cache requires MEDIA_CACHE_ENABLED=true');
    }
  }
  const storageInput = parseStorageInput(input);
  const scanChannelIds =
    input.subcommand === 'scan' && (input.channels?.length ?? 0) > 0
      ? input.channels?.map(parseTelegramChannelId)
      : undefined;
  const connection = createDatabaseConnection(input.databaseUrl);
  try {
    if (input.subcommand === 'status') {
      const status = await new PostgresMediaCacheAdminRepository(connection.db, {
        enabled: input.mediaCache.enabled,
        maxBytes: input.mediaCache.maxBytes,
      }).getStatus();
      printReport(
        {
          schemaVersion: 1,
          status,
        },
        input.json,
        [
          `enabled: ${status.enabled}`,
          `ready: ${status.usage.readyBytes}`,
          `reserved: ${status.usage.reservedBytes}`,
          `max: ${status.usage.maxBytes}`,
          `objects: ${status.stateCounts.objects.map(({ count, state }) => `${state}=${count}`).join(', ') || 'none'}`,
          `backends: ${status.backends?.map(({ id, readyBytes }) => `${id}=${readyBytes}`).join(', ') || 'none'}`,
          `recent failures: ${status.failures.length}`,
        ],
      );
      return;
    }

    if (input.subcommand === 'scan') {
      const repository = new PostgresMediaCacheDiscoveryRepository(connection.db);
      const result = scanChannelIds
        ? await runScopedDiscovery(repository, scanChannelIds)
        : await repository.discoverBatch().then((batch) => ({
            hasMore: batch.hasMore ?? false,
            objectsCreated: batch.objectsCreated,
            plansCreated: batch.plansCreated,
            scanned: batch.scanned,
            sourcesCreated: batch.sourcesCreated,
          }));
      printReport(
        {
          result,
          schemaVersion: 1,
        },
        input.json,
        [
          `scanned evidence: ${result.scanned}`,
          `plans created: ${result.plansCreated}`,
          `objects created: ${result.objectsCreated}`,
          `sources created: ${result.sourcesCreated}`,
          `has more: ${result.hasMore}`,
        ],
      );
      return;
    }

    const initiatorId = `cli:${process.pid}`;
    if (storageInput?.kind === 'copy') {
      const receipt = await new PostgresMediaCacheCommandQueue(connection.db).enqueue({
        initiatorId,
        initiatorKind: 'local_operator',
        ...(storageInput.objectId !== undefined ? { objectId: storageInput.objectId } : {}),
        operation: 'migrate',
        reason: storageInput.reason,
        sourceBackendId: storageInput.from,
        targetBackendId: storageInput.to,
      });
      printCommandReceipt(receipt, input.json);
      return;
    }
    if (storageInput?.kind === 'restore') {
      const receipt = await new PostgresMediaCacheCommandQueue(connection.db).enqueue({
        initiatorId,
        initiatorKind: 'local_operator',
        objectId: storageInput.objectId,
        operation: 'restore',
        reason: storageInput.reason,
        targetBackendId: storageInput.to,
      });
      printCommandReceipt(receipt, input.json);
      return;
    }
    if (storageInput?.kind === 'protect' || storageInput?.kind === 'unprotect') {
      const service = new PostgresMediaCacheObjectPolicyService(connection.db);
      const result = await service[storageInput.kind]({
        initiator: {
          id: initiatorId,
          kind: 'local_operator',
          reason: storageInput.reason,
        },
        objectId: storageInput.objectId,
      });
      printReport({ result, schemaVersion: 1 }, input.json, [
        `object: ${result.objectId}`,
        `protected: ${result.protected}`,
        `already applied: ${result.alreadyApplied}`,
      ]);
      return;
    }
    if (storageInput?.kind === 'policy') {
      const result = await new PostgresMediaCacheObjectPolicyService(
        connection.db,
      ).setEvictedPolicy({
        initiator: {
          id: initiatorId,
          kind: 'local_operator',
          reason: storageInput.reason,
        },
        objectId: storageInput.objectId,
        policy: storageInput.policy,
      });
      printReport({ result, schemaVersion: 1 }, input.json, [
        `object: ${result.objectId}`,
        `policy: ${storageInput.displayPolicy}`,
        `already applied: ${result.alreadyApplied}`,
      ]);
      return;
    }
    if (storageInput?.kind === 'prune') {
      if (storageInput.apply) {
        const receipt = await new PostgresMediaCacheCommandQueue(connection.db).enqueue({
          initiatorId,
          initiatorKind: 'local_operator',
          operation: 'prune',
          reason: storageInput.reason,
          targetBackendId: storageInput.backend,
          targetBytes: storageInput.targetBytes,
        });
        printCommandReceipt(receipt, input.json);
        return;
      }
      const result = await new PostgresStoragePruneService(
        connection.db,
        new PersistentBlobBackendRegistry([]),
      ).preview({
        targetBackendId: storageInput.backend,
        targetBytes: storageInput.targetBytes,
      });
      printReport({ result, schemaVersion: 1 }, input.json, [
        'mode: preview',
        `backend: ${result.targetBackendId}`,
        `ready bytes: ${result.readyBytes}`,
        `target bytes: ${result.targetBytes}`,
        `candidate blobs: ${result.candidates}`,
        `removable bytes: ${result.removableBytes}`,
        `projected ready bytes: ${result.projectedReadyBytes}`,
        `has more: ${result.hasMore}`,
      ]);
      return;
    }

    const blobStore = new LocalMediaBlobStore(input.mediaCache.root);
    await blobStore.initialize();
    if (input.subcommand === 'cache') {
      const result = await new DesktopImportMediaCacheService(connection.db, blobStore, () =>
        new PostgresMediaCacheDiscoveryRepository(connection.db).discoverBatch(),
      ).run({
        desktopRoot: input.desktopRoot ?? '',
        importRunId: input.importRunId ?? '',
        inputPath: input.inputPath ?? '',
        initiatorId: `desktop-cli:${process.pid}`,
        reason: requiredReason(input.reason),
      });
      printReport({ result, schemaVersion: 1 }, input.json, [
        `status: ${result.status}`,
        `scanned evidence: ${result.scannedEvidence}`,
        `plans offered: ${result.offeredPlans}`,
        `plans completed: ${result.completedPlans}`,
        `plans failed: ${result.failedPlans}`,
        `plans unclaimed: ${result.unclaimedPlans}`,
        `objects audited: ${result.auditedObjects}`,
        `input stable: ${result.inputStable}`,
        `has more: ${result.hasMore}`,
      ]);
      return;
    }
    const maintenance = new MediaCacheMaintenanceService(
      connection.db,
      blobStore,
      `cli:${process.pid}`,
    );
    const initiator = {
      id: initiatorId,
      kind: 'local_operator' as const,
      reason: input.apply ? requiredReason(input.reason) : 'dry_run',
    };

    let cursor: string | undefined;
    let checked = 0;
    let checksumMismatch = 0;
    let missing = 0;
    let repaired = 0;
    let repairFailed = 0;
    let orphanFailed = 0;
    let orphanFound = 0;
    let orphanRecovered = 0;
    let ledger: Awaited<ReturnType<MediaCacheMaintenanceService['reconcile']>>['ledger'] | null =
      null;
    let hasMore = true;
    for (let page = 0; page < 10_000; page += 1) {
      const result = await maintenance.reconcile({
        apply: input.apply,
        ...(cursor ? { cursor } : {}),
        initiator,
      });
      checked += result.checked;
      checksumMismatch += result.checksumMismatch;
      missing += result.missing;
      repaired += result.repaired;
      repairFailed += result.repairFailed;
      orphanFailed += result.orphans.failed;
      orphanFound += result.orphans.found;
      orphanRecovered += result.orphans.recovered;
      ledger = result.ledger;
      if (!result.nextCursor) {
        hasMore = false;
        break;
      }
      if (result.nextCursor === cursor) {
        break;
      }
      cursor = result.nextCursor;
    }
    const result = {
      applied: input.apply,
      checked,
      checksumMismatch,
      hasMore,
      ledger,
      missing,
      orphans: {
        failed: orphanFailed,
        found: orphanFound,
        recovered: orphanRecovered,
      },
      repaired,
      repairFailed,
    };
    printReport({ result, schemaVersion: 1 }, input.json, [
      `mode: ${result.applied ? 'apply' : 'dry-run'}`,
      `checked: ${result.checked}`,
      `missing: ${result.missing}`,
      `checksum mismatch: ${result.checksumMismatch}`,
      `repaired: ${result.repaired}`,
      `repair failed: ${result.repairFailed}`,
      `has more: ${result.hasMore}`,
    ]);
  } finally {
    await connection.close();
  }
}

async function runScopedDiscovery(
  repository: PostgresMediaCacheDiscoveryRepository,
  channelIds: readonly bigint[],
): Promise<{
  hasMore: boolean;
  objectsCreated: number;
  plansCreated: number;
  scanned: number;
  sourcesCreated: number;
}> {
  let cursor = null;
  let hasMore = true;
  let objectsCreated = 0;
  let plansCreated = 0;
  let scanned = 0;
  let sourcesCreated = 0;
  for (let page = 0; page < MAX_SCOPED_SCAN_PAGES && hasMore; page += 1) {
    const batch = await repository.discoverScopedBatch(channelIds, cursor);
    objectsCreated += batch.objectsCreated;
    plansCreated += batch.plansCreated;
    scanned += batch.scanned;
    sourcesCreated += batch.sourcesCreated;
    hasMore = batch.hasMore;
    if (!hasMore) {
      break;
    }
    if (!batch.cursor || batch.cursor.id === cursor?.id) {
      break;
    }
    cursor = batch.cursor;
  }
  return { hasMore, objectsCreated, plansCreated, scanned, sourcesCreated };
}

type StorageCliInput =
  | {
      from: StorageBackendId;
      kind: 'copy';
      objectId?: string;
      reason: string;
      to: StorageBackendId;
    }
  | {
      kind: 'restore';
      objectId: string;
      reason: string;
      to: StorageBackendId;
    }
  | {
      kind: 'protect' | 'unprotect';
      objectId: string;
      reason: string;
    }
  | {
      displayPolicy: 'recache' | 'stay';
      kind: 'policy';
      objectId: string;
      policy: 'recache_on_access' | 'stay_evicted';
      reason: string;
    }
  | {
      apply: false;
      backend: StorageBackendId;
      kind: 'prune';
      targetBytes: bigint;
    }
  | {
      apply: true;
      backend: StorageBackendId;
      kind: 'prune';
      reason: string;
      targetBytes: bigint;
    };

function parseStorageInput(input: RunMediaCacheCliInput): StorageCliInput | null {
  if (input.subcommand === 'copy') {
    requireApply(input, 'media copy');
    const from = parseStorageBackend(input.from, '--from');
    const to = parseStorageBackend(input.to, '--to');
    if (from === to) {
      throw new Error('media copy requires different --from and --to backends');
    }
    return {
      from,
      kind: 'copy',
      ...(input.objectId !== undefined ? { objectId: parseObjectId(input.objectId) } : {}),
      reason: requiredReason(input.reason),
      to,
    };
  }
  if (input.subcommand === 'restore') {
    requireApply(input, 'media restore');
    return {
      kind: 'restore',
      objectId: parseObjectId(input.objectId),
      reason: requiredReason(input.reason),
      to: parseStorageBackend(input.to, '--to'),
    };
  }
  if (input.subcommand === 'protect' || input.subcommand === 'unprotect') {
    requireApply(input, `media ${input.subcommand}`);
    return {
      kind: input.subcommand,
      objectId: parseObjectId(input.objectId),
      reason: requiredReason(input.reason),
    };
  }
  if (input.subcommand === 'policy') {
    requireApply(input, 'media policy');
    if (input.policy !== 'recache' && input.policy !== 'stay') {
      throw new Error('media policy requires --policy recache or --policy stay');
    }
    return {
      displayPolicy: input.policy,
      kind: 'policy',
      objectId: parseObjectId(input.objectId),
      policy: input.policy === 'recache' ? 'recache_on_access' : 'stay_evicted',
      reason: requiredReason(input.reason),
    };
  }
  if (input.subcommand === 'prune') {
    const backend = parseStorageBackend(input.backend, '--backend');
    const targetBytes = parseTargetBytes(input.targetBytes);
    if (!input.apply) {
      if (input.reason !== undefined) {
        throw new Error('media prune --reason requires --apply');
      }
      return { apply: false, backend, kind: 'prune', targetBytes };
    }
    return {
      apply: true,
      backend,
      kind: 'prune',
      reason: requiredReason(input.reason),
      targetBytes,
    };
  }
  return null;
}

function parseTargetBytes(value: string | undefined): bigint {
  if (value === undefined) {
    throw new Error('media prune requires --target-bytes');
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error('--target-bytes must be a positive whole byte count');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_STORAGE_BYTES) {
    throw new Error('--target-bytes cannot exceed 5 TiB');
  }
  return parsed;
}

function parseStorageBackend(value: string | undefined, option: '--backend' | '--from' | '--to') {
  if (value === undefined) {
    throw new Error(`${option} is required`);
  }
  if (value !== 'local' && value !== 's3-default') {
    throw new Error(`${option} must be local or s3-default`);
  }
  return value;
}

function parseObjectId(value: string | undefined): string {
  if (!value || !MEDIA_OBJECT_ID_PATTERN.test(value)) {
    throw new Error('--object must be a UUID');
  }
  return value.toLowerCase();
}

function requireApply(input: RunMediaCacheCliInput, command: string): void {
  if (!input.apply) {
    throw new Error(`${command} requires --apply`);
  }
}

function requiredReason(value: string | undefined): string {
  const reason = value?.trim() ?? '';
  if (!reason || reason.length > 500) {
    throw new Error('--apply requires --reason with 1 to 500 characters');
  }
  return reason;
}

function printCommandReceipt(
  receipt: { commandId: string; operation: string; state: string },
  json: boolean,
): void {
  printReport({ result: receipt, schemaVersion: 1 }, json, [
    `queued: ${receipt.operation}`,
    `command: ${receipt.commandId}`,
    `state: ${receipt.state}`,
  ]);
}

function printReport(report: Record<string, unknown>, json: boolean, lines: string[]): void {
  process.stdout.write(json ? `${JSON.stringify(report)}\n` : `${lines.join('\n')}\n`);
}
