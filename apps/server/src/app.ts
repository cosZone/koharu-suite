import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import {
  OwnerMessageVisibilityConflictError,
  OwnerMessageVisibilityNotFoundError,
  type OwnerMessageVisibilityService,
} from './admin/message-visibility.js';
import {
  AdminOperationConflictError,
  AdminOperationNotFoundError,
  type PostgresAdminOperations,
} from './admin/operations.js';
import type { AdminReader } from './admin/repository.js';
import type { RuntimeAuth } from './auth/runtime-auth.js';
import type { ServiceTokenScope } from './auth/service-token.js';
import { type PublicApiConfig, parseTelegramChannelId } from './config.js';
import {
  decodeAdminMessageCursor,
  decodeLatestMessageCursor,
  decodeMessageCursor,
  encodeAdminMessageCursor,
  encodeLatestMessageCursor,
  encodeMessageCursor,
  type LatestMessageCursor,
  type MessageCursor,
} from './http/cursor.js';
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
import { buildRssDocument } from './messages/rss.js';
import {
  decodeMessageSearchCursor,
  encodeMessageSearchCursor,
  type MessageSearchCursor,
  type MessageSearchKey,
  type MessageSearchSort,
  unicodeLength,
} from './messages/search.js';
import type { MessageDiscoveryReader, MessageReader } from './messages/types.js';
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
  canonicalOrigin: string;
  discovery: MessageDiscoveryReader;
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
  messageVisibility: Pick<OwnerMessageVisibilityService, 'hide' | 'unhide'>;
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
  getMessageContext: async () => null,
  getMessage: async () => null,
  listChannels: async () => [],
  listLatestMessages: async () => ({ items: [], nextCursor: null }),
  listMessages: async () => null,
};
const unavailableDiscoveryReader: MessageDiscoveryReader = {
  getFeed: async (channelId) => ({
    channel:
      channelId === undefined
        ? null
        : {
            id: channelId,
            title: 'Koharu Suite Archive',
            updatedAt: new Date(0).toISOString(),
            username: null,
          },
    items: [],
    updatedAt: null,
  }),
  searchMessages: async (options) => ({
    items: [],
    mode: unicodeLength(options.query) < 3 ? 'short_substring' : 'trigram',
    nextCursor: null,
  }),
};
const unavailableAdminReader: AdminReader = {
  getMessage: async () => null,
  getRawUpdate: async () => null,
  listMessages: async () => null,
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
  migrate: async () => {
    throw new MediaCacheAdminConflictError('Media cache is disabled');
  },
  previewPrune: async () => {
    throw new MediaCacheAdminConflictError('Media cache is disabled');
  },
  protect: async () => {
    throw new MediaCacheAdminConflictError('Media cache is disabled');
  },
  prune: async () => {
    throw new MediaCacheAdminConflictError('Media cache is disabled');
  },
  reconcile: async () => {
    throw new MediaCacheAdminNotSupportedError();
  },
  restore: async () => {
    throw new MediaCacheAdminConflictError('Media cache is disabled');
  },
  retry: async () => {
    throw new MediaCacheAdminConflictError('Media cache is disabled');
  },
  setEvictedPolicy: async () => {
    throw new MediaCacheAdminConflictError('Media cache is disabled');
  },
  unprotect: async () => {
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
const unavailableMessageVisibility: AppDependencies['messageVisibility'] = {
  hide: async () => {
    throw new Error('Owner message visibility service is not configured');
  },
  unhide: async () => {
    throw new Error('Owner message visibility service is not configured');
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
const MAX_VISIBLE_CHANNEL_IDS = 32;
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const storageBackendIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const storageTargetBytesSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/u)
  .transform((value) => BigInt(value))
  .pipe(
    z
      .bigint()
      .min(1n)
      .max(5n * 1024n * 1024n * 1024n * 1024n),
  );
const mediaCacheProtectSchema = reasonSchema
  .extend({
    expiresAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
  })
  .strict();
const mediaCachePolicySchema = reasonSchema
  .extend({ policy: z.enum(['recache_on_access', 'stay_evicted']) })
  .strict();
const mediaCacheMigrateSchema = reasonSchema
  .extend({
    objectId: z.uuid().optional(),
    sourceBackendId: storageBackendIdSchema,
    targetBackendId: storageBackendIdSchema,
  })
  .strict()
  .refine((body) => body.sourceBackendId !== body.targetBackendId);
const mediaCacheRestoreSchema = reasonSchema
  .extend({ targetBackendId: storageBackendIdSchema })
  .strict();
const mediaCachePrunePreviewSchema = z
  .object({
    targetBackendId: storageBackendIdSchema,
    targetBytes: storageTargetBytesSchema,
  })
  .strict();
const mediaCachePruneSchema = reasonSchema
  .extend({
    targetBackendId: storageBackendIdSchema,
    targetBytes: storageTargetBytesSchema,
  })
  .strict();
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
const ownerMessageVisibilitySchema = reasonSchema
  .extend({ expectedUpdatedAt: z.iso.datetime({ offset: true }) })
  .strict();

function isPublicApiPath(path: string, mediaEnabled: boolean): boolean {
  return (
    path === '/api/v1/health' ||
    path === '/api/v1/channels' ||
    /^\/api\/v1\/channels\/[^/]+\/rss\.xml$/u.test(path) ||
    (mediaEnabled && path.startsWith('/api/v1/media/')) ||
    path === '/api/v1/messages' ||
    path.startsWith('/api/v1/messages/') ||
    path === '/api/v1/rss.xml' ||
    path === '/api/v1/search/messages'
  );
}

function forwardedAddress(context: Context): string | null {
  const value = context.req.header('X-Forwarded-For')?.split(',')[0]?.trim();
  return value && value.length <= 128 ? value : null;
}

function parseSearchTimestamp(value: string | undefined): Date | null | false {
  if (value === undefined) {
    return null;
  }
  if (!value.endsWith('Z')) {
    return false;
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    return false;
  }
  return timestamp;
}

function parseVisibleChannelIds(
  context: Context,
):
  | { channelIds: string[]; success: true }
  | { error: 'invalid_channel' | 'too_many_channels'; success: false } {
  const values = new URL(context.req.url).searchParams.getAll('channel');
  const channelIds: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!uuidSchema.safeParse(normalized).success) {
      return { error: 'invalid_channel', success: false };
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      channelIds.push(normalized);
    }
  }
  if (channelIds.length > MAX_VISIBLE_CHANNEL_IDS) {
    return { error: 'too_many_channels', success: false };
  }
  return { channelIds, success: true };
}

export function createApp(dependencies: Partial<AppDependencies> = {}) {
  const mediaEnabled = dependencies.media !== undefined;
  const resolved = {
    admin: dependencies.admin ?? unavailableAdminReader,
    adminAssetsRoot: dependencies.adminAssetsRoot,
    auth: dependencies.auth ?? unavailableAuth,
    canonicalOrigin: dependencies.canonicalOrigin ?? 'http://localhost',
    discovery: dependencies.discovery ?? unavailableDiscoveryReader,
    media: dependencies.media ?? unavailableMediaReader,
    mediaCacheAdmin: dependencies.mediaCacheAdmin ?? unavailableMediaCacheAdmin,
    mediaCacheMutations: dependencies.mediaCacheMutations ?? unavailableMediaCacheMutations,
    messageVisibility: dependencies.messageVisibility ?? unavailableMessageVisibility,
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
  const messageVisibilityFailure = (context: Context, error: unknown) => {
    if (error instanceof OwnerMessageVisibilityNotFoundError) {
      return context.json(apiError('message_not_found', error.message), 404);
    }
    if (error instanceof OwnerMessageVisibilityConflictError) {
      return context.json(apiError('message_visibility_conflict', error.message), 409);
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
        'Content-Length, Content-Range, ETag, Last-Modified, Accept-Ranges',
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
  app.get('/api/v1/search/messages', async (context) => {
    const query = context.req.query('q')?.trim() ?? '';
    const queryLength = unicodeLength(query);
    if (queryLength < 1 || queryLength > 200) {
      return context.json(
        apiError('invalid_query', 'q must contain between 1 and 200 Unicode characters'),
        400,
      );
    }

    const parsedChannels = parseVisibleChannelIds(context);
    if (!parsedChannels.success) {
      if (parsedChannels.error === 'invalid_channel') {
        return context.json(
          apiError('invalid_channel', 'channel must be a suite channel UUID'),
          400,
        );
      }
      return context.json(
        apiError(
          'too_many_channels',
          `channel accepts at most ${MAX_VISIBLE_CHANNEL_IDS} unique IDs`,
        ),
        400,
      );
    }
    const channelId =
      parsedChannels.channelIds.length === 1 ? (parsedChannels.channelIds[0] ?? null) : null;
    const channelIds = parsedChannels.channelIds.length > 1 ? parsedChannels.channelIds : undefined;
    const from = parseSearchTimestamp(context.req.query('from'));
    const to = parseSearchTimestamp(context.req.query('to'));
    if (from === false || to === false || (from !== null && to !== null && from >= to)) {
      return context.json(
        apiError(
          'invalid_time_range',
          'from and to must be canonical UTC timestamps with from earlier than to',
        ),
        400,
      );
    }

    const rawSort = context.req.query('sort');
    const parsedSort =
      rawSort === undefined || rawSort === 'relevance' || rawSort === 'newest'
        ? rawSort
        : 'invalid';
    if (parsedSort === 'invalid') {
      return context.json(apiError('invalid_sort', 'sort must be relevance or newest'), 400);
    }
    const shortQuery = queryLength < 3;
    const sort: MessageSearchSort = parsedSort ?? (shortQuery ? 'newest' : 'relevance');
    const boundedShortRange =
      channelId !== null &&
      from !== null &&
      to !== null &&
      to.getTime() - from.getTime() <= 31 * 24 * 60 * 60 * 1_000;
    if (shortQuery && (!boundedShortRange || sort !== 'newest')) {
      return context.json(
        apiError(
          'short_query_requires_bounded_scope',
          '1-2 character searches require one channel, a UTC window of at most 31 days, and newest sorting',
        ),
        400,
      );
    }

    const maxLimit = shortQuery ? 20 : 50;
    const parsedLimit = z.coerce
      .number()
      .int()
      .min(1)
      .max(maxLimit)
      .default(20)
      .safeParse(context.req.query('limit'));
    if (!parsedLimit.success) {
      return context.json(
        apiError('invalid_limit', `limit must be between 1 and ${maxLimit}`),
        400,
      );
    }

    const key: MessageSearchKey = {
      channelId,
      ...(channelIds ? { channelIds } : {}),
      from: from?.toISOString() ?? null,
      query,
      sort,
      to: to?.toISOString() ?? null,
    };
    let cursor: MessageSearchCursor | undefined;
    const encodedCursor = context.req.query('cursor');
    if (encodedCursor !== undefined) {
      try {
        cursor = decodeMessageSearchCursor(encodedCursor, key);
      } catch {
        return context.json(apiError('invalid_cursor', 'cursor is invalid'), 400);
      }
    }
    const page = await resolved.discovery.searchMessages({
      ...key,
      ...(cursor ? { cursor } : {}),
      limit: parsedLimit.data,
    });
    if (!page) {
      return context.json(apiError('channel_not_found', 'Channel was not found'), 404);
    }
    return context.json({
      items: page.items,
      mode: page.mode,
      nextCursor: page.nextCursor ? encodeMessageSearchCursor(page.nextCursor) : null,
    });
  });
  const serveRss = async (context: Context, channelId?: string) => {
    const feed = await resolved.discovery.getFeed(channelId);
    if (!feed) {
      return context.json(apiError('channel_not_found', 'Channel was not found'), 404);
    }
    const selfPath =
      channelId === undefined
        ? '/api/v1/rss.xml'
        : `/api/v1/channels/${encodeURIComponent(channelId)}/rss.xml`;
    const document = buildRssDocument({
      canonicalOrigin: resolved.canonicalOrigin,
      feed,
      selfPath,
    });
    context.header('Cache-Control', 'public, no-cache');
    context.header('Content-Type', 'application/rss+xml; charset=utf-8');
    context.header('Content-Length', String(document.byteLength));
    context.header('ETag', document.etag);
    context.header('Last-Modified', document.lastModified);
    if (matchesIfNoneMatch(context.req.header('If-None-Match'), document.etag)) {
      return context.body(null, 304);
    }
    if (context.req.method === 'HEAD') {
      return context.body(null, 200);
    }
    return context.body(document.body, 200);
  };
  app.on(['GET', 'HEAD'], '/api/v1/rss.xml', (context) => serveRss(context));
  app.on(['GET', 'HEAD'], '/api/v1/channels/:id/rss.xml', async (context) => {
    const parsedChannelId = uuidSchema.safeParse(context.req.param('id'));
    if (!parsedChannelId.success) {
      return context.json(apiError('invalid_channel', 'id must be a suite channel UUID'), 400);
    }
    return serveRss(context, parsedChannelId.data);
  });
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
  app.get('/api/v1/messages/latest', async (context) => {
    const parsedChannels = parseVisibleChannelIds(context);
    if (!parsedChannels.success) {
      if (parsedChannels.error === 'invalid_channel') {
        return context.json(
          apiError('invalid_channel', 'channel must be a suite channel UUID'),
          400,
        );
      }
      return context.json(
        apiError(
          'too_many_channels',
          `channel accepts at most ${MAX_VISIBLE_CHANNEL_IDS} unique IDs`,
        ),
        400,
      );
    }
    const parsedLimit = listLimitSchema.safeParse(context.req.query('limit'));
    if (!parsedLimit.success) {
      return context.json(apiError('invalid_limit', 'limit must be between 1 and 100'), 400);
    }
    let cursor: LatestMessageCursor | undefined;
    const encodedCursor = context.req.query('cursor');
    if (encodedCursor !== undefined) {
      try {
        cursor = decodeLatestMessageCursor(encodedCursor, parsedChannels.channelIds);
      } catch {
        return context.json(apiError('invalid_cursor', 'cursor is invalid'), 400);
      }
    }
    const page = await resolved.messages.listLatestMessages({
      channelIds: parsedChannels.channelIds,
      ...(cursor ? { cursor } : {}),
      limit: parsedLimit.data,
    });
    return context.json({
      items: page.items,
      nextCursor: page.nextCursor
        ? encodeLatestMessageCursor(page.nextCursor, parsedChannels.channelIds)
        : null,
    });
  });
  app.get('/api/v1/messages/:id/context', async (context) => {
    const parsedMessageId = uuidSchema.safeParse(context.req.param('id'));
    if (!parsedMessageId.success) {
      return context.json(apiError('invalid_message_id', 'id must be a suite message UUID'), 400);
    }
    const result = await resolved.messages.getMessageContext(parsedMessageId.data);
    if (!result) {
      return context.json(apiError('message_not_found', 'Message was not found'), 404);
    }
    return context.json(result);
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
  app.post('/api/v1/admin/media-cache/objects/:id/protect', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) return authorization.response;
    if (authorization.principal.actorType !== 'owner_session') {
      return context.json(apiError('owner_session_required', 'An owner session is required'), 403);
    }
    const id = uuidSchema.safeParse(context.req.param('id'));
    const body = mediaCacheProtectSchema.safeParse(await context.req.json().catch(() => null));
    if (!id.success || !body.success) {
      return context.json(
        apiError(
          'invalid_media_cache_action',
          'A valid object id, reason, and expiry are required',
        ),
        400,
      );
    }
    try {
      return context.json(
        await resolved.mediaCacheMutations.protect({
          ...(body.data.expiresAt ? { expiresAt: body.data.expiresAt } : {}),
          initiatorId: authorization.principal.actorId,
          objectId: id.data,
          reason: body.data.reason,
        }),
      );
    } catch (error) {
      return mediaCacheMutationFailure(context, error);
    }
  });
  app.post('/api/v1/admin/media-cache/objects/:id/unprotect', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) return authorization.response;
    if (authorization.principal.actorType !== 'owner_session') {
      return context.json(apiError('owner_session_required', 'An owner session is required'), 403);
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
      return context.json(
        await resolved.mediaCacheMutations.unprotect({
          initiatorId: authorization.principal.actorId,
          objectId: id.data,
          reason: body.data.reason,
        }),
      );
    } catch (error) {
      return mediaCacheMutationFailure(context, error);
    }
  });
  app.post('/api/v1/admin/media-cache/objects/:id/policy', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) return authorization.response;
    if (authorization.principal.actorType !== 'owner_session') {
      return context.json(apiError('owner_session_required', 'An owner session is required'), 403);
    }
    const id = uuidSchema.safeParse(context.req.param('id'));
    const body = mediaCachePolicySchema.safeParse(await context.req.json().catch(() => null));
    if (!id.success || !body.success) {
      return context.json(
        apiError(
          'invalid_media_cache_action',
          'A valid object id, reason, and policy are required',
        ),
        400,
      );
    }
    try {
      return context.json(
        await resolved.mediaCacheMutations.setEvictedPolicy({
          initiatorId: authorization.principal.actorId,
          objectId: id.data,
          policy: body.data.policy,
          reason: body.data.reason,
        }),
      );
    } catch (error) {
      return mediaCacheMutationFailure(context, error);
    }
  });
  app.post('/api/v1/admin/media-cache/migrate', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) return authorization.response;
    if (authorization.principal.actorType !== 'owner_session') {
      return context.json(apiError('owner_session_required', 'An owner session is required'), 403);
    }
    const body = mediaCacheMigrateSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) {
      return context.json(
        apiError(
          'invalid_media_cache_action',
          'Valid copy source, target, and reason are required',
        ),
        400,
      );
    }
    try {
      return context.json(
        await resolved.mediaCacheMutations.migrate({
          initiatorId: authorization.principal.actorId,
          ...(body.data.objectId ? { objectId: body.data.objectId } : {}),
          reason: body.data.reason,
          sourceBackendId: body.data.sourceBackendId,
          targetBackendId: body.data.targetBackendId,
        }),
        202,
      );
    } catch (error) {
      return mediaCacheMutationFailure(context, error);
    }
  });
  app.post('/api/v1/admin/media-cache/objects/:id/restore', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) return authorization.response;
    if (authorization.principal.actorType !== 'owner_session') {
      return context.json(apiError('owner_session_required', 'An owner session is required'), 403);
    }
    const id = uuidSchema.safeParse(context.req.param('id'));
    const body = mediaCacheRestoreSchema.safeParse(await context.req.json().catch(() => null));
    if (!id.success || !body.success) {
      return context.json(
        apiError(
          'invalid_media_cache_action',
          'A valid object id, target, and reason are required',
        ),
        400,
      );
    }
    try {
      return context.json(
        await resolved.mediaCacheMutations.restore({
          initiatorId: authorization.principal.actorId,
          objectId: id.data,
          reason: body.data.reason,
          targetBackendId: body.data.targetBackendId,
        }),
        202,
      );
    } catch (error) {
      return mediaCacheMutationFailure(context, error);
    }
  });
  app.post('/api/v1/admin/media-cache/prune/preview', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) return authorization.response;
    const body = mediaCachePrunePreviewSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) {
      return context.json(
        apiError('invalid_media_cache_action', 'A valid prune target is required'),
        400,
      );
    }
    try {
      return context.json(await resolved.mediaCacheMutations.previewPrune(body.data));
    } catch (error) {
      return mediaCacheMutationFailure(context, error);
    }
  });
  app.post('/api/v1/admin/media-cache/prune', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) return authorization.response;
    if (authorization.principal.actorType !== 'owner_session') {
      return context.json(apiError('owner_session_required', 'An owner session is required'), 403);
    }
    const body = mediaCachePruneSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) {
      return context.json(
        apiError('invalid_media_cache_action', 'A valid prune target and reason are required'),
        400,
      );
    }
    try {
      return context.json(
        await resolved.mediaCacheMutations.prune({
          initiatorId: authorization.principal.actorId,
          reason: body.data.reason,
          targetBackendId: body.data.targetBackendId,
          targetBytes: body.data.targetBytes,
        }),
        202,
      );
    } catch (error) {
      return mediaCacheMutationFailure(context, error);
    }
  });
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
  app.get('/api/v1/admin/messages', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) return authorization.response;
    if (authorization.principal.actorType !== 'owner_session') {
      return context.json(apiError('owner_session_required', 'An owner session is required'), 403);
    }
    const channelId = uuidSchema.safeParse(context.req.query('channel'));
    const limit = listLimitSchema.safeParse(context.req.query('limit'));
    const visibility = z
      .enum(['all', 'hidden', 'visible'])
      .default('all')
      .safeParse(context.req.query('visibility'));
    if (!channelId.success || !limit.success || !visibility.success) {
      return context.json(
        apiError(
          'invalid_admin_message_query',
          'A valid channel, limit and visibility are required',
        ),
        400,
      );
    }
    let cursor: MessageCursor | undefined;
    const encodedCursor = context.req.query('cursor');
    if (encodedCursor !== undefined) {
      try {
        const decoded = decodeAdminMessageCursor(encodedCursor, {
          channelId: channelId.data,
          visibility: visibility.data,
        });
        cursor = {
          channelId: decoded.channelId,
          messageId: decoded.messageId,
          publishedAt: decoded.publishedAt,
        };
      } catch {
        return context.json(apiError('invalid_cursor', 'cursor is invalid'), 400);
      }
    }
    const page = await resolved.admin.listMessages(channelId.data, {
      ...(cursor ? { cursor } : {}),
      limit: limit.data,
      visibility: visibility.data,
    });
    if (page === null) {
      return context.json(apiError('channel_not_found', 'Channel was not found'), 404);
    }
    return context.json({
      items: page.items,
      nextCursor: page.nextCursor
        ? encodeAdminMessageCursor({ ...page.nextCursor, visibility: visibility.data })
        : null,
    });
  });
  app.get('/api/v1/admin/messages/:id', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) return authorization.response;
    if (authorization.principal.actorType !== 'owner_session') {
      return context.json(apiError('owner_session_required', 'An owner session is required'), 403);
    }
    const messageId = uuidSchema.safeParse(context.req.param('id'));
    if (!messageId.success) {
      return context.json(apiError('invalid_message_id', 'id must be a suite message UUID'), 400);
    }
    const message = await resolved.admin.getMessage(messageId.data);
    if (!message) {
      return context.json(apiError('message_not_found', 'Message was not found'), 404);
    }
    return context.json(message);
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
  for (const action of ['hide', 'unhide'] as const) {
    app.post(`/api/v1/admin/messages/:id/${action}`, async (context) => {
      const authorization = await authorizeAdmin(context, 'content:write');
      if ('response' in authorization) return authorization.response;
      if (authorization.principal.actorType !== 'owner_session') {
        return context.json(
          apiError('owner_session_required', 'An owner session is required'),
          403,
        );
      }
      const messageId = uuidSchema.safeParse(context.req.param('id'));
      const body = ownerMessageVisibilitySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!messageId.success || !body.success) {
        return context.json(
          apiError(
            'invalid_message_visibility_action',
            'A valid message, expected timestamp and 1–500 character reason are required',
          ),
          400,
        );
      }
      try {
        return context.json(
          await resolved.messageVisibility[action]({
            actorId: authorization.principal.actorId,
            actorType: 'owner_session',
            expectedUpdatedAt: body.data.expectedUpdatedAt,
            messageId: messageId.data,
            reason: body.data.reason,
          }),
        );
      } catch (error) {
        return messageVisibilityFailure(context, error);
      }
    });
  }
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
