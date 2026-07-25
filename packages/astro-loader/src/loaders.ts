import type { LiveLoader } from 'astro/loaders';
import { type CreateKoharuClientOptions, createKoharuClient, type KoharuClient } from './client.js';
import { isKoharuError, KoharuError } from './errors.js';
import type { PublicChannel, PublicMessage } from './schemas.js';

export type KoharuLoaderOptions =
  | { client: KoharuClient }
  | (CreateKoharuClientOptions & { client?: never });

export interface KoharuMessageEntryFilter {
  id: string;
}

export interface KoharuChannelEntryFilter {
  id: string;
}

export interface KoharuMessageCollectionFilter {
  channelId: string;
  cursor?: string;
  limit?: number;
}

function loaderClient(options: KoharuLoaderOptions): KoharuClient {
  return 'client' in options && options.client
    ? options.client
    : createKoharuClient(options as CreateKoharuClientOptions);
}

function loaderError(error: unknown): { error: KoharuError } {
  return { error: isKoharuError(error) ? error : KoharuError.invalidResponse() };
}

function messageEntry(message: PublicMessage) {
  return {
    data: message,
    id: message.id,
    ...(message.content.html === null ? {} : { rendered: { html: message.content.html } }),
  };
}

export function koharuChannelsLoader(
  options: KoharuLoaderOptions,
): LiveLoader<PublicChannel, KoharuChannelEntryFilter, never, KoharuError> {
  const client = loaderClient(options);
  return {
    name: '@koharu/astro-loader/channels',
    loadCollection: async () => {
      try {
        const response = await client.channels.list();
        return {
          entries: response.items.map((channel) => ({
            data: channel,
            id: channel.id,
          })),
        };
      } catch (error) {
        return loaderError(error);
      }
    },
    loadEntry: async ({ filter }) => {
      try {
        const response = await client.channels.list();
        const channel = response.items.find((item) => item.id === filter.id);
        return channel ? { data: channel, id: channel.id } : undefined;
      } catch (error) {
        return loaderError(error);
      }
    },
  };
}

export function koharuMessagesLoader(
  options: KoharuLoaderOptions,
): LiveLoader<PublicMessage, KoharuMessageEntryFilter, KoharuMessageCollectionFilter, KoharuError> {
  const client = loaderClient(options);
  return {
    name: '@koharu/astro-loader/messages',
    loadCollection: async ({ filter }) => {
      if (!filter) return loaderError(KoharuError.invalidResponse());
      try {
        const response = await client.messages.list({
          channelId: filter.channelId,
          ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
          ...(filter.limit === undefined ? {} : { limit: filter.limit }),
        });
        return { entries: response.items.map(messageEntry) };
      } catch (error) {
        return loaderError(error);
      }
    },
    loadEntry: async ({ filter }) => {
      try {
        const message = await client.messages.get({ messageId: filter.id });
        return messageEntry(message);
      } catch (error) {
        return loaderError(error);
      }
    },
  };
}
