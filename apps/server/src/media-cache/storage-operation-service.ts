import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  mediaBlobLocations,
  mediaCacheActions,
  mediaCacheBlobs,
  mediaCacheObjects,
  mediaStorageBackends,
} from '../db/schema.js';
import {
  type MediaBlobIdentity,
  MediaBlobIntegrityError,
  MediaBlobStoreError,
} from './blob-store.js';
import type {
  CommandStorageMigrateResult,
  CommandStorageOperationInput,
  CommandStoragePruneResult,
  CommandStorageRestoreResult,
} from './command-queue.js';
import { MEDIA_CACHE_ADVISORY_LOCK, restoreLegacyLocalBlob } from './ledger-repository.js';
import {
  copyPersistentBlob,
  type PersistentBlobBackend,
  type PersistentBlobBackendRegistry,
  type PersistentStorageBackendId,
} from './local-persistent-blob-backend.js';
import { PostgresStoragePruneService } from './storage-prune-service.js';

const COPY_LEASE_MS = 5 * 60_000;
const MIGRATION_BATCH_SIZE = 100;

export type StorageOperationTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

interface CopyCandidate {
  identity: MediaBlobIdentity;
  objectId: string | null;
}

interface ClaimedCopy extends CopyCandidate {
  locationToken: string;
  sourceBackendId: PersistentStorageBackendId;
  targetBackendId: PersistentStorageBackendId;
}

type CopyClaimResult =
  | { candidate: CopyCandidate; kind: 'already_ready' }
  | {
      kind: 'blocked';
      reason: 'capacity' | 'deleting' | 'lease' | 'source_unavailable';
    }
  | { claim: ClaimedCopy; kind: 'claimed' };

export class StorageOperationLeaseError extends Error {
  constructor() {
    super('The media storage copy lease is stale');
    this.name = 'StorageOperationLeaseError';
  }
}

export interface LegacyLocalRestoreFinalizer {
  /**
   * Restores only the legacy blob/runtime/object/plan ledger inside the caller's transaction.
   * The implementation must not mutate media_blob_locations or media_storage_backends.
   */
  finalize(
    transaction: StorageOperationTransaction,
    input: {
      command:
        | CommandStorageOperationInput<'migrate'>['command']
        | CommandStorageOperationInput<'restore'>['command'];
      identity: MediaBlobIdentity;
      now: Date;
      objectId: string | null;
      sourceBackendId: PersistentStorageBackendId;
    },
  ): Promise<void>;
}

export class PostgresLegacyLocalRestoreFinalizer implements LegacyLocalRestoreFinalizer {
  finalize(
    transaction: StorageOperationTransaction,
    input: Parameters<LegacyLocalRestoreFinalizer['finalize']>[1],
  ): Promise<void> {
    return restoreLegacyLocalBlob(transaction, {
      byteLength: BigInt(input.identity.byteLength),
      now: input.now,
      relativeKey: input.identity.relativeKey,
      sha256: input.identity.sha256,
    });
  }
}

export class PostgresStorageOperationService {
  private readonly pruneService: PostgresStoragePruneService;

  constructor(
    private readonly database: Database,
    private readonly backends: PersistentBlobBackendRegistry,
    private readonly legacyLocalRestore?: LegacyLocalRestoreFinalizer,
    pruneService?: PostgresStoragePruneService,
  ) {
    this.pruneService = pruneService ?? new PostgresStoragePruneService(database, backends);
  }

  async migrate(
    input: CommandStorageOperationInput<'migrate'>,
  ): Promise<CommandStorageMigrateResult> {
    const { command } = input;
    const pair = this.backends.pair(command.sourceBackendId, command.targetBackendId);
    this.assertTargetFinalizerAvailable(pair.target.id);
    const candidates = await this.listMigrationCandidates(
      command.sourceBackendId,
      command.targetBackendId,
      command.objectId,
    );
    if (command.objectId && candidates.length === 0) {
      throw new Error('The requested media cache object has no blob identity');
    }
    let migratedBlobCount = 0;
    let migratedBytes = 0n;
    let alreadyApplied = candidates.length === 1;

    for (const candidate of candidates.slice(0, MIGRATION_BATCH_SIZE)) {
      input.signal?.throwIfAborted();
      await input.renewLease();
      const claimed = await this.claimExactCopy({
        candidate,
        sourceBackendId: command.sourceBackendId,
        targetBackendId: command.targetBackendId,
      });
      if (claimed.kind === 'already_ready') {
        continue;
      }
      alreadyApplied = false;
      if (claimed.kind === 'blocked') {
        if (command.objectId && claimed.reason === 'source_unavailable') {
          throw new Error('The requested source media storage location is not readable');
        }
        continue;
      }
      await this.copyAndFinalize(claimed.claim, input);
      migratedBlobCount += 1;
      migratedBytes += BigInt(claimed.claim.identity.byteLength);
    }

    const hasMore = await this.hasMigrationCandidate(
      command.sourceBackendId,
      command.targetBackendId,
      command.objectId,
    );
    return {
      ...(command.objectId ? { alreadyApplied: alreadyApplied && !hasMore } : {}),
      hasMore,
      migratedBlobCount,
      migratedBytes: migratedBytes.toString(),
      sourceBackendId: pair.source.id,
      targetBackendId: pair.target.id,
    };
  }

