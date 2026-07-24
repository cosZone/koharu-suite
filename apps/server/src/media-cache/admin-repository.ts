import { and, count, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import {
  mediaBlobLocations,
  mediaCacheBlobs,
  mediaCacheCommands,
  mediaCacheObjectProtections,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  mediaStorageBackends,
  messageMedia,
} from '../db/schema.js';
import {
  type MediaCacheCommandOperation,
  sanitizeStorageOperationResult,
} from './command-queue.js';

const objectCursorSchema = z
  .object({
    id: z.uuid(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export interface MediaCacheStateCount {
  count: number;
  state: string;
}

export interface MediaCacheAdminFailure {
  lastErrorClass: string | null;
  lastErrorCode: string | null;
  objectId: string;
  planId: string;
  reasonCode: string | null;
  state: string;
  updatedAt: string;
  variant: 'original' | 'thumbnail';
}

export interface MediaCacheAdminObject {
  actualBytes: string | null;
  canonicalMediaId: string;
  declaredBytes: string | null;
  evictedPolicy?: 'recache_on_access' | 'stay_evicted';
  id: string;
  kind: string;
  locations?: Array<{
    backendId: string;
    lastAccessedAt: string;
    state: 'copying' | 'corrupt' | 'deleting' | 'evicted' | 'missing' | 'ready';
    updatedAt: string;
    verifiedAt: string | null;
    verifiedBytes: string | null;
  }>;
  messageId: string;
  planId: string;
  planState: string;
  protection?: {
    active: boolean;
    expired: boolean;
    expiresAt: string | null;
    protectedAt: string;
    updatedAt: string;
  } | null;
  reasonCode: string | null;
  state: string;
  updatedAt: string;
  variant: 'original' | 'thumbnail';
}

export interface MediaCacheAdminObjectPage {
  items: MediaCacheAdminObject[];
  nextCursor: string | null;
}

export interface MediaCacheAdminStatus {
  backends?: Array<{
    enabled: boolean;
    id: string;
    kind: 'local' | 's3';
    label: string;
    lastReconciledAt: string | null;
    locationStateCounts: MediaCacheStateCount[];
    maxBytes: string;
    readPriority: number;
    readable: boolean;
    readyBytes: string;
    updatedAt: string;
    writable: boolean;
    writePriority: number;
  }>;
  commands: Array<{
    completedAt: string | null;
    createdAt: string;
    errorCode: string | null;
    id: string;
    operation: MediaCacheCommandOperation;
    result: Record<string, unknown> | null;
    sourceBackendId?: string | null;
    state: 'failed' | 'pending' | 'running' | 'succeeded';
    targetBackendId?: string | null;
    targetBytes?: string | null;
    updatedAt: string;
  }>;
  enabled: boolean;
  failures: MediaCacheAdminFailure[];
  stateCounts: {
    blobs: MediaCacheStateCount[];
    objects: MediaCacheStateCount[];
    plans: MediaCacheStateCount[];
  };
  usage: {
    lastReconciledAt: string | null;
    maxBytes: string;
    readyBytes: string;
    reservedBytes: string;
    updatedAt: string | null;
  };
}

export interface MediaCacheAdminReader {
  getStatus(): Promise<MediaCacheAdminStatus>;
  listObjects(input: { cursor?: string; limit: number }): Promise<MediaCacheAdminObjectPage>;
}

export class PostgresMediaCacheAdminRepository implements MediaCacheAdminReader {
  constructor(
    private readonly database: Database,
    private readonly config: {
      enabled: boolean;
      maxBytes: number;
    },
  ) {}

  async getStatus(): Promise<MediaCacheAdminStatus> {
    const [runtimeRows, plans, objects, blobs, failures, commands, backends, locationCounts] =
      await Promise.all([
        this.database
          .select({
            lastReconciledAt: mediaCacheRuntime.lastReconciledAt,
            maxBytes: mediaCacheRuntime.maxBytes,
            readyBytes: mediaCacheRuntime.readyBytes,
            reservedBytes: mediaCacheRuntime.reservedBytes,
            updatedAt: mediaCacheRuntime.updatedAt,
          })
          .from(mediaCacheRuntime)
          .where(eq(mediaCacheRuntime.singletonKey, 'local'))
          .limit(1),
        this.database
          .select({ count: count(), state: mediaCachePostPlans.state })
          .from(mediaCachePostPlans)
          .groupBy(mediaCachePostPlans.state)
          .orderBy(mediaCachePostPlans.state),
        this.database
          .select({ count: count(), state: mediaCacheObjects.state })
          .from(mediaCacheObjects)
          .groupBy(mediaCacheObjects.state)
          .orderBy(mediaCacheObjects.state),
        this.database
          .select({ count: count(), state: mediaCacheBlobs.state })
          .from(mediaCacheBlobs)
          .groupBy(mediaCacheBlobs.state)
          .orderBy(mediaCacheBlobs.state),
        this.database
          .select({
            lastErrorClass: mediaCacheObjects.lastErrorClass,
            lastErrorCode: mediaCacheObjects.lastErrorCode,
            objectId: mediaCacheObjects.id,
            planId: mediaCacheObjects.postPlanId,
            reasonCode: mediaCacheObjects.reasonCode,
            state: mediaCacheObjects.state,
            updatedAt: mediaCacheObjects.updatedAt,
            variant: mediaCacheObjects.variant,
          })
          .from(mediaCacheObjects)
          .where(
            or(
              eq(mediaCacheObjects.state, 'blocked'),
              eq(mediaCacheObjects.state, 'integrity_conflict'),
              eq(mediaCacheObjects.state, 'missing'),
              eq(mediaCacheObjects.state, 'skipped'),
            ),
          )
          .orderBy(desc(mediaCacheObjects.updatedAt), desc(mediaCacheObjects.id))
          .limit(10),
        this.database
          .select({
            completedAt: mediaCacheCommands.completedAt,
            createdAt: mediaCacheCommands.createdAt,
            errorCode: mediaCacheCommands.errorCode,
            id: mediaCacheCommands.id,
            operation: mediaCacheCommands.operation,
            result: mediaCacheCommands.result,
            sourceBackendId: mediaCacheCommands.sourceBackendId,
            state: mediaCacheCommands.state,
            targetBackendId: mediaCacheCommands.targetBackendId,
            targetBytes: mediaCacheCommands.targetBytes,
            updatedAt: mediaCacheCommands.updatedAt,
          })
          .from(mediaCacheCommands)
          .orderBy(desc(mediaCacheCommands.createdAt), desc(mediaCacheCommands.id))
          .limit(10),
        this.database
          .select({
            enabled: mediaStorageBackends.enabled,
            id: mediaStorageBackends.id,
            kind: mediaStorageBackends.kind,
            label: mediaStorageBackends.label,
            lastReconciledAt: mediaStorageBackends.lastReconciledAt,
            maxBytes: mediaStorageBackends.maxBytes,
            readPriority: mediaStorageBackends.readPriority,
            readable: mediaStorageBackends.readable,
            readyBytes: mediaStorageBackends.readyBytes,
            updatedAt: mediaStorageBackends.updatedAt,
            writable: mediaStorageBackends.writable,
            writePriority: mediaStorageBackends.writePriority,
          })
          .from(mediaStorageBackends)
          .orderBy(mediaStorageBackends.readPriority, mediaStorageBackends.id),
        this.database
          .select({
            backendId: mediaBlobLocations.backendId,
            count: count(),
            state: mediaBlobLocations.state,
          })
          .from(mediaBlobLocations)
          .groupBy(mediaBlobLocations.backendId, mediaBlobLocations.state)
          .orderBy(mediaBlobLocations.backendId, mediaBlobLocations.state),
      ]);
    const runtime = runtimeRows[0];
    const locationCountsByBackend = new Map<string, MediaCacheStateCount[]>();
    for (const locationCount of locationCounts) {
      const counts = locationCountsByBackend.get(locationCount.backendId) ?? [];
      counts.push({ count: locationCount.count, state: locationCount.state });
      locationCountsByBackend.set(locationCount.backendId, counts);
    }

    return {
      backends: backends.map((backend) => ({
        ...backend,
        lastReconciledAt: backend.lastReconciledAt?.toISOString() ?? null,
        locationStateCounts: locationCountsByBackend.get(backend.id) ?? [],
        maxBytes: backend.maxBytes.toString(),
        readyBytes: backend.readyBytes.toString(),
        updatedAt: backend.updatedAt.toISOString(),
      })),
      commands: commands.map((command) => ({
        ...command,
        completedAt: command.completedAt?.toISOString() ?? null,
        createdAt: command.createdAt.toISOString(),
        result: sanitizeMediaCacheCommandResult(command.operation, command.result),
        targetBytes: command.targetBytes?.toString() ?? null,
        updatedAt: command.updatedAt.toISOString(),
      })),
      enabled: this.config.enabled,
      failures: failures.map((failure) => ({
        ...failure,
        updatedAt: failure.updatedAt.toISOString(),
      })),
      stateCounts: {
        blobs,
        objects,
        plans,
      },
      usage: {
        lastReconciledAt: runtime?.lastReconciledAt?.toISOString() ?? null,
        maxBytes: (runtime?.maxBytes ?? BigInt(this.config.maxBytes)).toString(),
        readyBytes: (runtime?.readyBytes ?? 0n).toString(),
        reservedBytes: (runtime?.reservedBytes ?? 0n).toString(),
        updatedAt: runtime?.updatedAt.toISOString() ?? null,
      },
    };
  }

  async listObjects(input: { cursor?: string; limit: number }): Promise<MediaCacheAdminObjectPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError('Media cache object limit must be between 1 and 100');
    }
    const cursor = input.cursor ? decodeObjectCursor(input.cursor) : undefined;
    const rows = await this.database
      .select({
        actualBytes: mediaCacheObjects.actualBytes,
        canonicalMediaId: mediaCacheObjects.canonicalMediaId,
        declaredBytes: mediaCacheObjects.declaredBytes,
        evictedPolicy: mediaCacheObjects.evictedPolicy,
        id: mediaCacheObjects.id,
        kind: messageMedia.kind,
        messageId: mediaCachePostPlans.messageId,
        planId: mediaCacheObjects.postPlanId,
        planState: mediaCachePostPlans.state,
        reasonCode: mediaCacheObjects.reasonCode,
        state: mediaCacheObjects.state,
        updatedAt: mediaCacheObjects.updatedAt,
        variant: mediaCacheObjects.variant,
        blobSha256: mediaCacheObjects.blobSha256,
      })
      .from(mediaCacheObjects)
      .innerJoin(mediaCachePostPlans, eq(mediaCachePostPlans.id, mediaCacheObjects.postPlanId))
      .innerJoin(messageMedia, eq(messageMedia.id, mediaCacheObjects.canonicalMediaId))
      .where(
        cursor
          ? or(
              lt(mediaCacheObjects.updatedAt, cursor.updatedAt),
              and(
                eq(mediaCacheObjects.updatedAt, cursor.updatedAt),
                lt(mediaCacheObjects.id, cursor.id),
              ),
            )
          : undefined,
      )
      .orderBy(desc(mediaCacheObjects.updatedAt), desc(mediaCacheObjects.id))
      .limit(input.limit + 1);
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    const blobSha256s = pageRows.flatMap((row) => (row.blobSha256 ? [row.blobSha256] : []));
    const objectIds = pageRows.map((row) => row.id);
    const [locations, protections] = await Promise.all([
      blobSha256s.length > 0
        ? this.database
            .select({
              backendId: mediaBlobLocations.backendId,
              blobSha256: mediaBlobLocations.blobSha256,
              lastAccessedAt: mediaBlobLocations.lastAccessedAt,
              state: mediaBlobLocations.state,
              updatedAt: mediaBlobLocations.updatedAt,
              verifiedAt: mediaBlobLocations.verifiedAt,
              verifiedBytes: mediaBlobLocations.verifiedByteLength,
            })
            .from(mediaBlobLocations)
            .where(inArray(mediaBlobLocations.blobSha256, blobSha256s))
            .orderBy(mediaBlobLocations.backendId)
        : [],
      objectIds.length > 0
        ? this.database
            .select({
              active: sql<boolean>`${mediaCacheObjectProtections.expiresAt} is null
                or ${mediaCacheObjectProtections.expiresAt} > statement_timestamp()`,
              expired: sql<boolean>`${mediaCacheObjectProtections.expiresAt} is not null
                and ${mediaCacheObjectProtections.expiresAt} <= statement_timestamp()`,
              expiresAt: mediaCacheObjectProtections.expiresAt,
              objectId: mediaCacheObjectProtections.objectId,
              protectedAt: mediaCacheObjectProtections.protectedAt,
              updatedAt: mediaCacheObjectProtections.updatedAt,
            })
            .from(mediaCacheObjectProtections)
            .where(inArray(mediaCacheObjectProtections.objectId, objectIds))
        : [],
    ]);
    const locationsByBlob = new Map<string, MediaCacheAdminObject['locations']>();
    for (const location of locations) {
      const items = locationsByBlob.get(location.blobSha256) ?? [];
      items.push({
        backendId: location.backendId,
        lastAccessedAt: location.lastAccessedAt.toISOString(),
        state: location.state,
        updatedAt: location.updatedAt.toISOString(),
        verifiedAt: location.verifiedAt?.toISOString() ?? null,
        verifiedBytes: location.verifiedBytes?.toString() ?? null,
      });
      locationsByBlob.set(location.blobSha256, items);
    }
    const protectionsByObject = new Map(
      protections.map((protection) => [
        protection.objectId,
        {
          active: protection.active,
          expired: protection.expired,
          expiresAt: protection.expiresAt?.toISOString() ?? null,
          protectedAt: protection.protectedAt.toISOString(),
          updatedAt: protection.updatedAt.toISOString(),
        },
      ]),
    );

    return {
      items: pageRows.map(({ blobSha256, ...row }) => ({
        ...row,
        actualBytes: row.actualBytes?.toString() ?? null,
        declaredBytes: row.declaredBytes?.toString() ?? null,
        locations: blobSha256 ? (locationsByBlob.get(blobSha256) ?? []) : [],
        protection: protectionsByObject.get(row.id) ?? null,
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeObjectCursor({ id: last.id, updatedAt: last.updatedAt })
          : null,
    };
  }
}

export function sanitizeMediaCacheCommandResult(
  operation: MediaCacheCommandOperation,
  result: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!result) return null;
  if (operation === 'evict') {
    return {
      ...(typeof result.alreadyApplied === 'boolean'
        ? { alreadyApplied: result.alreadyApplied }
        : {}),
      ...(Number.isSafeInteger(result.evictedObjectCount)
        ? { evictedObjectCount: result.evictedObjectCount }
        : {}),
      ...(result.fileOutcome === 'absent' || result.fileOutcome === 'removed'
        ? { fileOutcome: result.fileOutcome }
        : {}),
      ...(isDecimalString(result.physicalBytesRemoved)
        ? { physicalBytesRemoved: result.physicalBytesRemoved }
        : {}),
      ...(isDecimalString(result.readyBytes) ? { readyBytes: result.readyBytes } : {}),
    };
  }
  if (operation === 'reconcile') {
    const sanitized: Record<string, unknown> = {};
    for (const key of [
      'checked',
      'missing',
      'orphanFailed',
      'orphanFound',
      'orphanRecovered',
      'pages',
      'repairFailed',
      'repaired',
    ]) {
      if (Number.isSafeInteger(result[key]) && Number(result[key]) >= 0) {
        sanitized[key] = result[key];
      }
    }
    return sanitized;
  }
  return sanitizeStorageOperationResult(operation, result);
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/u.test(value);
}

function encodeObjectCursor(cursor: { id: string; updatedAt: Date }): string {
  return Buffer.from(
    JSON.stringify({
      id: cursor.id,
      updatedAt: cursor.updatedAt.toISOString(),
    }),
    'utf8',
  ).toString('base64url');
}

function decodeObjectCursor(value: string): { id: string; updatedAt: Date } {
  if (value.length < 1 || value.length > 512) {
    throw new RangeError('Media cache object cursor is invalid');
  }
  try {
    const parsed = objectCursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    const updatedAt = new Date(parsed.updatedAt);
    if (!Number.isFinite(updatedAt.getTime())) {
      throw new Error('invalid date');
    }
    return {
      id: parsed.id,
      updatedAt,
    };
  } catch {
    throw new RangeError('Media cache object cursor is invalid');
  }
}
