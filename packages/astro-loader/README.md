# `@koharu/astro-loader`

`@koharu/astro-loader` 是 [koharu-suite](https://github.com/cosZone/koharu-suite) 面向 Astro 6 的
Live Content loader 包，提供：

- 经过 Zod 校验的公开只读 client；
- 频道与消息的 Astro 6 Live Loaders；
- 统一、可判别且不会泄露响应正文的错误；
- RSS 与媒体 URL 构造工具。

它不会读取环境变量、自动请求后端、注册 collection 或安装部署 adapter。只要站点不导入并配置
Live Collection，现有纯静态博客仍然照常构建。

## 安装

```bash
pnpm add @koharu/astro-loader
```

需要 Astro `^6.0.0`、Node.js `>=22.20.0`。Live Collection 在请求时运行，因此消费站点还需要自行配置
支持 on-demand rendering 的 Astro adapter。

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

`nextCursor` 是不透明字符串，必须原样传回 client，不能解析或修改。client 默认使用 5 秒超时与
`cache: 'no-store'`；也可以为每次调用传入 `AbortSignal`。

媒体 URL 可能是相对 suite origin 的路径，应使用：

```ts
client.resolveUrl(page.items[0].media[0]?.thumbnailUrl);
client.urls.globalRss();
client.urls.channelRss(channels.items[0].id);
```

## Astro 6 Live Collections

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

页面通过 `getLiveCollection()` 和 `getLiveEntry()` 在运行时读取数据。消息 loader 只加载一页；
Astro 6 的 Live Collection result 无法携带 suite 的 `nextCursor`，需要分页或搜索时请直接调用 typed
client。

安全 HTML 会映射到 entry 的 `rendered.html`，页面可以用 Astro 的 `set:html` 输出。loader 不把
HTML 当作 Markdown/MDX 再执行，也不提供无法从公开 API 证明的 `lastModified`。

```astro
<Fragment set:html={entry.rendered?.html ?? ''} />
```

## 错误处理

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

`kind` 为 `aborted`、`timeout`、`network`、`http` 或 `invalid_response`。错误不会附带完整 response
body、用户内容或 URL credentials。

完整英文说明见 [README.en.md](./README.en.md)。