  prune(input: CommandStorageOperationInput<'prune'>): Promise<CommandStoragePruneResult> {
    return this.pruneService.apply(input);
  }

  async restore(
    input: CommandStorageOperationInput<'restore'>,
  ): Promise<CommandStorageRestoreResult> {
    input.signal?.throwIfAborted();
    const target = this.backends.get(input.command.targetBackendId);
    this.assertTargetFinalizerAvailable(target.id);
    await input.renewLease();
    const claim = await this.claimRestore(input.command.objectId, target.id);
    if (!claim) {
      throw new Error('No readable media storage location is available for restore');
    }
    if (claim.kind === 'already_ready') {
      return {
        alreadyApplied: true,
        hasMore: false,
        restoredBytes: '0',
        restoredObjectCount: 0,
        targetBackendId: target.id,
      };
    }
    if (claim.kind === 'blocked') {
      return {
        alreadyApplied: false,
        hasMore: true,
        restoredBytes: '0',
        restoredObjectCount: 0,
        targetBackendId: target.id,
      };
    }

    await this.copyAndFinalize(claim.claim, input);
    return {
      alreadyApplied: false,
      hasMore: false,
      restoredBytes: claim.claim.identity.byteLength.toString(),
      restoredObjectCount: 1,
      targetBackendId: claim.claim.targetBackendId,
    };
  }

  private async copyAndFinalize(
    claim: ClaimedCopy,
    input: CommandStorageOperationInput<'migrate'> | CommandStorageOperationInput<'restore'>,
  ): Promise<void> {
    const { source, target } = this.backends.pair(claim.sourceBackendId, claim.targetBackendId);
    let operationError: unknown;
    try {
      await copyPersistentBlob({
        identity: claim.identity,
        ...(input.signal ? { signal: input.signal } : {}),
        source,
        target,
      });
    } catch (error) {
      operationError = error;
    }

    if (operationError) {
      const sourceIntegrity = isIntegrityError(operationError)
        ? await verifyPersistentSource(source, claim.identity, input.signal)
        : 'not_checked';
      await this.failCopy(claim, {
        sourceCorrupt: sourceIntegrity === 'corrupt',
        targetState:
          isIntegrityError(operationError) && sourceIntegrity === 'healthy' ? 'corrupt' : 'missing',
      });
      throw operationError;
    }
    try {
      await this.finalizeCopy(claim, input.command);
    } catch (error) {
      await this.failCopy(claim, { sourceCorrupt: false, targetState: 'missing' });
      throw error;
    }
  }

  private assertTargetFinalizerAvailable(targetBackendId: PersistentStorageBackendId): void {
    if (targetBackendId === 'local' && !this.legacyLocalRestore) {
      throw new Error('Legacy local restore finalizer is unavailable');
    }
  }

