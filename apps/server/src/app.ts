import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import {
  AdminOperationConflictError,
  AdminOperationNotFoundError,
  type PostgresAdminOperations,
} from './admin/operations.js';
import type { AdminReader } from './admin/repository.js';
import type { RuntimeAuth } from './auth/runtime-auth.js';
import type { ServiceTokenScope } from './auth/service-token.js';
import { type PublicApiConfig, parseTelegramChannelId } from './config.js';
import { decodeMessageCursor, encodeMessageCursor, type MessageCursor } from './http/cursor.js';
import { FixedWindowRateLimiter, matchCorsOrigin } from './http/public-policy.js';
import type { MediaCacheAdminReader } from './media-cache/admin-repository.js';
import {
  MediaCacheAdminConflictError,
  type MediaCacheAdminMutations,
  MediaCacheAdminNotFoundError,
  MediaCacheAdminNotSupportedError,
} from './media-cache/admin-service.js';
import { resolveMediaByteRange } from './media-cache/http-range.js';
import type { PublicMediaReader } from './media-cache/public-reader.js';
import type { MessageReader } from './messages/types.js';
import type { PostgresReconciliationPersistenceRepository } from './reconciliation/persistence-repository.js';
import type { DeterministicRepairService } from './reconciliation/repair.js';
import type { MessageTombstoneService } from './reconciliation/tombstone.js';
import { VERSION } from './version.js';

