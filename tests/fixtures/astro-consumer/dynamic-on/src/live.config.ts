import { defineLiveCollection } from 'astro:content';
import {
  koharuChannelsLoader,
  koharuMessagesLoader,
  publicChannelSchema,
  publicMessageSchema,
} from '@coszone/koharu-astro';

const baseUrl = process.env.KOHARU_SUITE_URL;

if (!baseUrl) {
  throw new Error('KOHARU_SUITE_URL is required by the dynamic fixture');
}

export const collections = {
  koharuChannels: defineLiveCollection({
    loader: koharuChannelsLoader({ baseUrl, timeoutMs: 1_000 }),
    schema: publicChannelSchema,
  }),
  koharuMessages: defineLiveCollection({
    loader: koharuMessagesLoader({ baseUrl, timeoutMs: 1_000 }),
    schema: publicMessageSchema,
  }),
};