  private async claimExactCopy(input: {
    candidate: CopyCandidate;
    sourceBackendId: string;
    targetBackendId: string;
  }): Promise<CopyClaimResult> {
    return this.database.transaction(async (transaction) => {
      await lockStorageLedger(transaction);
      const now = await readDatabaseClock(transaction);
      const pair = await readBackendPair(transaction, input.sourceBackendId, input.targetBackendId);
      const readyTarget = await readReadyTargetLocation(
        transaction,
        pair.target.id,
        input.candidate,
      );
      if (readyTarget) return readyTarget;
      assertReadableSource(pair.source);
      assertWritableTarget(pair.target);
      const [sourceLocation] = await transaction
        .select({
          state: mediaBlobLocations.state,
          verifiedByteLength: mediaBlobLocations.verifiedByteLength,
          verifiedSha256: mediaBlobLocations.verifiedSha256,
        })
        .from(mediaBlobLocations)
        .where(
          and(
            eq(mediaBlobLocations.backendId, pair.source.id),
            eq(mediaBlobLocations.blobSha256, input.candidate.identity.sha256),
          ),
        )
        .for('update');
      if (
        sourceLocation?.state !== 'ready' ||
        sourceLocation.verifiedByteLength !== BigInt(input.candidate.identity.byteLength) ||
        sourceLocation.verifiedSha256 !== input.candidate.identity.sha256
      ) {
        return { kind: 'blocked', reason: 'source_unavailable' };
      }
      return claimTargetLocation(transaction, {
        candidate: input.candidate,
        now,
        sourceBackendId: pair.source.id,
        target: pair.target,
      });
    });
  }

  private async claimRestore(
    objectId: string,
    targetBackendId: string,
  ): Promise<CopyClaimResult | null> {
    return this.database.transaction(async (transaction) => {
      await lockStorageLedger(transaction);
      const now = await readDatabaseClock(transaction);
      const [object] = await transaction
        .select({
          blobSha256: mediaCacheObjects.blobSha256,
        })
        .from(mediaCacheObjects)
        .where(eq(mediaCacheObjects.id, objectId))
        .for('update');
      if (!object?.blobSha256) return null;
      const [blob] = await transaction
        .select({
          byteLength: mediaCacheBlobs.byteLength,
          relativeKey: mediaCacheBlobs.relativeKey,
          sha256: mediaCacheBlobs.sha256,
        })
        .from(mediaCacheBlobs)
        .where(eq(mediaCacheBlobs.sha256, object.blobSha256))
        .for('update');
      if (!blob) return null;
      const identity = toBlobIdentity(blob);
      const readyTarget = await readReadyTargetLocation(transaction, targetBackendId, {
        identity,
        objectId,
      });
      if (readyTarget) return readyTarget;
      const [source] = await transaction
        .select({
          backendId: mediaBlobLocations.backendId,
        })
        .from(mediaBlobLocations)
        .innerJoin(mediaStorageBackends, eq(mediaStorageBackends.id, mediaBlobLocations.backendId))
        .where(
          and(
            eq(mediaBlobLocations.blobSha256, blob.sha256),
            eq(mediaBlobLocations.state, 'ready'),
            eq(mediaBlobLocations.verifiedByteLength, blob.byteLength),
            eq(mediaBlobLocations.verifiedSha256, blob.sha256),
            eq(mediaStorageBackends.enabled, true),
            eq(mediaStorageBackends.readable, true),
            ne(mediaStorageBackends.id, targetBackendId),
          ),
        )
        .orderBy(asc(mediaStorageBackends.readPriority), asc(mediaStorageBackends.id))
        .limit(1)
        .for('update');
      if (!source) return null;
      this.backends.pair(source.backendId, targetBackendId);
      const pair = await readBackendPair(transaction, source.backendId, targetBackendId);
      assertReadableSource(pair.source);
      assertWritableTarget(pair.target);
      return claimTargetLocation(transaction, {
        candidate: { identity, objectId },
        now,
        sourceBackendId: pair.source.id,
        target: pair.target,
      });
    });
  }

