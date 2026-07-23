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
import type { MessageReader } from './messages/types.js';
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

const uuidSchema = z.uuid();
const listLimitSchema = z.coerce.number().int().min(1).max(100).default(50);
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

function isPublicApiPath(path: string): boolean {
  return (
    path === '/api/v1/health' ||
    path === '/api/v1/channels' ||
    path === '/api/v1/messages' ||
    path.startsWith('/api/v1/messages/')
  );
}

function forwardedAddress(context: Context): string | null {
  const value = context.req.header('X-Forwarded-For')?.split(',')[0]?.trim();
  return value && value.length <= 128 ? value : null;
}

export function createApp(dependencies: Partial<AppDependencies> = {}) {
  const resolved = {
    admin: dependencies.admin ?? unavailableAdminReader,
    adminAssetsRoot: dependencies.adminAssetsRoot,
    auth: dependencies.auth ?? unavailableAuth,
    messages: dependencies.messages ?? unavailableMessageReader,
    operations: dependencies.operations ?? unavailableOperations,
    publicApi: dependencies.publicApi ?? defaultPublicApi,
    publicClientAddress: dependencies.publicClientAddress ?? defaultPublicClientAddress,
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

  app.use('/api/v1/*', async (context, next) => {
    if (!isPublicApiPath(context.req.path)) {
      await next();
      return;
    }

    const origin = matchCorsOrigin(context.req.header('Origin'), resolved.publicApi.corsOrigins);
    if (origin) {
      context.header('Access-Control-Allow-Origin', origin);
      context.header('Access-Control-Allow-Methods', 'GET');
      context.header('Access-Control-Allow-Headers', 'Content-Type');
      context.header('Vary', 'Origin');
    }
    if (context.req.method === 'OPTIONS') {
      return context.body(null, 204);
    }
    if (context.req.method !== 'GET') {
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
  app.get('/api/v1/admin/messages/:id/raw', async (context) => {
    const authorization = await authorizeAdmin(context, 'admin:read');
    if ('response' in authorization) {
      return authorization.response;
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
