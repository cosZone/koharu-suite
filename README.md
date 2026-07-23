# koharu-suite

[English](./README.en.md)

`koharu-suite` 是 [astro-koharu](https://github.com/cosZone/astro-koharu) 的可选伴生后台，计划提供
Telegram 多频道归档、动态内容、统一管理与静态发布能力。

核心原则：

- 默认保持 astro-koharu 的纯静态构建与部署体验；
- 需要时再连接独立的 suite 后端；
- 内容与媒体可导出、可恢复，移除后端不影响既有静态站点；
- 以 PostgreSQL 18、Astro 6 Live Content Collections 和开放 JSON API 为基础。

当前正在实现 [G1.2 #4](https://github.com/cosZone/koharu-suite/issues/4) 的首条频道消息闭环：

- `apps/server`：Hono API、Telegram 顺序 long polling、Drizzle repository 与 `kodama` CLI；
- `apps/admin`：React + Vite 管理端壳；
- PostgreSQL 18、Testcontainers、Docker Compose 与 CI 基础。

完整路线图见 [Roadmap #1](https://github.com/cosZone/koharu-suite/issues/1)。

### 本地开发

需要 Node.js 22.20+、pnpm 10.28.2 与 Docker。

先通过 [@BotFather](https://t.me/BotFather) 创建 Bot，把它设为一个公开频道的管理员，并把
`.env` 中的占位值替换为真实 Bot token 和该频道的负数 Telegram channel ID。`.env` 已被 Git
忽略；不要把真实 token 写进提交、Issue、PR 或日志。

```bash
corepack enable
pnpm install
cp .env.example .env
# 编辑 .env 中的 TELEGRAM_BOT_TOKEN 与 TELEGRAM_CHANNEL_ID
docker compose up -d db
pnpm build
pnpm exec kodama migrate
pnpm dev
```

- Server：<http://localhost:3000>
- Admin：<http://localhost:5173>
- Health：<http://localhost:3000/api/v1/health>

`pnpm dev` 会同时启动 Server 与 Admin；Vite 会把 `/api` 代理到本地 Server。

在配置频道发布消息后，可以先发现 suite channel ID，再读取消息：

```bash
curl http://localhost:3000/api/v1/channels
curl "http://localhost:3000/api/v1/messages?channel=<suiteChannelId>"
curl http://localhost:3000/api/v1/messages/<suiteMessageId>
```

公开 API 使用稳定的 suite ID。M1 只归档 Telegram 媒体元数据，不下载文件；公开响应也不会包含
原始 update、Telegram 数字 ID、内部 file ID 或 Bot token。

### Docker

```bash
docker compose up -d db
docker compose build server
docker compose run --rm server node dist/cli.js migrate
docker compose up -d server
```

Compose 启动 PostgreSQL 18 与 Server。先执行 migration，再启动采集进程。Admin 的生产托管不属于
G1.2 范围。

### 常用命令

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm exec kodama --help
```

## License

[AGPL-3.0](./LICENSE)