  private async finalizeCopy(
    claim: ClaimedCopy,
    command:
      | CommandStorageOperationInput<'migrate'>['command']
      | CommandStorageOperationInput<'restore'>['command'],
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockStorageLedger(transaction);
      const now = await readDatabaseClock(transaction);
      const [location] = await transaction
        .select({
          mutationToken: mediaBlobLocations.mutationToken,
          state: mediaBlobLocations.state,
        })
        .from(mediaBlobLocations)
        .where(
          and(
            eq(mediaBlobLocations.backendId, claim.targetBackendId),
            eq(mediaBlobLocations.blobSha256, claim.identity.sha256),
          ),
        )
        .for('update');
      if (location?.state !== 'copying' || location.mutationToken !== claim.locationToken) {
        throw new StorageOperationLeaseError();
      }
      const [target] = await transaction
        .select()
        .from(mediaStorageBackends)
        .where(eq(mediaStorageBackends.id, claim.targetBackendId))
        .for('update');
      if (!target) throw new Error('Target media storage backend disappeared');
      assertWritableTarget(target);
      const copiedBytes = BigInt(claim.identity.byteLength);
      if (claim.targetBackendId === 'local') {
        const finalizer = this.legacyLocalRestore;
        if (!finalizer) throw new Error('Legacy local restore finalizer is unavailable');
        await finalizer.finalize(transaction, {
          command,
          identity: claim.identity,
          now,
          objectId: claim.objectId,
          sourceBackendId: claim.sourceBackendId,
        });
      }
      await transaction
        .update(mediaBlobLocations)
        .set({
          lastAccessedAt: now,
          mutationExpiresAt: null,
          mutationOwner: null,
          mutationToken: null,
          state: 'ready',
          updatedAt: now,
          verifiedAt: now,
          verifiedByteLength: copiedBytes,
          verifiedSha256: claim.identity.sha256,
        })
        .where(
          and(
            eq(mediaBlobLocations.backendId, claim.targetBackendId),
            eq(mediaBlobLocations.blobSha256, claim.identity.sha256),
            eq(mediaBlobLocations.state, 'copying'),
            eq(mediaBlobLocations.mutationToken, claim.locationToken),
          ),
        );
      await transaction
        .update(mediaStorageBackends)
        .set({
          readyBytes: target.readyBytes + copiedBytes,
          updatedAt: now,
        })
        .where(eq(mediaStorageBackends.id, target.id));
      await transaction.insert(mediaCacheActions).values({
        actionKind: command.operation,
        afterState: {
          byteLength: copiedBytes.toString(),
          sourceBackendId: claim.sourceBackendId,
          state: 'ready',
          targetBackendId: claim.targetBackendId,
        },
        beforeState: {
          sourceBackendId: claim.sourceBackendId,
          state: 'copying',
          targetBackendId: claim.targetBackendId,
        },
        blobSha256: claim.identity.sha256,
        initiatorId: command.initiatorId,
        initiatorKind: command.initiatorKind,
        objectId: claim.objectId,
        reason: command.reason,
      });
    });
  }

  private async failCopy(
    claim: ClaimedCopy,
    failure: {
      sourceCorrupt: boolean;
      targetState: 'corrupt' | 'missing';
    },
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockStorageLedger(transaction);
      const now = await readDatabaseClock(transaction);
      await transaction
        .update(mediaBlobLocations)
        .set({
          mutationExpiresAt: null,
          mutationOwner: null,
          mutationToken: null,
          providerChecksumSha256: null,
          providerEtag: null,
          providerVersionId: null,
          state: failure.targetState,
          updatedAt: now,
          verifiedAt: null,
          verifiedByteLength: null,
          verifiedSha256: null,
        })
        .where(
          and(
            eq(mediaBlobLocations.backendId, claim.targetBackendId),
            eq(mediaBlobLocations.blobSha256, claim.identity.sha256),
            eq(mediaBlobLocations.state, 'copying'),
            eq(mediaBlobLocations.mutationToken, claim.locationToken),
          ),
        );
      if (!failure.sourceCorrupt) return;

      const [sourceLocation] = await transaction
        .select({
          state: mediaBlobLocations.state,
          verifiedByteLength: mediaBlobLocations.verifiedByteLength,
          verifiedSha256: mediaBlobLocations.verifiedSha256,
        })
        .from(mediaBlobLocations)
        .where(
          and(
            eq(mediaBlobLocations.backendId, claim.sourceBackendId),
            eq(mediaBlobLocations.blobSha256, claim.identity.sha256),
          ),
        )
        .for('update');
      if (
        sourceLocation?.state !== 'ready' ||
        sourceLocation.verifiedByteLength !== BigInt(claim.identity.byteLength) ||
        sourceLocation.verifiedSha256 !== claim.identity.sha256
      ) {
        return;
      }
      const [sourceBackend] = await transaction
        .select({ readyBytes: mediaStorageBackends.readyBytes })
        .from(mediaStorageBackends)
        .where(eq(mediaStorageBackends.id, claim.sourceBackendId))
        .for('update');
      const corruptedBytes = BigInt(claim.identity.byteLength);
      if (!sourceBackend || sourceBackend.readyBytes < corruptedBytes) {
        throw new Error('Source media storage byte ledger is smaller than its corrupt blob');
      }
      await transaction
        .update(mediaBlobLocations)
        .set({
          mutationExpiresAt: null,
          mutationOwner: null,
          mutationToken: null,
          providerChecksumSha256: null,
          providerEtag: null,
          providerVersionId: null,
          state: 'corrupt',
          updatedAt: now,
          verifiedAt: null,
          verifiedByteLength: null,
          verifiedSha256: null,
        })
        .where(
          and(
            eq(mediaBlobLocations.backendId, claim.sourceBackendId),
            eq(mediaBlobLocations.blobSha256, claim.identity.sha256),
            eq(mediaBlobLocations.state, 'ready'),
          ),
        );
      await transaction
        .update(mediaStorageBackends)
        .set({
          readyBytes: sourceBackend.readyBytes - corruptedBytes,
          updatedAt: now,
        })
        .where(eq(mediaStorageBackends.id, claim.sourceBackendId));
    });
  }

  private async listMigrationCandidates(
    sourceBackendId: string,
    targetBackendId: string,
    objectId: string | null,
  ): Promise<CopyCandidate[]> {
    if (objectId) {
      const [candidate] = await this.database
        .select({
          byteLength: mediaCacheBlobs.byteLength,
          objectId: mediaCacheObjects.id,
          relativeKey: mediaCacheBlobs.relativeKey,
          sha256: mediaCacheBlobs.sha256,
        })
        .from(mediaCacheObjects)
        .innerJoin(mediaCacheBlobs, eq(mediaCacheBlobs.sha256, mediaCacheObjects.blobSha256))
        .where(eq(mediaCacheObjects.id, objectId))
        .limit(1);
      return candidate
        ? [{ identity: toBlobIdentity(candidate), objectId: candidate.objectId }]
        : [];
    }

    const candidates = await this.database
      .select({
        byteLength: mediaCacheBlobs.byteLength,
        relativeKey: mediaCacheBlobs.relativeKey,
        sha256: mediaCacheBlobs.sha256,
      })
      .from(mediaBlobLocations)
      .innerJoin(mediaCacheBlobs, eq(mediaCacheBlobs.sha256, mediaBlobLocations.blobSha256))
      .where(
        and(
          eq(mediaBlobLocations.backendId, sourceBackendId),
          eq(mediaBlobLocations.state, 'ready'),
          eq(mediaBlobLocations.verifiedByteLength, mediaCacheBlobs.byteLength),
          eq(mediaBlobLocations.verifiedSha256, mediaCacheBlobs.sha256),
          sql`not exists (
            select 1
            from ${mediaBlobLocations} as target_location
            where target_location.backend_id = ${targetBackendId}
              and target_location.blob_sha256 = ${mediaBlobLocations.blobSha256}
              and target_location.state = 'ready'
              and target_location.verified_byte_length = ${mediaCacheBlobs.byteLength}
              and target_location.verified_sha256 = ${mediaCacheBlobs.sha256}
          )`,
        ),
      )
      .orderBy(asc(mediaBlobLocations.lastAccessedAt), asc(mediaBlobLocations.blobSha256))
      .limit(MIGRATION_BATCH_SIZE + 1);
    return candidates.map((candidate) => ({
      identity: toBlobIdentity(candidate),
      objectId: null,
    }));
  }

  private async hasMigrationCandidate(
    sourceBackendId: string,
    targetBackendId: string,
    objectId: string | null,
  ): Promise<boolean> {
    if (objectId) {
      const [candidate] = await this.database
        .select({ id: mediaCacheObjects.id })
        .from(mediaCacheObjects)
        .innerJoin(mediaCacheBlobs, eq(mediaCacheBlobs.sha256, mediaCacheObjects.blobSha256))
        .innerJoin(
          mediaBlobLocations,
          and(
            eq(mediaBlobLocations.backendId, sourceBackendId),
            eq(mediaBlobLocations.blobSha256, mediaCacheBlobs.sha256),
          ),
        )
        .where(
          and(
            eq(mediaCacheObjects.id, objectId),
            eq(mediaBlobLocations.state, 'ready'),
            eq(mediaBlobLocations.verifiedByteLength, mediaCacheBlobs.byteLength),
            eq(mediaBlobLocations.verifiedSha256, mediaCacheBlobs.sha256),
            sql`not exists (
              select 1
              from ${mediaBlobLocations} as target_location
              where target_location.backend_id = ${targetBackendId}
                and target_location.blob_sha256 = ${mediaCacheBlobs.sha256}
                and target_location.state = 'ready'
                and target_location.verified_byte_length = ${mediaCacheBlobs.byteLength}
                and target_location.verified_sha256 = ${mediaCacheBlobs.sha256}
            )`,
          ),
        )
        .limit(1);
      return Boolean(candidate);
    }
    const candidates = await this.listMigrationCandidates(sourceBackendId, targetBackendId, null);
    return candidates.length > 0;
  }
}

