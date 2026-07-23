import { Hono } from 'hono';
import { z } from 'zod';
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
  messages: MessageReader;
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

function apiError(code: string, message: string): ApiErrorResponse {
  return {
    error: {
      code,
      message,
    },
  };
}

const uuidSchema = z.uuid();

export function createApp(dependencies: AppDependencies = { messages: unavailableMessageReader }) {
  return new Hono()
    .get('/healthz', (context) => context.json(healthResponse()))
    .get('/api/v1/health', (context) => context.json(healthResponse()))
    .get('/api/v1/channels', async (context) =>
      context.json({ items: await dependencies.messages.listChannels() }),
    )
    .get('/api/v1/messages', async (context) => {
      const parsedChannelId = uuidSchema.safeParse(context.req.query('channel'));
      if (!parsedChannelId.success) {
        return context.json(
          apiError('invalid_channel', 'channel must be a suite channel UUID'),
          400,
        );
      }

      const messages = await dependencies.messages.listMessages(parsedChannelId.data);
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

      const message = await dependencies.messages.getMessage(parsedMessageId.data);
      if (!message) {
        return context.json(apiError('message_not_found', 'Message was not found'), 404);
      }

      return context.json(message);
    });
}
