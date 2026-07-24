import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, notExists, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { mediaBlobLocations, mediaCacheBlobs, mediaStorageBackends } from '../db/schema.js';
import { MEDIA_CACHE_ADVISORY_LOCK } from './ledger-lock.js';

export const LOCAL_STORAGE_BACKEND_ID = 'local';
export const S3_STORAGE_BACKEND_ID = 's3-default';
const BACKFILL_BATCH_SIZE = 500;

export interface LocalStorageBackendConfig {
  maxBytes: bigint;
  root: string;
}

export interface S3StorageBackendConfig {
  bucket: string;
  endpointOrigin: string;
  forcePathStyle: boolean;
  maxBytes: bigint;
  prefix: string;
  region: string;
}

export interface BootstrapStorageLedgerInput {
  local: LocalStorageBackendConfig;
  s3?: S3StorageBackendConfig;
}

export interface BootstrappedStorageBackend {
  configFingerprint: string;
  enabled: boolean;
  id: typeof LOCAL_STORAGE_BACKEND_ID | typeof S3_STORAGE_BACKEND_ID;
  maxBytes: bigint;
  readable: boolean;
  readyBytes: bigint;
  writable: boolean;
}

export interface BootstrappedStorageLedger {
  local: BootstrappedStorageBackend;
  s3?: BootstrappedStorageBackend;
}

export interface LocalStorageLedgerBlob {
  byteLength: bigint;
  lastAccessedAt: Date;
  relativeKey: string;
  sha256: string;
}

type StorageBackendConfig =
  | ({ kind: 'local' } & LocalStorageBackendConfig)
  | ({ kind: 's3' } & S3StorageBackendConfig);

/**
 * Fingerprints the backend's public, non-secret storage namespace identity. Capacity is an
 * operational policy, not namespace identity. Unknown runtime properties are deliberately ignored.
 */
export function createStorageBackendConfigFingerprint(config: StorageBackendConfig): string {
  const publicConfig =
    config.kind === 'local'
      ? {
          kind: config.kind,
          root: config.root,
        }
      : {
          bucket: config.bucket,
          endpointOrigin: parseCanonicalEndpointOrigin(config.endpointOrigin),
          forcePathStyle: config.forcePathStyle,
          kind: config.kind,
          prefix: config.prefix,
          region: config.region,
        };

  return createHash('sha256').update(canonicalJson(publicConfig)).digest('hex');
}

function parseCanonicalEndpointOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('S3 endpoint must be a canonical HTTP or HTTPS origin');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '') ||
    value !== url.origin
  ) {
    throw new Error('S3 endpoint must be a canonical HTTP or HTTPS origin');
  }
  return url.origin;
}

export class StorageLedgerRepository {
  constructor(private readonly db: Database) {}