async function claimTargetLocation(
  transaction: StorageOperationTransaction,
  input: {
    candidate: CopyCandidate;
    now: Date;
    sourceBackendId: PersistentStorageBackendId;
    target: {
      id: PersistentStorageBackendId;
      maxBytes: bigint;
      readyBytes: bigint;
    };
  },
): Promise<CopyClaimResult> {
  const [location] = await transaction
    .select()
    .from(mediaBlobLocations)
    .where(
      and(
        eq(mediaBlobLocations.backendId, input.target.id),
        eq(mediaBlobLocations.blobSha256, input.candidate.identity.sha256),
      ),
    )
    .for('update');
  if (
    location?.state === 'ready' &&
    location.verifiedByteLength === BigInt(input.candidate.identity.byteLength) &&
    location.verifiedSha256 === input.candidate.identity.sha256
  ) {
    return { candidate: input.candidate, kind: 'already_ready' };
  }
  if (location?.state === 'ready') {
    throw new MediaBlobIntegrityError(
      'Ready media storage location does not match its blob identity',
    );
  }
  if (
    location?.state === 'copying' &&
    location.mutationExpiresAt &&
    location.mutationExpiresAt > input.now
  ) {
    return { kind: 'blocked', reason: 'lease' };
  }
  if (location?.state === 'deleting') {
    return { kind: 'blocked', reason: 'deleting' };
  }
  const copiedBytes = BigInt(input.candidate.identity.byteLength);
  if (input.target.readyBytes + copiedBytes > input.target.maxBytes) {
    return { kind: 'blocked', reason: 'capacity' };
  }
  const locationToken = randomUUID();
  await transaction
    .insert(mediaBlobLocations)
    .values({
      backendId: input.target.id,
      blobSha256: input.candidate.identity.sha256,
      lastAccessedAt: input.now,
      mutationExpiresAt: new Date(input.now.getTime() + COPY_LEASE_MS),
      mutationOwner: 'storage-operation-worker',
      mutationToken: locationToken,
      providerChecksumSha256: null,
      providerEtag: null,
      providerVersionId: null,
      state: 'copying',
      storageKey: input.candidate.identity.relativeKey,
      updatedAt: input.now,
      verifiedAt: null,
      verifiedByteLength: null,
      verifiedSha256: null,
    })
    .onConflictDoUpdate({
      target: [mediaBlobLocations.backendId, mediaBlobLocations.blobSha256],
      set: {
        lastAccessedAt: input.now,
        mutationExpiresAt: new Date(input.now.getTime() + COPY_LEASE_MS),
        mutationOwner: 'storage-operation-worker',
        mutationToken: locationToken,
        providerChecksumSha256: null,
        providerEtag: null,
        providerVersionId: null,
        state: 'copying',
        storageKey: input.candidate.identity.relativeKey,
        updatedAt: input.now,
        verifiedAt: null,
        verifiedByteLength: null,
        verifiedSha256: null,
      },
    });
  return {
    claim: {
      ...input.candidate,
      locationToken,
      sourceBackendId: input.sourceBackendId,
      targetBackendId: input.target.id,
    },
    kind: 'claimed',
  };
}

