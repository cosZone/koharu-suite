# koharu-suite

[English](./README.en.md)

`koharu-suite` 是 [astro-koharu](https://github.com/cosZone/astro-koharu) 的可选伴生后台，计划提供
Telegram 多频道归档、动态内容、统一管理与静态发布能力。

核心原则：

- 默认保持 astro-koharu 的纯静态构建与部署体验；
- 需要时再连接独立的 suite 后端；
- 内容与媒体可导出、可恢复，移除后端不影响既有静态站点；
- 以 PostgreSQL 18、Astro 6 Live Content Collections 和开放 JSON API 为基础。

当前 [G1.4 #8](https://github.com/cosZone/koharu-suite/issues/8) 在第一个 owner 操作面上补齐了可靠的
多频道采集：

- `apps/server`：Hono API、durable Telegram inbox/cursor、按频道顺序 worker、Drizzle
  repository、Better Auth 与 `kodama` CLI；
- `apps/admin`：React + Vite Owner Desk，支持登录、归档状态、消息浏览、按需 raw reveal 与 TOTP；
- PostgreSQL 18、Testcontainers、Docker Compose 与 CI。

完整路线图见 [Roadmap #1](https://github.com/cosZone/koharu-suite/issues/1)。

## 本地开发

需要 Node.js 22.20+、pnpm 10.28.2 与 Docker。

先通过 [@BotFather](https://t.me/BotFather) 创建 Bot，把它设为所有目标公开频道的管理员，再复制并编辑
本地环境文件：

```bash
corepack enable
pnpm install
cp .env.example .env
openssl rand -base64 32
```

- 把生成值放入 `BETTER_AUTH_SECRET`，不要复用示例值；
- 本地开发的 `BETTER_AUTH_URL` 保持 `http://localhost:3000`；
- 填入真实 `TELEGRAM_BOT_TOKEN`；`TELEGRAM_CHANNEL_ID` 仅用于旧版的一次性兼容导入；
- `.env` 已被 Git 忽略；不要把 token、auth secret、密码、cookie 或 recovery code 写进提交、
  Issue、PR 或日志。

初始化数据库和唯一 owner：

```bash
docker compose up -d db
pnpm build
pnpm exec kodama migrate
pnpm exec kodama channel add --telegram-id -1001234567890
pnpm exec kodama owner create --email you@example.com
pnpm dev
```

CLI 会在 TTY 中隐藏密码并要求二次确认。自动化场景必须显式使用 `--password-stdin`，从标准输入读取
一行；密码不会接受 argv 参数。重置密码：

```bash
pnpm exec kodama owner reset-password --email you@example.com
```

- Server：<http://localhost:3000>
- 开发 Admin：<http://localhost:5173/admin/>
- Health：<http://localhost:3000/api/v1/health>

Vite 只在开发时代理 `/api`，并把 Origin 改写为 canonical server origin；生产 Admin 与 API 同源
托管在 `/admin/`。

登录后可以启用 TOTP。设置页只显示一次 recovery codes，请保存到密码管理器；每枚只能使用一次。
TOTP challenge 可显式信任当前设备 30 天，默认不勾选。它只跳过第二因子，不能绕过密码。密码或
TOTP 状态变化后，全部数据库 session 都会撤销。登录固定使用 7 天滑动 session，不提供
“记住我”开关。

## Telegram 与公开 API

Telegram update 是 Bot 级全局流。只运行一个 suite poller，并让同一个 Bot 管理所有目标公开频道；
不要再为该 Bot 运行其他 `getUpdates` consumer。数据库 allowlist 默认拒绝未知频道，未知频道的
raw payload 不会落库：

```bash
pnpm exec kodama channel add --telegram-id -1001234567890
pnpm exec kodama channel list
```

poller 会在同一 PostgreSQL transaction 中保存允许的 update 与下一 cursor。默认 4 个 worker
跨频道并行，但同频道严格按 update ID 处理。每个 `edited_channel_post` 都生成不可变 revision；
即使首次看见的就是编辑，也会从 revision 1 开始。单条失败指数重试 10 次后只阻塞对应频道，初版
不会自动跳过；owner retry/skip 会在后续 Goal 提供。

Telegram 只保留尚未取得的 update 最多约 24 小时；服务离线超过上游 retention 时，Bot API 无法
补回已经删除的 update。

发布消息后，先发现 suite channel ID，再读取消息：

```bash
curl http://localhost:3000/api/v1/channels
curl "http://localhost:3000/api/v1/messages?channel=<suiteChannelId>"
curl http://localhost:3000/api/v1/messages/<suiteMessageId>
```

公开 API 使用稳定的 suite ID。M1 只归档 Telegram 媒体元数据，不下载文件。公开响应不会包含
原始 update、Telegram 数字 ID、内部 file ID 或 Bot token。原始 update 只由 owner 在 Admin
主动点击后通过独立的 `private, no-store` endpoint 获取。

## Docker

生产环境的 `BETTER_AUTH_URL` 必须是 Admin/API 的 canonical HTTPS origin，并使用唯一的高熵
`BETTER_AUTH_SECRET`。

```bash
docker compose up -d db
docker compose build server
docker compose run --rm server node dist/cli.js migrate
docker compose run --rm server node dist/cli.js channel add --telegram-id -1001234567890
docker compose run --rm server node dist/cli.js owner create --email you@example.com
docker compose up -d server
```

Compose 使用 PostgreSQL 18。先迁移、配置频道并创建 owner，再启动 collector。生产 Admin 位于
`http://localhost:3000/admin/`（或你配置的 HTTPS origin 下的 `/admin/`）。

## 常用命令

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
