# `@koharu/astro-loader`

`@koharu/astro-loader` is the Astro 6 Live Content loader package for
[koharu-suite](https://github.com/cosZone/koharu-suite). It provides:

- a Zod-validated, public read-only client;
- Astro 6 live loaders for channels and messages;
- normalized, discriminated errors that never expose response bodies;
- RSS and media URL helpers.

The package does not read environment variables, contact a backend, register a collection, or install a deployment
adapter at import time. A site that does not configure a live collection keeps its existing static build behavior.

## Install

```bash
pnpm add @koharu/astro-loader
```

Astro `^6.0.0` and Node.js `>=22.20.0` are required. Live collections run at request time, so the consuming site
must configure an Astro adapter that supports on-demand rendering.

## Typed client

```ts
import { createKoharuClient } from '@koharu/astro-loader/client';

const client = createKoharuClient({
  baseUrl: 'https://suite.example.com',
});

const channels = await client.channels.list();
const page = await client.messages.list({
  channelId: channels.items[0].id,
  limit: 20,
});

const result = await client.search.messages({
  query: 'Astro 6',
  channelId: channels.items[0].id,
});
```

`nextCursor` is opaque and must be passed back to the client unchanged. Requests default to a five-second timeout
and `cache: 'no-store'`. Each operation can also receive an `AbortSignal`.

Media URLs can be relative to the suite origin. Resolve them through the client:

```ts
client.resolveUrl(page.items[0].media[0]?.thumbnailUrl);
client.urls.globalRss();
client.urls.channelRss(channels.items[0].id);
```

## Astro 6 live collections

```ts
// src/live.config.ts
import { defineLiveCollection } from 'astro:content';
import {
  koharuChannelsLoader,
  koharuMessagesLoader,
  publicChannelSchema,
  publicMessageSchema,
} from '@koharu/astro-loader';

const baseUrl = process.env.KOHARU_SUITE_URL;
if (!baseUrl) throw new Error('KOHARU_SUITE_URL is required');

export const collections = {
  koharuChannels: defineLiveCollection({
    loader: koharuChannelsLoader({ baseUrl }),
    schema: publicChannelSchema,
  }),
  koharuMessages: defineLiveCollection({
    loader: koharuMessagesLoader({ baseUrl }),
    schema: publicMessageSchema,
  }),
};
```

Pages use `getLiveCollection()` and `getLiveEntry()` to fetch data at request time. The message loader fetches one
page only. Astro 6 live collection results cannot carry koharu-suite's `nextCursor`; use the typed client directly
for pagination and search.

Safe HTML is exposed as `entry.rendered.html` and can be emitted with Astro's `set:html`. The loader does not
reinterpret that HTML as Markdown or MDX, and it does not invent a `lastModified` value that the public API cannot
prove.

```astro
<Fragment set:html={entry.rendered?.html ?? ''} />
```

## Errors

```ts
import { isKoharuError } from '@koharu/astro-loader';

try {
  await client.messages.get({ messageId: '...' });
} catch (error) {
  if (isKoharuError(error)) {
    console.error(error.kind, error.status, error.code);
  }
}
```

`kind` is one of `aborted`, `timeout`, `network`, `http`, or `invalid_response`. Errors never include the full
response body, user content, or URL credentials.

See [README.md](./README.md) for the Chinese documentation.