async function readReadyTargetLocation(
  transaction: StorageOperationTransaction,
  targetBackendId: string,
  candidate: CopyCandidate,
): Promise<CopyClaimResult | null> {
  const [location] = await transaction
    .select({
      state: mediaBlobLocations.state,
      verifiedByteLength: mediaBlobLocations.verifiedByteLength,
      verifiedSha256: mediaBlobLocations.verifiedSha256,
    })
    .from(mediaBlobLocations)
    .where(
      and(
        eq(mediaBlobLocations.backendId, targetBackendId),
        eq(mediaBlobLocations.blobSha256, candidate.identity.sha256),
      ),
    )
    .for('update');
  return location?.state === 'ready' &&
    location.verifiedByteLength === BigInt(candidate.identity.byteLength) &&
    location.verifiedSha256 === candidate.identity.sha256
    ? { candidate, kind: 'already_ready' }
    : null;
}

async function readBackendPair(
  transaction: StorageOperationTransaction,
  sourceBackendId: string,
  targetBackendId: string,
): Promise<{
  source: {
    enabled: boolean;
    id: PersistentStorageBackendId;
    readable: boolean;
  };
  target: {
    enabled: boolean;
    id: PersistentStorageBackendId;
    maxBytes: bigint;
    readyBytes: bigint;
    writable: boolean;
  };
}> {
  const rows = await transaction
    .select({
      enabled: mediaStorageBackends.enabled,
      id: mediaStorageBackends.id,
      maxBytes: mediaStorageBackends.maxBytes,
      readable: mediaStorageBackends.readable,
      readyBytes: mediaStorageBackends.readyBytes,
      writable: mediaStorageBackends.writable,
    })
    .from(mediaStorageBackends)
    .where(inArray(mediaStorageBackends.id, [sourceBackendId, targetBackendId]))
    .orderBy(asc(mediaStorageBackends.id))
    .for('update');
  const source = rows.find((row) => row.id === sourceBackendId);
  const target = rows.find((row) => row.id === targetBackendId);
  if (!source || !target) throw new Error('Media storage backend configuration is unavailable');
  if (
    (source.id !== 'local' && source.id !== 's3-default') ||
    (target.id !== 'local' && target.id !== 's3-default')
  ) {
    throw new TypeError('Unsupported persistent media backend');
  }
  return {
    source: { ...source, id: source.id },
    target: { ...target, id: target.id },
  };
}