export interface HealthResponse {
  service: 'koharu-suite';
  status: 'ok';
  version: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export interface AppDependencies {
  admin: AdminReader;
  adminAssetsRoot?: string;
  auth: RuntimeAuth;
  media: PublicMediaReader;
  mediaCacheAdmin: MediaCacheAdminReader;
  mediaCacheMutations: MediaCacheAdminMutations;
  messages: MessageReader;
  operations: Pick<
    PostgresAdminOperations,
    | 'listBlockedTasks'
    | 'listConfiguredChannels'
    | 'rerenderOutdated'
    | 'retryTask'
    | 'setChannelEnabled'
    | 'skipTask'
  >;
  /** @deprecated Owner authorization is enforced by RuntimeAuth. */
  owners: {
    isOwner(userId: string): Promise<boolean>;
  };
  publicApi: PublicApiConfig;
  publicClientAddress: (context: Context) => string;
  reconciliation: Pick<
    PostgresReconciliationPersistenceRepository,
    'ignoreFinding' | 'listFindings' | 'listRuns' | 'persistScan'
  >;
  repair: Pick<DeterministicRepairService, 'apply'>;
  tombstone: Pick<MessageTombstoneService, 'hide' | 'unhide'>;
  readiness: () => Promise<void>;
}

const healthResponse = (): HealthResponse => ({
  service: 'koharu-suite',
  status: 'ok',
  version: VERSION,
});

const unavailableMessageReader: MessageReader = {
  getMessage: async () => null,
  listChannels: async () => [],
  listMessages: async () => null,
};
const unavailableAdminReader: AdminReader = {
  getRawUpdate: async () => null,
  getStatus: async () => ({
    collector: {
      heartbeatAt: null,
      lastTelegramSuccessAt: null,
      startedAt: null,
      state: 'stopped',
      version: null,
    },
    counts: {
      activeChannels: 0,
      blockedTasks: 0,
      configuredChannels: 0,
      messages: 0,
      pendingTasks: 0,
      retryingTasks: 0,
      skippedTasks: 0,
      staleRendererRevisions: 0,
      updates: 0,
    },
    lastCheckpoint: null,
  }),
};
const unavailableAuth: RuntimeAuth = {
  authorize: async () => ({ allowed: false, principal: null }),
  getSession: async () => null,
  handle: async () =>
    Response.json(apiError('auth_unavailable', 'Authentication is not configured'), {
      status: 503,
    }),
};
const unavailableMediaReader: PublicMediaReader = {
  open: async () => null,
};
const unavailableMediaCacheAdmin: MediaCacheAdminReader = {
  getStatus: async () => ({
    commands: [],
    enabled: false,
    failures: [],
    stateCounts: { blobs: [], objects: [], plans: [] },
    usage: {
      lastReconciledAt: null,
      maxBytes: '0',
      readyBytes: '0',
      reservedBytes: '0',
      updatedAt: null,
    },
  }),
  listObjects: async () => ({ items: [], nextCursor: null }),
};
const unavailableMediaCacheMutations: MediaCacheAdminMutations = {
  evict: async () => {
    throw new MediaCacheAdminConflictError('Media cache is disabled');
  },
  reconcile: async () => {
    throw new MediaCacheAdminNotSupportedError();
  },
  retry: async () => {
    throw new MediaCacheAdminConflictError('Media cache is disabled');
  },
};
const unavailableOperations: AppDependencies['operations'] = {
  listBlockedTasks: async () => [],
  listConfiguredChannels: async () => [],
  rerenderOutdated: async () => ({
    currentVersion: 0,
    hasMore: false,
    updated: 0,
  }),
  retryTask: async () => {
    throw new Error('Admin operations are not configured');
  },
  setChannelEnabled: async () => {
    throw new Error('Admin operations are not configured');
  },
  skipTask: async () => {
    throw new Error('Admin operations are not configured');
  },
};
const defaultPublicApi: PublicApiConfig = {
  corsOrigins: new Set(),
  rateLimitMax: 120,
  rateLimitWindowMs: 60_000,
  trustProxy: false,
};
const unavailableReconciliation: AppDependencies['reconciliation'] = {
  ignoreFinding: async () => {
    throw new Error('Reconciliation is not configured');
  },
  listFindings: async () => ({ items: [], nextCursor: null }),
  listRuns: async () => ({ items: [], nextCursor: null }),
  persistScan: async () => {
    throw new Error('Reconciliation is not configured');
  },
};
const unavailableRepair: AppDependencies['repair'] = {
  apply: async () => {
    throw new Error('Reconciliation repair is not configured');
  },
};
const unavailableTombstone: AppDependencies['tombstone'] = {
  hide: async () => {
    throw new Error('Message tombstone service is not configured');
  },
  unhide: async () => {
    throw new Error('Message tombstone service is not configured');
  },
};

function defaultPublicClientAddress(context: Context): string {
  try {
    return getConnInfo(context).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function apiError(code: string, message: string): ApiErrorResponse {
  return {
    error: {
      code,
      message,
    },
  };
}

function reconciliationMutationStatus(error: unknown): 404 | 409 | null {
  if (!(error instanceof Error)) return null;
  if (error.message.includes('not found')) return 404;
  if (
    [
      'Only ',
      'Ignored ',
      'cannot ',
      'changed',
      'concurrently',
      'does not match',
      'does not reproduce',
      'exceeds',
      'has no deterministic safe repair',
      'outside',
      'requires',
      'unsupported',
    ].some((fragment) => error.message.includes(fragment))
  ) {
    return 409;
  }
  return null;
}

const uuidSchema = z.uuid();
const listLimitSchema = z.coerce.number().int().min(1).max(100).default(50);
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const mediaCacheReconcileSchema = reasonSchema;
const mediaCacheObjectListSchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: listLimitSchema,
  })
  .strict();
const reconciliationActionSchema = z
  .object({
    expectedEvidenceVersion: z.number().int().min(1),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
const reconciliationScanSchema = z
  .object({
    telegramChannelIds: z
      .array(
        z
          .string()
          .trim()
          .max(17)
          .regex(/^-[1-9]\d*$/u),
      )
      .min(1)
      .max(100),
  })
  .strict();
const reconciliationTombstoneSchema = reconciliationActionSchema
  .extend({ messageId: z.uuid() })
  .strict();

function isPublicApiPath(path: string, mediaEnabled: boolean): boolean {
  return (
    path === '/api/v1/health' ||
    path === '/api/v1/channels' ||
    (mediaEnabled && path.startsWith('/api/v1/media/')) ||
    path === '/api/v1/messages' ||
    path.startsWith('/api/v1/messages/')
  );
}

function forwardedAddress(context: Context): string | null {
  const value = context.req.header('X-Forwarded-For')?.split(',')[0]?.trim();
  return value && value.length <= 128 ? value : null;
}

export function createApp(dependencies: Partial<AppDependencies> = {}) {
  const mediaEnabled = dependencies.media !== undefined;
  const resolved = {
    admin: dependencies.admin ?? unavailableAdminReader,
    adminAssetsRoot: dependencies.adminAssetsRoot,
    auth: dependencies.auth ?? unavailableAuth,
    media: dependencies.media ?? unavailableMediaReader,
    mediaCacheAdmin: dependencies.mediaCacheAdmin ?? unavailableMediaCacheAdmin,
    mediaCacheMutations: dependencies.mediaCacheMutations ?? unavailableMediaCacheMutations,
    messages: dependencies.messages ?? unavailableMessageReader,
    operations: dependencies.operations ?? unavailableOperations,
    publicApi: dependencies.publicApi ?? defaultPublicApi,
    publicClientAddress: dependencies.publicClientAddress ?? defaultPublicClientAddress,
    reconciliation: dependencies.reconciliation ?? unavailableReconciliation,
    repair: dependencies.repair ?? unavailableRepair,
    tombstone: dependencies.tombstone ?? unavailableTombstone,
    readiness:
      dependencies.readiness ??
      (async () => {
        throw new Error('Readiness probe is not configured');
      }),
  };
  const limiter = new FixedWindowRateLimiter({
    max: resolved.publicApi.rateLimitMax,
    maxBuckets: 10_000,
    windowMs: resolved.publicApi.rateLimitWindowMs,
  });
  const app: Hono = new Hono();

  const authorizeAdmin = async (context: Context, scope: ServiceTokenScope) => {
    context.header('Cache-Control', 'private, no-store');
    context.header('Vary', 'Cookie, Authorization');
    const authorization = await resolved.auth.authorize(context.req.raw.headers, scope);
    if (!authorization.principal) {
      return {
        response: context.json(
          apiError('unauthorized', 'An owner session or service token is required'),
          401,
        ),
      };
    }
    if (!authorization.allowed) {
      return {
        response: context.json(
          apiError('insufficient_scope', `The credential requires ${scope}`),
          403,
        ),
      };
    }
    return { principal: authorization.principal };
  };

  const operationFailure = (context: Context, error: unknown) => {
    if (error instanceof AdminOperationNotFoundError) {
      return context.json(apiError('operation_target_not_found', error.message), 404);
    }
    if (error instanceof AdminOperationConflictError) {
      return context.json(apiError('operation_conflict', error.message), 409);
    }
    throw error;
  };

  const mediaCacheMutationFailure = (context: Context, error: unknown) => {
    if (error instanceof MediaCacheAdminNotFoundError) {
      return context.json(apiError('media_cache_object_not_found', error.message), 404);
    }
    if (error instanceof MediaCacheAdminNotSupportedError) {
      return context.json(apiError('media_cache_reconciliation_not_supported', error.message), 409);
    }
    if (error instanceof MediaCacheAdminConflictError) {
      return context.json(apiError('media_cache_conflict', error.message), 409);
    }
    if (error instanceof RangeError) {
      return context.json(apiError('invalid_media_cache_action', error.message), 400);
    }
    throw error;
  };

  app.use('/api/v1/*', async (context, next) => {
    if (!isPublicApiPath(context.req.path, mediaEnabled)) {
      await next();
      return;
    }

    const origin = matchCorsOrigin(context.req.header('Origin'), resolved.publicApi.corsOrigins);
    if (resolved.publicApi.corsOrigins.size > 0) {
      context.header('Vary', 'Origin');
    }
    if (origin) {
      context.header('Access-Control-Allow-Origin', origin);
      context.header('Access-Control-Allow-Methods', 'GET, HEAD');
      context.header(
        'Access-Control-Allow-Headers',
        'Content-Type, Range, If-Range, If-None-Match',
      );
      context.header(
        'Access-Control-Expose-Headers',
        'Content-Length, Content-Range, ETag, Accept-Ranges',
      );
    }
    if (context.req.method === 'OPTIONS') {
      return context.body(null, 204);
    }
    if (context.req.method !== 'GET' && context.req.method !== 'HEAD') {
      await next();
      return;
    }

    const address =
      (resolved.publicApi.trustProxy ? forwardedAddress(context) : null) ??
      resolved.publicClientAddress(context);
    const decision = limiter.consume(address);
    context.header('RateLimit-Limit', String(decision.limit));
    context.header('RateLimit-Remaining', String(decision.remaining));
    context.header('RateLimit-Reset', String(Math.ceil(decision.resetAt / 1_000)));
    if (!decision.allowed) {
      context.header('Retry-After', String(decision.retryAfterSeconds));
      return context.json(apiError('rate_limited', 'Too many requests'), 429);
    }
    await next();
  });

  app.on(['GET', 'POST'], '/api/auth/*', (context) => resolved.auth.handle(context.req.raw));
  app.get('/healthz', (context) => context.json(healthResponse()));
  app.get('/readyz', async (context) => {
    try {
      await resolved.readiness();
      return context.json(healthResponse());
    } catch {
      return context.json(apiError('not_ready', 'Database is unavailable'), 503);
    }
  });
  app.get('/api/v1/health', (context) => context.json(healthResponse()));
  app.get('/api/v1/channels', async (context) =>
    context.json({ items: await resolved.messages.listChannels() }),
  );
  if (mediaEnabled) {
    app.on(['GET', 'HEAD'], '/api/v1/media/:id', async (context) => {
      const parsedObjectId = uuidSchema.safeParse(context.req.param('id'));
      if (!parsedObjectId.success) {
        context.header('Cache-Control', 'private, no-store');
        return context.json(
          apiError('invalid_media_id', 'id must be a suite media object UUID'),
          400,
        );
      }
      const opened = await resolved.media.open(parsedObjectId.data);
      if (!opened) {
        context.header('Cache-Control', 'private, no-store');
        return context.json(apiError('media_not_found', 'Media was not found'), 404);
      }

      context.header('Content-Type', opened.contentType);
      context.header('ETag', opened.etag);
      context.header('Cache-Control', 'public, no-cache');
      context.header('X-Content-Type-Options', 'nosniff');
      if (opened.variant === 'original') {
        context.header('Accept-Ranges', 'bytes');
      }

      if (matchesIfNoneMatch(context.req.header('If-None-Match'), opened.etag)) {
        await opened.close();
        return context.body(null, 304);
      }

      if (context.req.method === 'HEAD') {
        context.header('Content-Length', String(opened.byteLength));
        await opened.close();
        return context.body(null, 200);
      }

      const requestedRange =
        opened.variant === 'original' &&
        (context.req.header('If-Range') === undefined ||
          context.req.header('If-Range') === opened.etag)
          ? resolveMediaByteRange(context.req.header('Range'), opened.byteLength)
          : null;
      if (requestedRange === 'unsatisfiable') {
        context.header('Cache-Control', 'private, no-store');
        context.header('Content-Range', `bytes */${opened.byteLength}`);
        await opened.close();
        return context.body(null, 416);
      }
      if (requestedRange) {
        context.header('Content-Length', String(requestedRange.length));
        context.header(
          'Content-Range',
          `bytes ${requestedRange.start}-${requestedRange.end}/${opened.byteLength}`,
        );
        return context.body(opened.stream(requestedRange), 206);
      }

      context.header('Content-Length', String(opened.byteLength));
      return context.body(opened.stream(), 200);
    });
  }
  app.get('/api/v1/messages', async (context) => {
    const parsedChannelId = uuidSchema.safeParse(context.req.query('channel'));
    if (!parsedChannelId.success) {
      return context.json(apiError('invalid_channel', 'channel must be a suite channel UUID'), 400);
    }
    const parsedLimit = listLimitSchema.safeParse(context.req.query('limit'));
    if (!parsedLimit.success) {
      return context.json(apiError('invalid_limit', 'limit must be between 1 and 100'), 400);
    }

    let cursor: MessageCursor | undefined;
    const encodedCursor = context.req.query('cursor');
    if (encodedCursor !== undefined) {
      try {
        cursor = decodeMessageCursor(encodedCursor, { channelId: parsedChannelId.data });
      } catch {
        return context.json(apiError('invalid_cursor', 'cursor is invalid'), 400);
      }
    }
    const page = await resolved.messages.listMessages(parsedChannelId.data, {
      ...(cursor ? { cursor } : {}),
      limit: parsedLimit.data,
    });
    if (!page) {
      return context.json(apiError('channel_not_found', 'Channel was not found'), 404);
    }

    return context.json({
      items: page.items,
      nextCursor: page.nextCursor ? encodeMessageCursor(page.nextCursor) : null,
    });
  });
  app.get('/api/v1/messages/:id', async (context) => {
    const parsedMessageId = uuidSchema.safeParse(context.req.param('id'));
    if (!parsedMessageId.success) {
      return context.json(apiError('invalid_message_id', 'id must be a suite message UUID'), 400);
    }

    const message = await resolved.messages.getMessage(parsedMessageId.data);
    if (!message) {
      return context.json(apiError('message_not_found', 'Message was not found'), 404);
    }

    return context.json(message);
  });
  app.get('/api/v1/admin/status', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) {
      return authorization.response;
    }
    const status = await resolved.admin.getStatus();
    return context.json({
      ...status,
      owner: {
        email: authorization.principal.email,
        twoFactorEnabled: authorization.principal.twoFactorEnabled,
      },
      version: VERSION,
    });
  });
  app.get('/api/v1/admin/media-cache/status', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) {
      return authorization.response;
    }
    return context.json(await resolved.mediaCacheAdmin.getStatus());
  });
  app.get('/api/v1/admin/media-cache/objects', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) {
      return authorization.response;
    }
    const parsed = mediaCacheObjectListSchema.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json(apiError('invalid_media_cache_query', 'Invalid cursor or limit'), 400);
    }
    try {
      return context.json(
        await resolved.mediaCacheAdmin.listObjects({
          limit: parsed.data.limit,
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof RangeError) {
        return context.json(apiError('invalid_media_cache_query', error.message), 400);
      }
      throw error;
    }
  });
  for (const action of ['retry', 'evict'] as const) {
    app.post(`/api/v1/admin/media-cache/objects/:id/${action}`, async (context) => {
      const authorization = await authorizeAdmin(context, 'admin:read');
      if ('response' in authorization) {
        return authorization.response;
      }
      if (authorization.principal.actorType !== 'owner_session') {
        return context.json(
          apiError('owner_session_required', 'An owner session is required'),
          403,
        );
      }
      const id = uuidSchema.safeParse(context.req.param('id'));
      const body = reasonSchema.safeParse(await context.req.json().catch(() => null));
      if (!id.success || !body.success) {
        return context.json(
          apiError('invalid_media_cache_action', 'A valid object id and reason are required'),
          400,
        );
      }
      try {
        const result = await resolved.mediaCacheMutations[action]({
          initiatorId: authorization.principal.actorId,
          objectId: id.data,
          reason: body.data.reason,
        });
        return context.json(result, action === 'evict' ? 202 : 200);
      } catch (error) {
        return mediaCacheMutationFailure(context, error);
      }
    });
  }
  app.post('/api/v1/admin/media-cache/reconcile', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) {
      return authorization.response;
    }
    if (authorization.principal.actorType !== 'owner_session') {
      return context.json(apiError('owner_session_required', 'An owner session is required'), 403);
    }
    const body = mediaCacheReconcileSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) {
      return context.json(
        apiError('invalid_media_cache_action', 'A valid reason is required'),
        400,
      );
    }
    try {
      return context.json(
        await resolved.mediaCacheMutations.reconcile({
          initiatorId: authorization.principal.actorId,
          reason: body.data.reason,
        }),
        202,
      );
    } catch (error) {
      return mediaCacheMutationFailure(context, error);
    }
  });
  app.get('/api/v1/admin/messages/:id/raw', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) {
      return authorization.response;
    }
    if (authorization.principal.actorType !== 'owner_session') {
      return context.json(
        apiError('owner_session_required', 'An owner session is required to reveal raw evidence'),
        403,
      );
    }
    const parsedMessageId = uuidSchema.safeParse(context.req.param('id'));
    if (!parsedMessageId.success) {
      return context.json(apiError('invalid_message_id', 'id must be a suite message UUID'), 400);
    }

    const update = await resolved.admin.getRawUpdate(parsedMessageId.data);
    if (!update) {
      return context.json(apiError('message_not_found', 'Message was not found'), 404);
    }
    return context.json({ update });
  });
  app.get('/api/v1/admin/tasks/blocked', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) {
      return authorization.response;
    }
    return context.json({ items: await resolved.operations.listBlockedTasks() });
  });
  app.post('/api/v1/admin/tasks/:id/retry', async (context) => {
    const authorization = await authorizeAdmin(context, 'ingestion:write');
    if ('response' in authorization) {
      return authorization.response;
    }
    const parsedId = uuidSchema.safeParse(context.req.param('id'));
    const parsedBody = reasonSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsedId.success || !parsedBody.success) {
      return context.json(
        apiError('invalid_operation', 'A valid task id and reason are required'),
        400,
      );
    }
    try {
      await resolved.operations.retryTask(
        parsedId.data,
        parsedBody.data.reason,
        authorization.principal,
      );
      return context.json({ success: true });
    } catch (error) {
      return operationFailure(context, error);
    }
  });
  app.post('/api/v1/admin/tasks/:id/skip', async (context) => {
    const authorization = await authorizeAdmin(context, 'ingestion:write');
    if ('response' in authorization) {
      return authorization.response;
    }
    const parsedId = uuidSchema.safeParse(context.req.param('id'));
    const parsedBody = reasonSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsedId.success || !parsedBody.success) {
      return context.json(
        apiError('invalid_operation', 'A valid task id and reason are required'),
        400,
      );
    }
    try {
      await resolved.operations.skipTask(
        parsedId.data,
        parsedBody.data.reason,
        authorization.principal,
      );
      return context.json({ success: true });
    } catch (error) {
      return operationFailure(context, error);
    }
  });
  app.get('/api/v1/admin/channels', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) {
      return authorization.response;
    }
    return context.json({ items: await resolved.operations.listConfiguredChannels() });
  });
  app.post('/api/v1/admin/channels/:telegramId/:action', async (context) => {
    const authorization = await authorizeAdmin(context, 'ingestion:write');
    if ('response' in authorization) {
      return authorization.response;
    }
    const action = context.req.param('action');
    if (action !== 'enable' && action !== 'disable') {
      return context.json(
        apiError('invalid_channel_action', 'action must be enable or disable'),
        400,
      );
    }
    let telegramChatId: bigint;
    try {
      telegramChatId = parseTelegramChannelId(context.req.param('telegramId'));
    } catch {
      return context.json(apiError('invalid_telegram_id', 'telegramId is invalid'), 400);
    }
    try {
      const channel = await resolved.operations.setChannelEnabled(
        telegramChatId,
        action === 'enable',
        authorization.principal,
      );
      return context.json(channel);
    } catch (error) {
      return operationFailure(context, error);
    }
  });
  app.post('/api/v1/admin/rerender', async (context) => {
    const authorization = await authorizeAdmin(context, 'content:write');
    if ('response' in authorization) {
      return authorization.response;
    }
    return context.json(await resolved.operations.rerenderOutdated(authorization.principal));
  });
  app.get('/api/v1/admin/reconciliation/findings', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) return authorization.response;
    const parsed = z
      .object({ cursor: z.string().min(1).max(512).optional(), limit: listLimitSchema })
      .safeParse(context.req.query());
    if (!parsed.success) {
      return context.json(apiError('invalid_reconciliation_query', 'Invalid cursor or limit'), 400);
    }
    try {
      return context.json(
        await resolved.reconciliation.listFindings({
          limit: parsed.data.limit,
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof RangeError) {
        return context.json(apiError('invalid_reconciliation_query', error.message), 400);
      }
      throw error;
    }
  });
  app.get('/api/v1/admin/reconciliation/runs', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) return authorization.response;
    const parsed = z
      .object({ cursor: z.uuid().optional(), limit: listLimitSchema })
      .safeParse(context.req.query());
    if (!parsed.success) {
      return context.json(apiError('invalid_reconciliation_query', 'Invalid cursor or limit'), 400);
    }
    try {
      return context.json(
        await resolved.reconciliation.listRuns({
          limit: parsed.data.limit,
          ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof RangeError) {
        return context.json(apiError('invalid_reconciliation_query', error.message), 400);
      }
      throw error;
    }
  });
  app.post('/api/v1/admin/reconciliation/scan', async (context) => {
    const authorization = await authorizeAdmin(context, 'content:write');
    if ('response' in authorization) return authorization.response;
    const parsed = reconciliationScanSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json(
        apiError('invalid_reconciliation_scan', 'Valid channel IDs are required'),
        400,
      );
    }
    let telegramChannelIds: bigint[];
    try {
      telegramChannelIds = parsed.data.telegramChannelIds.map(parseTelegramChannelId);
    } catch {
      return context.json(
        apiError('invalid_reconciliation_scan', 'Valid channel IDs are required'),
        400,
      );
    }
    const result = await resolved.reconciliation.persistScan({
      initiatorId: authorization.principal.actorId,
      initiatorKind: authorization.principal.actorType,
      telegramChannelIds,
    });
    return context.json(result);
  });
  app.post('/api/v1/admin/reconciliation/findings/:id/repair', async (context) => {
    const authorization = await authorizeAdmin(context, 'content:write');
    if ('response' in authorization) return authorization.response;
    const id = uuidSchema.safeParse(context.req.param('id'));
    const body = reconciliationActionSchema.safeParse(await context.req.json().catch(() => null));
    if (!id.success || !body.success) {
      return context.json(
        apiError('invalid_reconciliation_action', 'Valid id, version and reason are required'),
        400,
      );
    }
    try {
      return context.json(
        await resolved.repair.apply({
          ...body.data,
          findingId: id.data,
          initiatorId: authorization.principal.actorId,
          initiatorKind: authorization.principal.actorType,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const status = reconciliationMutationStatus(error);
      if (status === 404) return context.json(apiError('finding_not_found', message), 404);
      if (status === 409) {
        return context.json(apiError('reconciliation_conflict', message), 409);
      }
      throw error;
    }
  });
  app.post('/api/v1/admin/reconciliation/findings/:id/ignore', async (context) => {
    const authorization = await authorizeAdmin(context, 'content:write');
    if ('response' in authorization) return authorization.response;
    if (authorization.principal.actorType !== 'owner_session') {
      return context.json(apiError('owner_session_required', 'An owner session is required'), 403);
    }
    const id = uuidSchema.safeParse(context.req.param('id'));
    const body = reconciliationActionSchema.safeParse(await context.req.json().catch(() => null));
    if (!id.success || !body.success) {
      return context.json(
        apiError('invalid_reconciliation_action', 'Valid id, version and reason are required'),
        400,
      );
    }
    try {
      return context.json(
        await resolved.reconciliation.ignoreFinding({
          ...body.data,
          findingId: id.data,
          initiatorId: authorization.principal.actorId,
          initiatorKind: 'owner_session',
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const status = reconciliationMutationStatus(error);
      if (status === 404) return context.json(apiError('finding_not_found', message), 404);
      if (status === 409) {
        return context.json(apiError('reconciliation_conflict', message), 409);
      }
      throw error;
    }
  });
  for (const action of ['hide', 'unhide'] as const) {
    app.post(`/api/v1/admin/reconciliation/findings/:id/${action}`, async (context) => {
      const authorization = await authorizeAdmin(context, 'content:write');
      if ('response' in authorization) return authorization.response;
      if (authorization.principal.actorType !== 'owner_session') {
        return context.json(
          apiError('owner_session_required', 'An owner session is required'),
          403,
        );
      }
      const id = uuidSchema.safeParse(context.req.param('id'));
      const body = reconciliationTombstoneSchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!id.success || !body.success) {
        return context.json(
          apiError(
            'invalid_reconciliation_tombstone',
            'Valid finding, message, version and reason are required',
          ),
          400,
        );
      }
      try {
        return context.json(
          await resolved.tombstone[action]({
            ...body.data,
            findingId: id.data,
            initiatorId: authorization.principal.actorId,
            initiatorKind: 'owner_session',
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const status = reconciliationMutationStatus(error);
        if (status === 404) {
          return context.json(apiError('finding_or_message_not_found', message), 404);
        }
        if (status === 409) {
          return context.json(apiError('reconciliation_conflict', message), 409);
        }
        throw error;
      }
    });
  }

  if (resolved.adminAssetsRoot) {
    const staticMiddleware = serveStatic({
      rewriteRequestPath: (path) => path.replace(/^\/admin/, '') || '/',
      root: resolved.adminAssetsRoot,
    });

    app.get('/admin', (context) => context.redirect('/admin/', 308));
    app.use('/admin/*', async (context, next) => {
      context.header(
        'Cache-Control',
        context.req.path.startsWith('/admin/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      );
      await next();
    });
    app.use('/admin/*', staticMiddleware);
  }

  return app;
}

function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  const value = header.trim();
  if (value === '*') {
    return true;
  }

  const comparableEtag = etag.startsWith('W/') ? etag.slice(2) : etag;
  let matched = false;
  let offset = 0;
  while (offset < value.length) {
    while (value[offset] === ' ' || value[offset] === '\t') {
      offset += 1;
    }
    if (value.startsWith('W/', offset)) {
      offset += 2;
    }
    if (value[offset] !== '"') {
      return false;
    }
    const tagStart = offset;
    offset += 1;
    while (offset < value.length && value[offset] !== '"') {
      const code = value.charCodeAt(offset);
      if (code < 0x21 || code === 0x7f) {
        return false;
      }
      offset += 1;
    }
    if (offset >= value.length) {
      return false;
    }
    offset += 1;
    if (value.slice(tagStart, offset) === comparableEtag) {
      matched = true;
    }
    while (value[offset] === ' ' || value[offset] === '\t') {
      offset += 1;
    }
    if (offset === value.length) {
      break;
    }
    if (value[offset] !== ',') {
      return false;
    }
    offset += 1;
  }
  return matched;
}
