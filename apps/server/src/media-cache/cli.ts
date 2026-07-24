import { type MediaCacheConfig, parseTelegramChannelId } from '../config.js';
import { createDatabaseConnection } from '../db/client.js';
import { PostgresMediaCacheAdminRepository } from './admin-repository.js';
import { LocalMediaBlobStore } from './blob-store.js';
import { DesktopImportMediaCacheService } from './desktop-import-service.js';
import { PostgresMediaCacheDiscoveryRepository } from './discovery-repository.js';
import { MediaCacheMaintenanceService } from './maintenance-service.js';

const MAX_CACHE_BYTES = 5n * 1024n * 1024n * 1024n;
const MAX_SCOPED_SCAN_PAGES = 10_000;

export interface RunMediaCacheCliInput {
  apply: boolean;
  channels?: readonly string[];
  databaseUrl: string;
  desktopRoot?: string;
  importRunId?: string;
  inputPath?: string;
  json: boolean;
  mediaCache: MediaCacheConfig;
  reason?: string;
  subcommand: string | undefined;
  targetBytes?: string;
}

export async function runMediaCacheCli(input: RunMediaCacheCliInput): Promise<void> {
  if (!['cache', 'prune', 'reconcile', 'scan', 'status'].includes(input.subcommand ?? '')) {
    throw new Error('media command must be status, scan, cache, prune, or reconcile');
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
      id: `cli:${process.pid}`,
      kind: 'local_operator' as const,
      reason: input.apply ? requiredReason(input.reason) : 'dry_run',
    };
    if (input.subcommand === 'prune') {
      const targetBytes = parseTargetBytes(input.targetBytes, BigInt(input.mediaCache.maxBytes));
      const result = await maintenance.prune({
        apply: input.apply,
        initiator,
        targetBytes,
      });
      printReport({ result, schemaVersion: 1 }, input.json, [
        `mode: ${result.applied ? 'apply' : 'dry-run'}`,
        `ready bytes: ${result.readyBytes}`,
        `target bytes: ${result.targetBytes}`,
        `candidate blobs: ${result.candidates}`,
        `removable bytes: ${result.removedBytes}`,
        `has more: ${result.hasMore}`,
      ]);
      return;
    }

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

function parseTargetBytes(value: string | undefined, defaultValue: bigint): bigint {
  if (value === undefined) return defaultValue;
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw new Error('--target-bytes must be a whole byte count');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_CACHE_BYTES) {
    throw new Error('--target-bytes cannot exceed 5 GiB');
  }
  return parsed;
}

function requiredReason(value: string | undefined): string {
  const reason = value?.trim() ?? '';
  if (!reason || reason.length > 500) {
    throw new Error('--apply requires --reason with 1 to 500 characters');
  }
  return reason;
}

function printReport(report: Record<string, unknown>, json: boolean, lines: string[]): void {
  process.stdout.write(json ? `${JSON.stringify(report)}\n` : `${lines.join('\n')}\n`);
}