function assertReadableSource(source: { enabled: boolean; readable: boolean }): void {
  if (!source.enabled || !source.readable) {
    throw new Error('Source media storage backend is not readable');
  }
}

function assertWritableTarget(target: { enabled: boolean; writable: boolean }): void {
  if (!target.enabled || !target.writable) {
    throw new Error('Target media storage backend is not writable');
  }
}

function toBlobIdentity(blob: {
  byteLength: bigint;
  relativeKey: string;
  sha256: string;
}): MediaBlobIdentity {
  const byteLength = Number(blob.byteLength);
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new TypeError('Media blob byte length is not safely representable');
  }
  return {
    byteLength,
    relativeKey: blob.relativeKey,
    sha256: blob.sha256,
  };
}

async function verifyPersistentSource(
  source: PersistentBlobBackend,
  identity: MediaBlobIdentity,
  signal?: AbortSignal,
): Promise<'corrupt' | 'healthy' | 'unavailable'> {
  let handle: Awaited<ReturnType<PersistentBlobBackend['read']>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let outcome: 'corrupt' | 'healthy' | 'unavailable' = 'unavailable';
  try {
    signal?.throwIfAborted();
    handle = await source.read(identity, signal ? { signal } : {});
    reader = handle.stream().getReader();
    const hash = createHash('sha256');
    let byteLength = 0;
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        outcome = 'corrupt';
        break;
      }
      byteLength += next.value.byteLength;
      if (byteLength > identity.byteLength) {
        outcome = 'corrupt';
        break;
      }
      hash.update(next.value);
    }
    if (outcome !== 'corrupt') {
      outcome =
        byteLength === identity.byteLength && hash.digest('hex') === identity.sha256
          ? 'healthy'
          : 'corrupt';
    }
  } catch (error) {
    outcome = isIntegrityError(error) ? 'corrupt' : 'unavailable';
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    try {
      await handle?.close();
    } catch {
      outcome = 'unavailable';
    }
  }
  return outcome;
}

function isIntegrityError(error: unknown): boolean {
  return (
    error instanceof MediaBlobIntegrityError ||
    (error instanceof MediaBlobStoreError && error.code.includes('integrity'))
  );
}

async function lockStorageLedger(transaction: StorageOperationTransaction): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(${MEDIA_CACHE_ADVISORY_LOCK})`);
}

async function readDatabaseClock(transaction: StorageOperationTransaction): Promise<Date> {
  const [clock] = await transaction.execute<{ now: Date | string }>(
    sql`select clock_timestamp() as now`,
  );
  const now = clock ? new Date(clock.now) : null;
  if (!now || !Number.isFinite(now.getTime())) {
    throw new Error('PostgreSQL returned an invalid storage operation clock');
  }
  return now;
}
