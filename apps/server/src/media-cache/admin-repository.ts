import { and, count, desc, eq, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import {
  mediaCacheBlobs,
  mediaCacheCommands,
  mediaCacheObjects,
  mediaCachePostPlans,
  mediaCacheRuntime,
  messageMedia,
} from '../db/schema.js';

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
  id: string;
  kind: string;
  messageId: string;
  planId: string;
  planState: string;
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
  commands: Array<{
    completedAt: string | null;
    createdAt: string;
    errorCode: string | null;
    id: string;
    operation: 'evict' | 'reconcile';
    result: Record<string, unknown> | null;
    state: 'failed' | 'pending' | 'running' | 'succeeded';
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
    const [runtimeRows, plans, objects, blobs, failures, commands] = await Promise.all([
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
          state: mediaCacheCommands.state,
          updatedAt: mediaCacheCommands.updatedAt,
        })
        .from(mediaCacheCommands)
        .orderBy(desc(mediaCacheCommands.createdAt), desc(mediaCacheCommands.id))
        .limit(10),
    ]);
    const runtime = runtimeRows[0];

    return {
      commands: commands.map((command) => ({
        ...command,
        completedAt: command.completedAt?.toISOString() ?? null,
        createdAt: command.createdAt.toISOString(),
        result: sanitizeCommandResult(command.operation, command.result),
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
        id: mediaCacheObjects.id,
        kind: messageMedia.kind,
        messageId: mediaCachePostPlans.messageId,
        planId: mediaCacheObjects.postPlanId,
        planState: mediaCachePostPlans.state,
        reasonCode: mediaCacheObjects.reasonCode,
        state: mediaCacheObjects.state,
        updatedAt: mediaCacheObjects.updatedAt,
        variant: mediaCacheObjects.variant,
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

    return {
      items: pageRows.map((row) => ({
        ...row,
        actualBytes: row.actualBytes?.toString() ?? null,
        declaredBytes: row.declaredBytes?.toString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeObjectCursor({ id: last.id, updatedAt: last.updatedAt })
          : null,
    };
  }
}

function sanitizeCommandResult(
  operation: 'evict' | 'reconcile',
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