  async bootstrap(input: BootstrapStorageLedgerInput): Promise<BootstrappedStorageLedger> {
    return this.db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${MEDIA_CACHE_ADVISORY_LOCK})`);

      const now = await readDatabaseClock(transaction);
      const localFingerprint = createStorageBackendConfigFingerprint({
        ...input.local,
        kind: 'local',
      });
      const s3Fingerprint = input.s3
        ? createStorageBackendConfigFingerprint({
            ...input.s3,
            kind: 's3',
          })
        : undefined;
      await assertNamespaceMatches(transaction, LOCAL_STORAGE_BACKEND_ID, localFingerprint);
      if (s3Fingerprint) {
        await assertNamespaceMatches(transaction, S3_STORAGE_BACKEND_ID, s3Fingerprint);
      }

      let local = await upsertBackend(transaction, {
        configFingerprint: localFingerprint,
        enabled: true,
        id: LOCAL_STORAGE_BACKEND_ID,
        kind: 'local',
        label: 'Local hot cache',
        maxBytes: input.local.maxBytes,
        readPriority: 0,
        readable: true,
        readyBytes: 0n,
        lastReconciledAt: now,
        updatedAt: now,
        writable: true,
        writePriority: input.s3 ? 100 : 0,
      });

      await backfillLocalLocations(transaction);
      const localReadyBytes = await sumLocationReadyBytes(transaction, LOCAL_STORAGE_BACKEND_ID);
      local = await updateBackendReadyBytes(
        transaction,
        LOCAL_STORAGE_BACKEND_ID,
        localReadyBytes,
        now,
      );

      let s3: BootstrappedStorageBackend | undefined;
      if (input.s3) {
        if (!s3Fingerprint) {
          throw new Error('S3 storage namespace fingerprint was not created');
        }
        s3 = await upsertBackend(transaction, {
          configFingerprint: s3Fingerprint,
          enabled: true,
          id: S3_STORAGE_BACKEND_ID,
          kind: 's3',
          label: 'S3 durable cache',
          maxBytes: input.s3.maxBytes,
          readPriority: 100,
          readable: true,
          readyBytes: 0n,
          lastReconciledAt: now,
          updatedAt: now,
          writable: true,
          writePriority: 0,
        });
        const s3ReadyBytes = await sumLocationReadyBytes(transaction, S3_STORAGE_BACKEND_ID);
        s3 = await updateBackendReadyBytes(transaction, S3_STORAGE_BACKEND_ID, s3ReadyBytes, now);
      } else {
        const s3ReadyBytes = await sumLocationReadyBytes(transaction, S3_STORAGE_BACKEND_ID);
        await transaction
          .update(mediaStorageBackends)
          .set({
            enabled: false,
            lastReconciledAt: now,
            readable: false,
            readyBytes: s3ReadyBytes,
            updatedAt: now,
            writable: false,
          })
          .where(eq(mediaStorageBackends.id, S3_STORAGE_BACKEND_ID));
      }

      return s3 ? { local, s3 } : { local };
    });
  }
}

type StorageLedgerTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Keeps the additive local location ledger in step with the legacy blob ledger.
 *
 * These helpers deliberately no-op until bootstrap has created the local backend. That preserves
 * phase compatibility for repository-level callers while runtime bootstrap remains the hard gate
 * before any location-ledger consumer is enabled.
 */
export async function recordLocalStorageReady(
  transaction: StorageLedgerTransaction,
  blob: LocalStorageLedgerBlob,
  verifiedAt: Date,
): Promise<void> {
  const backend = await lockLocalBackend(transaction);
  if (!backend) return;

  const existing = await lockLocalLocation(transaction, blob.sha256);
  const wasPhysical = existing?.state === 'deleting' || existing?.state === 'ready';
  await transaction
    .insert(mediaBlobLocations)
    .values({
      backendId: LOCAL_STORAGE_BACKEND_ID,
      blobSha256: blob.sha256,
      lastAccessedAt: blob.lastAccessedAt,
      state: 'ready',
      storageKey: blob.relativeKey,
      verifiedAt,
      verifiedByteLength: blob.byteLength,
      verifiedSha256: blob.sha256,
    })
    .onConflictDoUpdate({
      target: [mediaBlobLocations.backendId, mediaBlobLocations.blobSha256],
      set: {
        lastAccessedAt: sql`greatest(
          ${mediaBlobLocations.lastAccessedAt},
          excluded.last_accessed_at
        )`,
        mutationExpiresAt: null,
        mutationOwner: null,
        mutationToken: null,
        providerChecksumSha256: null,
        providerEtag: null,
        providerVersionId: null,
        state: 'ready',
        storageKey: blob.relativeKey,
        updatedAt: verifiedAt,
        verifiedAt,
        verifiedByteLength: blob.byteLength,
        verifiedSha256: blob.sha256,
      },
    });
  if (!wasPhysical) {
    await setLocalBackendReadyBytes(transaction, backend.readyBytes + blob.byteLength, verifiedAt);
  }
}

export async function recordLocalStorageAccess(
  transaction: StorageLedgerTransaction,
  sha256: string,
  observedAt: Date,
): Promise<void> {
  await transaction
    .update(mediaBlobLocations)
    .set({
      lastAccessedAt: sql`greatest(
        ${mediaBlobLocations.lastAccessedAt},
        ${observedAt.toISOString()}::timestamptz
      )`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(mediaBlobLocations.backendId, LOCAL_STORAGE_BACKEND_ID),
        eq(mediaBlobLocations.blobSha256, sha256),
        eq(mediaBlobLocations.state, 'ready'),
      ),
    );
}

export async function claimLocalStorageDeletion(
  transaction: StorageLedgerTransaction,
  input: LocalStorageLedgerBlob & {
    mutationExpiresAt: Date;
    mutationOwner: string;
    mutationToken: string;
    now: Date;
  },
): Promise<void> {
  const backend = await lockLocalBackend(transaction);
  if (!backend) return;

  const existing = await lockLocalLocation(transaction, input.sha256);
  const wasPhysical = existing?.state === 'deleting' || existing?.state === 'ready';
  await transaction
    .insert(mediaBlobLocations)
    .values({
      backendId: LOCAL_STORAGE_BACKEND_ID,
      blobSha256: input.sha256,
      lastAccessedAt: input.lastAccessedAt,
      mutationExpiresAt: input.mutationExpiresAt,
      mutationOwner: input.mutationOwner,
      mutationToken: input.mutationToken,
      state: 'deleting',
      storageKey: input.relativeKey,
      updatedAt: input.now,
      verifiedAt: input.now,
      verifiedByteLength: input.byteLength,
      verifiedSha256: input.sha256,
    })
    .onConflictDoUpdate({
      target: [mediaBlobLocations.backendId, mediaBlobLocations.blobSha256],
      set: {
        lastAccessedAt: sql`greatest(
          ${mediaBlobLocations.lastAccessedAt},
          excluded.last_accessed_at
        )`,
        mutationExpiresAt: input.mutationExpiresAt,
        mutationOwner: input.mutationOwner,
        mutationToken: input.mutationToken,
        providerChecksumSha256: null,
        providerEtag: null,
        providerVersionId: null,
        state: 'deleting',
        storageKey: input.relativeKey,
        updatedAt: input.now,
        verifiedAt: input.now,
        verifiedByteLength: input.byteLength,
        verifiedSha256: input.sha256,
      },
    });
  if (!wasPhysical) {
    await setLocalBackendReadyBytes(transaction, backend.readyBytes + input.byteLength, input.now);
  }
}

export async function finalizeLocalStorageDeletion(
  transaction: StorageLedgerTransaction,
  input: {
    byteLength: bigint;
    mutationToken: string;
    now: Date;
    sha256: string;
  },
): Promise<void> {
  const backend = await lockLocalBackend(transaction);
  if (!backend) return;

  const [location] = await transaction
    .update(mediaBlobLocations)
    .set({
      mutationExpiresAt: null,
      mutationOwner: null,
      mutationToken: null,
      providerChecksumSha256: null,
      providerEtag: null,
      providerVersionId: null,
      state: 'evicted',
      updatedAt: input.now,
      verifiedAt: null,
      verifiedByteLength: null,
      verifiedSha256: null,
    })
    .where(
      and(
        eq(mediaBlobLocations.backendId, LOCAL_STORAGE_BACKEND_ID),
        eq(mediaBlobLocations.blobSha256, input.sha256),
        eq(mediaBlobLocations.state, 'deleting'),
        eq(mediaBlobLocations.mutationToken, input.mutationToken),
      ),
    )
    .returning({ blobSha256: mediaBlobLocations.blobSha256 });
  if (!location) {
    throw new Error(`Local storage deletion lease for ${input.sha256} is stale`);
  }
  if (backend.readyBytes < input.byteLength) {
    throw new Error('Local storage backend bytes are smaller than the evicted blob');
  }
  await setLocalBackendReadyBytes(transaction, backend.readyBytes - input.byteLength, input.now);
}

export async function restoreLocalStorageDeletion(
  transaction: StorageLedgerTransaction,
  input: {
    mutationToken: string;
    now: Date;
    sha256: string;
  },
): Promise<void> {
  const backend = await lockLocalBackend(transaction);
  if (!backend) return;

  const [location] = await transaction
    .update(mediaBlobLocations)
    .set({
      mutationExpiresAt: null,
      mutationOwner: null,
      mutationToken: null,
      state: 'ready',
      updatedAt: input.now,
    })
    .where(
      and(
        eq(mediaBlobLocations.backendId, LOCAL_STORAGE_BACKEND_ID),
        eq(mediaBlobLocations.blobSha256, input.sha256),
        eq(mediaBlobLocations.state, 'deleting'),
        eq(mediaBlobLocations.mutationToken, input.mutationToken),
      ),
    )
    .returning({ blobSha256: mediaBlobLocations.blobSha256 });
  if (!location) {
    throw new Error(`Local storage deletion lease for ${input.sha256} is stale`);
  }
}

export async function reconcileLocalStorageLedger(
  transaction: StorageLedgerTransaction,
): Promise<{ readyBytes: bigint; reconciled: boolean }> {
  const backend = await lockLocalBackend(transaction);
  if (!backend) return { readyBytes: 0n, reconciled: false };
  const now = await readDatabaseClock(transaction);

  let cursor: string | undefined;
  while (true) {
    const blobs = await transaction
      .select({
        byteLength: mediaCacheBlobs.byteLength,
        createdAt: mediaCacheBlobs.createdAt,
        evictionExpiresAt: mediaCacheBlobs.evictionExpiresAt,
        evictionOwner: mediaCacheBlobs.evictionOwner,
        evictionToken: mediaCacheBlobs.evictionToken,
        lastAccessedAt: mediaCacheBlobs.lastAccessedAt,
        relativeKey: mediaCacheBlobs.relativeKey,
        sha256: mediaCacheBlobs.sha256,
        state: mediaCacheBlobs.state,
        updatedAt: mediaCacheBlobs.updatedAt,
      })
      .from(mediaCacheBlobs)
      .where(cursor ? gt(mediaCacheBlobs.sha256, cursor) : undefined)
      .orderBy(asc(mediaCacheBlobs.sha256))
      .limit(BACKFILL_BATCH_SIZE);
    if (blobs.length === 0) break;

    const activeMutations = await transaction
      .select({ blobSha256: mediaBlobLocations.blobSha256 })
      .from(mediaBlobLocations)
      .where(
        and(
          eq(mediaBlobLocations.backendId, LOCAL_STORAGE_BACKEND_ID),
          inArray(
            mediaBlobLocations.blobSha256,
            blobs.map((blob) => blob.sha256),
          ),
          inArray(mediaBlobLocations.state, ['copying', 'deleting']),
          gt(mediaBlobLocations.mutationExpiresAt, now),
        ),
      );
    const activelyMutatingHashes = new Set(activeMutations.map((location) => location.blobSha256));
    for (const blob of blobs) {
      if (activelyMutatingHashes.has(blob.sha256)) continue;
      const physicallyPresent = blob.state === 'ready' || blob.state === 'deleting';
      await transaction
        .insert(mediaBlobLocations)
        .values({
          backendId: LOCAL_STORAGE_BACKEND_ID,
          blobSha256: blob.sha256,
          createdAt: blob.createdAt,
          lastAccessedAt: blob.lastAccessedAt,
          mutationExpiresAt: blob.state === 'deleting' ? blob.evictionExpiresAt : null,
          mutationOwner: blob.state === 'deleting' ? blob.evictionOwner : null,
          mutationToken: blob.state === 'deleting' ? blob.evictionToken : null,
          state: blob.state,
          storageKey: blob.relativeKey,
          updatedAt: blob.updatedAt,
          verifiedAt: physicallyPresent ? blob.updatedAt : null,
          verifiedByteLength: physicallyPresent ? blob.byteLength : null,
          verifiedSha256: physicallyPresent ? blob.sha256 : null,
        })
        .onConflictDoUpdate({
          target: [mediaBlobLocations.backendId, mediaBlobLocations.blobSha256],
          set: {
            lastAccessedAt: blob.lastAccessedAt,
            mutationExpiresAt: blob.state === 'deleting' ? blob.evictionExpiresAt : null,
            mutationOwner: blob.state === 'deleting' ? blob.evictionOwner : null,
            mutationToken: blob.state === 'deleting' ? blob.evictionToken : null,
            providerChecksumSha256: null,
            providerEtag: null,
            providerVersionId: null,
            state: blob.state,
            storageKey: blob.relativeKey,
            updatedAt: blob.updatedAt,
            verifiedAt: physicallyPresent ? blob.updatedAt : null,
            verifiedByteLength: physicallyPresent ? blob.byteLength : null,
            verifiedSha256: physicallyPresent ? blob.sha256 : null,
          },
        });
    }

    cursor = blobs.at(-1)?.sha256;
    if (blobs.length < BACKFILL_BATCH_SIZE || !cursor) break;
  }

  const readyBytes = await sumLocationReadyBytes(transaction, LOCAL_STORAGE_BACKEND_ID);
  await setLocalBackendReadyBytes(transaction, readyBytes, now, true);
  return { readyBytes, reconciled: true };
}

interface UpsertBackendInput {
  configFingerprint: string;
  enabled: boolean;
  id: typeof LOCAL_STORAGE_BACKEND_ID | typeof S3_STORAGE_BACKEND_ID;
  kind: 'local' | 's3';
  label: string;
  lastReconciledAt: Date;
  maxBytes: bigint;
  readable: boolean;
  readPriority: number;
  readyBytes: bigint;
  updatedAt: Date;
  writable: boolean;
  writePriority: number;
}

async function upsertBackend(
  transaction: StorageLedgerTransaction,
  input: UpsertBackendInput,
): Promise<BootstrappedStorageBackend> {
  const [backend] = await transaction
    .insert(mediaStorageBackends)
    .values(input)
    .onConflictDoUpdate({
      target: mediaStorageBackends.id,
      set: {
        configFingerprint: input.configFingerprint,
        enabled: input.enabled,
        kind: input.kind,
        label: input.label,
        lastReconciledAt: input.lastReconciledAt,
        maxBytes: input.maxBytes,
        readPriority: input.readPriority,
        readable: input.readable,
        readyBytes: input.readyBytes,
        updatedAt: input.updatedAt,
        writable: input.writable,
        writePriority: input.writePriority,
      },
    })
    .returning({
      configFingerprint: mediaStorageBackends.configFingerprint,
      enabled: mediaStorageBackends.enabled,
      id: mediaStorageBackends.id,
      maxBytes: mediaStorageBackends.maxBytes,
      readable: mediaStorageBackends.readable,
      readyBytes: mediaStorageBackends.readyBytes,
      writable: mediaStorageBackends.writable,
    });

  if (
    !backend ||
    (backend.id !== LOCAL_STORAGE_BACKEND_ID && backend.id !== S3_STORAGE_BACKEND_ID)
  ) {
    throw new Error(`Storage backend ${input.id} was not bootstrapped`);
  }
  return { ...backend, id: backend.id };
}

async function backfillLocalLocations(transaction: StorageLedgerTransaction): Promise<void> {
  let cursor: string | undefined;
  while (true) {
    const existingLocalLocation = transaction
      .select({ blobSha256: mediaBlobLocations.blobSha256 })
      .from(mediaBlobLocations)
      .where(
        and(
          eq(mediaBlobLocations.backendId, LOCAL_STORAGE_BACKEND_ID),
          eq(mediaBlobLocations.blobSha256, mediaCacheBlobs.sha256),
        ),
      );
    const legacyBlobs = await transaction
      .select({
        byteLength: mediaCacheBlobs.byteLength,
        createdAt: mediaCacheBlobs.createdAt,
        evictionExpiresAt: mediaCacheBlobs.evictionExpiresAt,
        evictionOwner: mediaCacheBlobs.evictionOwner,
        evictionToken: mediaCacheBlobs.evictionToken,
        lastAccessedAt: mediaCacheBlobs.lastAccessedAt,
        relativeKey: mediaCacheBlobs.relativeKey,
        sha256: mediaCacheBlobs.sha256,
        state: mediaCacheBlobs.state,
        updatedAt: mediaCacheBlobs.updatedAt,
      })
      .from(mediaCacheBlobs)
      .where(
        and(
          cursor ? gt(mediaCacheBlobs.sha256, cursor) : undefined,
          notExists(existingLocalLocation),
        ),
      )
      .orderBy(asc(mediaCacheBlobs.sha256))
      .limit(BACKFILL_BATCH_SIZE);

    if (legacyBlobs.length === 0) return;

    await transaction
      .insert(mediaBlobLocations)
      .values(
        legacyBlobs.map((blob) => {
          const physicallyPresent = blob.state === 'ready' || blob.state === 'deleting';
          return {
            backendId: LOCAL_STORAGE_BACKEND_ID,
            blobSha256: blob.sha256,
            createdAt: blob.createdAt,
            lastAccessedAt: blob.lastAccessedAt,
            mutationExpiresAt: blob.state === 'deleting' ? blob.evictionExpiresAt : null,
            mutationOwner: blob.state === 'deleting' ? blob.evictionOwner : null,
            mutationToken: blob.state === 'deleting' ? blob.evictionToken : null,
            state: blob.state,
            storageKey: blob.relativeKey,
            updatedAt: blob.updatedAt,
            verifiedAt: physicallyPresent ? blob.updatedAt : null,
            verifiedByteLength: physicallyPresent ? blob.byteLength : null,
            verifiedSha256: physicallyPresent ? blob.sha256 : null,
          };
        }),
      )
      .onConflictDoNothing({
        target: [mediaBlobLocations.backendId, mediaBlobLocations.blobSha256],
      });

    cursor = legacyBlobs.at(-1)?.sha256;
    if (legacyBlobs.length < BACKFILL_BATCH_SIZE || !cursor) return;
  }
}

async function sumLocationReadyBytes(
  transaction: StorageLedgerTransaction,
  backendId: string,
): Promise<bigint> {
  const [result] = await transaction
    .select({
      readyBytes: sql<string>`coalesce(sum(${mediaBlobLocations.verifiedByteLength}), 0)::text`,
    })
    .from(mediaBlobLocations)
    .where(
      and(
        eq(mediaBlobLocations.backendId, backendId),
        inArray(mediaBlobLocations.state, ['deleting', 'ready']),
      ),
    );
  return BigInt(result?.readyBytes ?? '0');
}

async function lockLocalBackend(
  transaction: StorageLedgerTransaction,
): Promise<{ readyBytes: bigint } | null> {
  const [backend] = await transaction
    .select({ readyBytes: mediaStorageBackends.readyBytes })
    .from(mediaStorageBackends)
    .where(eq(mediaStorageBackends.id, LOCAL_STORAGE_BACKEND_ID))
    .for('update');
  return backend ?? null;
}

async function lockLocalLocation(transaction: StorageLedgerTransaction, sha256: string) {
  const [location] = await transaction
    .select({ state: mediaBlobLocations.state })
    .from(mediaBlobLocations)
    .where(
      and(
        eq(mediaBlobLocations.backendId, LOCAL_STORAGE_BACKEND_ID),
        eq(mediaBlobLocations.blobSha256, sha256),
      ),
    )
    .for('update');
  return location ?? null;
}

async function setLocalBackendReadyBytes(
  transaction: StorageLedgerTransaction,
  readyBytes: bigint,
  now: Date,
  reconciled = false,
): Promise<void> {
  const [backend] = await transaction
    .update(mediaStorageBackends)
    .set({
      ...(reconciled ? { lastReconciledAt: now } : {}),
      readyBytes,
      updatedAt: now,
    })
    .where(eq(mediaStorageBackends.id, LOCAL_STORAGE_BACKEND_ID))
    .returning({ id: mediaStorageBackends.id });
  if (!backend) {
    throw new Error('Local storage backend disappeared while updating its byte ledger');
  }
}

async function updateBackendReadyBytes(
  transaction: StorageLedgerTransaction,
  backendId: typeof LOCAL_STORAGE_BACKEND_ID | typeof S3_STORAGE_BACKEND_ID,
  readyBytes: bigint,
  now: Date,
): Promise<BootstrappedStorageBackend> {
  const [backend] = await transaction
    .update(mediaStorageBackends)
    .set({
      lastReconciledAt: now,
      readyBytes,
      updatedAt: now,
    })
    .where(eq(mediaStorageBackends.id, backendId))
    .returning({
      configFingerprint: mediaStorageBackends.configFingerprint,
      enabled: mediaStorageBackends.enabled,
      id: mediaStorageBackends.id,
      maxBytes: mediaStorageBackends.maxBytes,
      readable: mediaStorageBackends.readable,
      readyBytes: mediaStorageBackends.readyBytes,
      writable: mediaStorageBackends.writable,
    });
  if (!backend || backend.id !== backendId) {
    throw new Error(`Storage backend ${backendId} was not reconciled`);
  }
  return { ...backend, id: backendId };
}

async function assertNamespaceMatches(
  transaction: StorageLedgerTransaction,
  backendId: typeof LOCAL_STORAGE_BACKEND_ID | typeof S3_STORAGE_BACKEND_ID,
  configFingerprint: string,
): Promise<void> {
  const [existing] = await transaction
    .select({ configFingerprint: mediaStorageBackends.configFingerprint })
    .from(mediaStorageBackends)
    .where(eq(mediaStorageBackends.id, backendId))
    .limit(1);
  if (!existing || existing.configFingerprint === configFingerprint) return;

  const [location] = await transaction
    .select({ blobSha256: mediaBlobLocations.blobSha256 })
    .from(mediaBlobLocations)
    .where(eq(mediaBlobLocations.backendId, backendId))
    .limit(1);
  if (location) {
    throw new Error(`Storage backend ${backendId} namespace changed while locations still exist`);
  }
}

async function readDatabaseClock(transaction: StorageLedgerTransaction): Promise<Date> {
  const [clock] = await transaction.execute<{ now: Date | string }>(
    sql`select clock_timestamp() as now`,
  );
  const now = clock ? new Date(clock.now) : null;
  if (!now || !Number.isFinite(now.getTime())) {
    throw new Error('PostgreSQL returned an invalid clock');
  }
  return now;
}

type CanonicalJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}
