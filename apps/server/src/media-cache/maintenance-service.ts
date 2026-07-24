import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, notExists, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  mediaCacheActions,
  mediaCacheBlobs,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
} from '../db/schema.js';
import {
  type LocalMediaBlobStore,
  type MediaBlobIdentity,
  MediaBlobIntegrityError,
} from './blob-store.js';
import { MediaCacheEvictionService } from './eviction-repository.js';
import { MEDIA_CACHE_ADVISORY_LOCK } from './ledger-repository.js';

const MAX_MAINTENANCE_BATCH = 100;
const EVICTION_LEASE_MS = 2 * 60_000;

export interface MediaCacheMaintenanceInitiator {
  id: string;
  kind: 'local_operator' | 'owner_session';
  reason: string;
}

export interface MediaCachePruneResult {
  applied: boolean;
  candidates: number;
  hasMore: boolean;
  projectedReadyBytes: string;
  readyBytes: string;
  removedBytes: string;
  targetBytes: string;
}

export interface MediaCacheReconcileResult {
  applied: boolean;
  checked: number;
  checksumMismatch: number;
  hasMore: boolean;
  ledger: {
    drift: boolean;
    expectedReadyBytes: string;
    expectedReservedBytes: string;
    readyBytes: string;
    repaired: boolean;
    reservedBytes: string;
  };
  missing: number;
  nextCursor: string | null;
  orphans: {
    failed: number;
    found: number;
    recovered: number;
  };
  repaired: number;
  repairFailed: number;
}

interface MaintenanceBlob extends MediaBlobIdentity {
  lastAccessedAt: Date;
}

type MediaCacheTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class MediaCacheMaintenanceService {
  private readonly eviction: MediaCacheEvictionService;

  constructor(
    private readonly database: Database,
    private readonly blobStore: LocalMediaBlobStore,
    private readonly owner: string,
  ) {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner || normalizedOwner.length > 255) {
      throw new TypeError('Media cache maintenance owner must contain 1 to 255 characters');
    }
    this.owner = normalizedOwner;
    this.eviction = new MediaCacheEvictionService(database, blobStore);
  }

  async prune(input: {
    apply: boolean;
    initiator: MediaCacheMaintenanceInitiator;
    targetBytes: bigint;
  }): Promise<MediaCachePruneResult> {
    assertInitiator(input.initiator);
    if (input.targetBytes < 0n || input.targetBytes > 5n * 1024n * 1024n * 1024n) {
      throw new RangeError('Media cache prune target must be between 0 and 5 GiB');
    }
    const readyBytes = await this.readReadyBytes();
    if (readyBytes <= input.targetBytes) {
      return {
        applied: input.apply,
        candidates: 0,
        hasMore: false,
        projectedReadyBytes: readyBytes.toString(),
        readyBytes: readyBytes.toString(),
        removedBytes: '0',
        targetBytes: input.targetBytes.toString(),
      };
    }

    if (!input.apply) {
      const candidates = await this.listPruneCandidates();
      let projected = readyBytes;
      let selected = 0;
      let removed = 0n;
      for (const candidate of candidates) {
        if (projected <= input.targetBytes) break;
        projected -= BigInt(candidate.byteLength);
        removed += BigInt(candidate.byteLength);
        selected += 1;
      }
      return {
        applied: false,
        candidates: selected,
        hasMore: projected > input.targetBytes,
        projectedReadyBytes: projected.toString(),
        readyBytes: readyBytes.toString(),
        removedBytes: removed.toString(),
        targetBytes: input.targetBytes.toString(),
      };
    }

    let currentReadyBytes = readyBytes;
    let removedBytes = 0n;
    let candidates = 0;
    while (currentReadyBytes > input.targetBytes && candidates < MAX_MAINTENANCE_BATCH) {
      const now = await this.readDatabaseClock();
      const result = await this.eviction.evict({
        evictionExpiresAt: new Date(now.getTime() + EVICTION_LEASE_MS),
        evictionOwner: this.owner,
        evictionToken: randomUUID(),
        initiator: {
          initiatorId: input.initiator.id,
          kind: input.initiator.kind,
          reason: input.initiator.reason.trim(),
        },
        selection: { kind: 'least_recently_used' },
      });
      if (!result) break;
      currentReadyBytes = result.readyBytes;
      removedBytes += result.physicalBytesRemoved;
      candidates += 1;
    }
    return {
      applied: true,
      candidates,
      hasMore: currentReadyBytes > input.targetBytes,
      projectedReadyBytes: currentReadyBytes.toString(),
      readyBytes: currentReadyBytes.toString(),
      removedBytes: removedBytes.toString(),
      targetBytes: input.targetBytes.toString(),
    };
  }

  async reconcile(input: {
    apply: boolean;
    cursor?: string;
    initiator: MediaCacheMaintenanceInitiator;
  }): Promise<MediaCacheReconcileResult> {
    assertInitiator(input.initiator);
    const page = await this.listReadyBlobs(input.cursor);
    const orphans = input.cursor
      ? { failed: 0, found: 0, recovered: 0 }
      : await this.reconcileOrphans(input.apply);
    let checksumMismatch = 0;
    let missing = 0;
    let repaired = 0;
    let repairFailed = 0;

    for (const blob of page.blobs) {
      const issue = await this.checkBlob(blob);
      if (!issue) continue;
      if (issue === 'missing') {
        missing += 1;
      } else {
        checksumMismatch += 1;
      }
      if (!input.apply) continue;
      try {
        const now = await this.readDatabaseClock();
        const result = await this.eviction.evict({
          evictionExpiresAt: new Date(now.getTime() + EVICTION_LEASE_MS),
          evictionOwner: this.owner,
          evictionToken: randomUUID(),
          initiator: {
            initiatorId: input.initiator.id,
            kind: input.initiator.kind,
            reason: input.initiator.reason.trim(),
          },
          selection: { kind: 'specific_blob', sha256: blob.sha256 },
        });
        if (result) {
          repaired += 1;
        } else {
          repairFailed += 1;
        }
      } catch {
        repairFailed += 1;
      }
    }

    const ledger = await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${MEDIA_CACHE_ADVISORY_LOCK})`);
      const now = await readDatabaseClock(transaction);
      if (input.apply) {
        await transaction
          .insert(mediaCacheRuntime)
          .values({ singletonKey: 'local' })
          .onConflictDoNothing();
      }
      const [runtime] = await transaction
        .select({
          readyBytes: mediaCacheRuntime.readyBytes,
          reservedBytes: mediaCacheRuntime.reservedBytes,
        })
        .from(mediaCacheRuntime)
        .where(eq(mediaCacheRuntime.singletonKey, 'local'))
        .for('update');
      const current = runtime ?? { readyBytes: 0n, reservedBytes: 0n };
      const expected = await expectedLedgerBytes(transaction);
      const drift =
        current.readyBytes !== expected.readyBytes ||
        current.reservedBytes !== expected.reservedBytes;
      if (input.apply && drift) {
        await transaction
          .update(mediaCacheRuntime)
          .set({
            readyBytes: expected.readyBytes,
            reservedBytes: expected.reservedBytes,
            updatedAt: now,
          })
          .where(eq(mediaCacheRuntime.singletonKey, 'local'));
      }
      if (input.apply) {
        if (!page.nextCursor) {
          await transaction
            .update(mediaCacheRuntime)
            .set({ lastReconciledAt: now, updatedAt: now })
            .where(eq(mediaCacheRuntime.singletonKey, 'local'));
        }
        await transaction.insert(mediaCacheActions).values({
          actionKind: 'reconcile',
          afterState: {
            checked: page.blobs.length,
            checksumMismatch,
            hasMore: page.nextCursor !== null,
            missing,
            repairFailed,
            repaired,
            runtimeReadyBytes: current.readyBytes.toString(),
            runtimeReservedBytes: current.reservedBytes.toString(),
            expectedReadyBytes: expected.readyBytes.toString(),
            expectedReservedBytes: expected.reservedBytes.toString(),
            ledgerRepaired: input.apply && drift,
          },
          beforeState: {},
          initiatorId: input.initiator.id.trim(),
          initiatorKind: input.initiator.kind,
          reason: input.initiator.reason.trim(),
        });
        if (orphans.found > 0) {
          await transaction.insert(mediaCacheActions).values({
            actionKind: 'recover_orphan',
            afterState: orphans,
            beforeState: {},
            initiatorId: input.initiator.id.trim(),
            initiatorKind: input.initiator.kind,
            reason: input.initiator.reason.trim(),
          });
        }
      }
      return {
        drift,
        expectedReadyBytes: expected.readyBytes.toString(),
        expectedReservedBytes: expected.reservedBytes.toString(),
        readyBytes: current.readyBytes.toString(),
        repaired: input.apply && drift,
        reservedBytes: current.reservedBytes.toString(),
      };
    });

    return {
      applied: input.apply,
      checked: page.blobs.length,
      checksumMismatch,
      hasMore: page.nextCursor !== null,
      ledger,
      missing,
      nextCursor: page.nextCursor,
      orphans,
      repaired,
      repairFailed,
    };
  }

  private async readReadyBytes(): Promise<bigint> {
    const [runtime] = await this.database
      .select({ readyBytes: mediaCacheRuntime.readyBytes })
      .from(mediaCacheRuntime)
      .where(eq(mediaCacheRuntime.singletonKey, 'local'))
      .limit(1);
    return runtime?.readyBytes ?? 0n;
  }

  private async reconcileOrphans(
    apply: boolean,
  ): Promise<{ failed: number; found: number; recovered: number }> {
    const now = await this.readDatabaseClock();
    const before = new Date(now.getTime() - 60 * 60_000);
    let cursor: string | undefined;
    let failed = 0;
    let found = 0;
    let recovered = 0;
    do {
      const page = await this.blobStore.listStaleLeases({
        before,
        ...(cursor ? { cursor } : {}),
        limit: MAX_MAINTENANCE_BATCH,
      });
      for (const lease of page.leases) {
        if (await this.hasLeaseProvenance(lease)) continue;
        found += 1;
        if (!apply) continue;
        try {
          await this.blobStore.discardPartialLease(lease);
          const staged = await this.blobStore.recoverLease(lease);
          for (const blob of staged) {
            await this.blobStore.settle(blob, 'db_rolled_back');
          }
          recovered += 1;
        } catch {
          failed += 1;
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { failed, found, recovered };
  }

  private async hasLeaseProvenance(lease: {
    leaseToken: string;
    planId: string;
  }): Promise<boolean> {
    const [plans, objects] = await Promise.all([
      this.database
        .select({ id: mediaCachePostPlans.id })
        .from(mediaCachePostPlans)
        .where(
          and(
            eq(mediaCachePostPlans.id, lease.planId),
            eq(mediaCachePostPlans.leaseToken, lease.leaseToken),
            inArray(mediaCachePostPlans.state, ['recovering', 'reserved', 'settling', 'staging']),
          ),
        )
        .limit(1),
      this.database
        .select({ id: mediaCacheObjects.id })
        .from(mediaCacheObjects)
        .where(
          and(
            eq(mediaCacheObjects.postPlanId, lease.planId),
            eq(mediaCacheObjects.leaseToken, lease.leaseToken),
            inArray(mediaCacheObjects.state, ['downloading', 'reserved', 'staging']),
          ),
        )
        .limit(1),
    ]);
    return plans.length > 0 || objects.length > 0;
  }

  private async listPruneCandidates(): Promise<MaintenanceBlob[]> {
    const pinnedBySettlement = this.database
      .select({ one: sql`1` })
      .from(mediaCacheObjects)
      .innerJoin(mediaCachePostPlans, eq(mediaCachePostPlans.id, mediaCacheObjects.postPlanId))
      .where(
        and(
          eq(mediaCacheObjects.blobSha256, mediaCacheBlobs.sha256),
          inArray(mediaCachePostPlans.state, ['recovering', 'settling']),
        ),
      );
    return this.database
      .select({
        byteLength: mediaCacheBlobs.byteLength,
        lastAccessedAt: mediaCacheBlobs.lastAccessedAt,
        relativeKey: mediaCacheBlobs.relativeKey,
        sha256: mediaCacheBlobs.sha256,
      })
      .from(mediaCacheBlobs)
      .where(and(eq(mediaCacheBlobs.state, 'ready'), notExists(pinnedBySettlement)))
      .orderBy(asc(mediaCacheBlobs.lastAccessedAt), asc(mediaCacheBlobs.sha256))
      .limit(MAX_MAINTENANCE_BATCH)
      .then((rows) => rows.map(toMaintenanceBlob));
  }

  private async listReadyBlobs(
    cursor?: string,
  ): Promise<{ blobs: MaintenanceBlob[]; nextCursor: string | null }> {
    const cursorSha256 = cursor ? await this.resolveReconcileCursor(cursor) : undefined;
    const rows = await this.database
      .select({
        byteLength: mediaCacheBlobs.byteLength,
        lastAccessedAt: mediaCacheBlobs.lastAccessedAt,
        relativeKey: mediaCacheBlobs.relativeKey,
        sha256: mediaCacheBlobs.sha256,
      })
      .from(mediaCacheBlobs)
      .where(
        and(
          eq(mediaCacheBlobs.state, 'ready'),
          cursorSha256 ? gt(mediaCacheBlobs.sha256, cursorSha256) : undefined,
        ),
      )
      .orderBy(asc(mediaCacheBlobs.sha256))
      .limit(MAX_MAINTENANCE_BATCH + 1);
    const pageRows = rows.slice(0, MAX_MAINTENANCE_BATCH);
    const last = pageRows.at(-1);
    if (rows.length <= MAX_MAINTENANCE_BATCH || !last) {
      return { blobs: pageRows.map(toMaintenanceBlob), nextCursor: null };
    }
    const [nextCursor] = await this.database
      .select({ id: mediaCacheObjects.id })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.blobSha256, last.sha256))
      .orderBy(asc(mediaCacheObjects.id))
      .limit(1);
    if (!nextCursor) {
      throw new Error('Ready media cache blob has no object cursor');
    }
    return {
      blobs: pageRows.map(toMaintenanceBlob),
      nextCursor: nextCursor.id,
    };
  }

  private async resolveReconcileCursor(cursor: string): Promise<string> {
    if (!UUID.test(cursor)) {
      throw new RangeError('Media cache reconcile cursor is invalid');
    }
    const [object] = await this.database
      .select({ blobSha256: mediaCacheObjects.blobSha256 })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.id, cursor))
      .limit(1);
    if (!object?.blobSha256) {
      throw new RangeError('Media cache reconcile cursor is invalid');
    }
    return object.blobSha256;
  }

  private async readDatabaseClock(): Promise<Date> {
    return readDatabaseClock(this.database);
  }

  private async checkBlob(blob: MaintenanceBlob): Promise<'checksum_mismatch' | 'missing' | null> {
    let file: Awaited<ReturnType<LocalMediaBlobStore['open']>>;
    try {
      file = await this.blobStore.open(blob);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return 'missing';
      }
      if (error instanceof MediaBlobIntegrityError) {
        return isMissingBlobIntegrityError(error) ? 'missing' : 'checksum_mismatch';
      }
      throw error;
    }
    try {
      const hash = createHash('sha256');
      const stream = file.createReadStream({ autoClose: false, start: 0 });
      for await (const chunk of stream) {
        hash.update(chunk);
      }
      return hash.digest('hex') === blob.sha256 ? null : 'checksum_mismatch';
    } finally {
      await file.close().catch(() => undefined);
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isMissingBlobIntegrityError(error: MediaBlobIntegrityError): boolean {
  return (
    error.message === 'Required media blob directory is missing' ||
    error.message === 'Media blob store root became unavailable'
  );
}

async function expectedLedgerBytes(
  transaction: MediaCacheTransaction,
): Promise<{ readyBytes: bigint; reservedBytes: bigint }> {
  const [blobs, plans, thumbnails] = await Promise.all([
    transaction
      .select({
        bytes: sql<string>`coalesce(sum(${mediaCacheBlobs.byteLength}), 0)::text`,
      })
      .from(mediaCacheBlobs)
      .where(inArray(mediaCacheBlobs.state, ['deleting', 'ready'])),
    transaction
      .select({
        bytes: sql<string>`coalesce(sum(${mediaCachePostPlans.reservedOriginalBytes}), 0)::text`,
      })
      .from(mediaCachePostPlans),
    transaction
      .select({
        bytes: sql<string>`coalesce(sum(${mediaCacheObjects.reservedBytes}), 0)::text`,
      })
      .from(mediaCacheObjects)
      .where(eq(mediaCacheObjects.variant, 'thumbnail')),
  ]);
  return {
    readyBytes: BigInt(blobs[0]?.bytes ?? '0'),
    reservedBytes: BigInt(plans[0]?.bytes ?? '0') + BigInt(thumbnails[0]?.bytes ?? '0'),
  };
}

async function readDatabaseClock(
  database: Pick<Database, 'execute'> | MediaCacheTransaction,
): Promise<Date> {
  const [clock] = await database.execute<{ now: Date | string }>(
    sql`select clock_timestamp() as now`,
  );
  const now = clock ? new Date(clock.now) : null;
  if (!now || !Number.isFinite(now.getTime())) {
    throw new Error('PostgreSQL returned an invalid clock');
  }
  return now;
}

function toMaintenanceBlob(row: {
  byteLength: bigint;
  lastAccessedAt: Date;
  relativeKey: string;
  sha256: string;
}): MaintenanceBlob {
  const byteLength = Number(row.byteLength);
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new Error('Media cache blob byte length is not safely representable');
  }
  return {
    byteLength,
    lastAccessedAt: row.lastAccessedAt,
    relativeKey: row.relativeKey,
    sha256: row.sha256,
  };
}

function assertInitiator(initiator: MediaCacheMaintenanceInitiator): void {
  const id = initiator.id.trim();
  const reason = initiator.reason.trim();
  if (!id || id.length > 255 || !reason || reason.length > 500) {
    throw new TypeError('Media cache maintenance requires bounded initiator and reason');
  }
}
