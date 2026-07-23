import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminReader } from './admin/repository.js';
import type { RuntimeAuth } from './auth/runtime-auth.js';
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
  collectorState: () => 'running' | 'stopped';
  messages: MessageReader;
  owners: {
    isOwner(userId: string): Promise<boolean>;
  };
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
    counts: {
      activeChannels: 0,
      blockedTasks: 0,
      configuredChannels: 0,
      messages: 0,
      pendingTasks: 0,
      retryingTasks: 0,
      updates: 0,
    },
    lastCheckpoint: null,
  }),
};
const unavailableAuth: RuntimeAuth = {
  getSession: async () => null,
  handle: async () =>
    Response.json(apiError('auth_unavailable', 'Authentication is not configured'), {
      status: 503,
    }),
};
const unavailableOwners = {
  isOwner: async () => false,
};

function apiError(code: string, message: string): ApiErrorResponse {
  return {
    error: {
      code,
      message,
    },
  };
}

const uuidSchema = z.uuid();

export function createApp(dependencies: Partial<AppDependencies> = {}) {
  const resolved = {
    admin: dependencies.admin ?? unavailableAdminReader,
    adminAssetsRoot: dependencies.adminAssetsRoot,
    auth: dependencies.auth ?? unavailableAuth,
    collectorState: dependencies.collectorState ?? (() => 'stopped' as const),
    messages: dependencies.messages ?? unavailableMessageReader,
    owners: dependencies.owners ?? unavailableOwners,
  };
  const app: Hono = new Hono()
    .on(['GET', 'POST'], '/api/auth/*', (context) => resolved.auth.handle(context.req.raw))
    .get('/healthz', (context) => context.json(healthResponse()))
    .get('/api/v1/health', (context) => context.json(healthResponse()))
    .get('/api/v1/channels', async (context) =>
      context.json({ items: await resolved.messages.listChannels() }),
    )
    .get('/api/v1/messages', async (context) => {
      const parsedChannelId = uuidSchema.safeParse(context.req.query('channel'));
      if (!parsedChannelId.success) {
        return context.json(
          apiError('invalid_channel', 'channel must be a suite channel UUID'),
          400,
        );
      }

      const messages = await resolved.messages.listMessages(parsedChannelId.data);
      if (!messages) {
        return context.json(apiError('channel_not_found', 'Channel was not found'), 404);
      }

      return context.json({ items: messages });
    })
    .get('/api/v1/messages/:id', async (context) => {
      const parsedMessageId = uuidSchema.safeParse(context.req.param('id'));
      if (!parsedMessageId.success) {
        return context.json(apiError('invalid_message_id', 'id must be a suite message UUID'), 400);
      }

      const message = await resolved.messages.getMessage(parsedMessageId.data);
      if (!message) {
        return context.json(apiError('message_not_found', 'Message was not found'), 404);
      }

      return context.json(message);
    })
    .get('/api/v1/admin/status', async (context) => {
      context.header('Cache-Control', 'private, no-store');
      context.header('Vary', 'Cookie');
      const session = await resolved.auth.getSession(context.req.raw.headers);
      if (!session) {
        return context.json(apiError('unauthorized', 'An owner session is required'), 401);
      }
      if (!(await resolved.owners.isOwner(session.user.id))) {
        return context.json(apiError('owner_required', 'The session user is not the owner'), 403);
      }

      const status = await resolved.admin.getStatus();
      return context.json({
        collector: resolved.collectorState(),
        ...status,
        owner: {
          email: session.user.email,
          twoFactorEnabled: session.user.twoFactorEnabled,
        },
        version: VERSION,
      });
    })
    .get('/api/v1/admin/messages/:id/raw', async (context) => {
      context.header('Cache-Control', 'private, no-store');
      context.header('Vary', 'Cookie');
      const session = await resolved.auth.getSession(context.req.raw.headers);
      if (!session) {
        return context.json(apiError('unauthorized', 'An owner session is required'), 401);
      }
      if (!(await resolved.owners.isOwner(session.user.id))) {
        return context.json(apiError('owner_required', 'The session user is not the owner'), 403);
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
