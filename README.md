# koharu-suite

[English](./README.en.md)

`koharu-suite` 是 [astro-koharu](https://github.com/cosZone/astro-koharu) 的可选伴生后台，计划提供
Telegram 多频道归档、动态内容、统一管理与静态发布能力。

核心原则：

- 默认保持 astro-koharu 的纯静态构建与部署体验；
- 需要时再连接独立的 suite 后端；
- 内容与媒体可导出、可恢复，移除后端不影响既有静态站点；
- 以 PostgreSQL 18、Astro 6 Live Content Collections 和开放 JSON API 为基础。

当前 [G1.5 #10](https://github.com/cosZone/koharu-suite/issues/10) 在可靠的多频道采集之上补齐了基础
运维能力：

- `apps/server`：Hono API、scoped service token、blocked task 恢复、频道启停、版本化 HTML renderer、
  cursor 分页、公开 API 防护与 `kodama doctor`；
- `apps/admin`：React + Vite Owner Desk，支持登录、归档状态、消息浏览、blocked retry/skip、频道启停、
  rerender、按需 raw reveal 与 TOTP；
- PostgreSQL 18、Testcontainers、Docker Compose 与 CI。

完整路线图见 [Roadmap #1](https://github.com/cosZone/koharu-suite/issues/1)。
生产部署、升级、备份和回滚流程见[部署手册](./docs/deployment/README.md)。

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
pnpm exec kodama channel add --telegram-id=-1001234567890
pnpm exec kodama owner create --email you@example.com
```

然后分别在两个终端运行：

```bash
# 终端 1：HTTP server 与 Admin（不会读取 Bot token，也不会采集）
pnpm dev

# 终端 2：唯一 Telegram collector/task worker
pnpm dev:worker
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

### Service token

浏览器只使用 owner session，不保存共享 token。CLI/CI 可以创建可撤销、最小权限的 service token：

```bash
pnpm exec kodama token create --name deploy --scope admin:read --expires-in 30d
pnpm exec kodama token create --name renderer --scope content:write
pnpm exec kodama token list
pnpm exec kodama token revoke --id <api-key-id>
```

`--scope` 可以重复，允许值为 `admin:read`、`ingestion:write` 和 `content:write`；create 至少需要一个
scope，`--expires-in` 接受 `1d`–`3650d` 的整天数。明文 key 只在 create 时输出一次，数据库只保存
hash，list 不会输出 key 或 hash。调用管理 API 时使用 `Authorization: Bearer <key>`；无效 Bearer
不会回退到浏览器 cookie。

## Telegram 与公开 API

Telegram update 是 Bot 级全局流。只运行一个 suite poller，并让同一个 Bot 管理所有目标公开频道；
不要再为该 Bot 运行其他 `getUpdates` consumer。数据库 allowlist 默认拒绝未知频道，未知频道的
raw payload 不会落库：

```bash
pnpm exec kodama channel add --telegram-id=-1001234567890
pnpm exec kodama channel list
pnpm exec kodama channel disable --telegram-id=-1001234567890
pnpm exec kodama channel enable --telegram-id=-1001234567890
```

第一次 `channel add`（或启动 `worker`）会把数据库绑定到该 Bot 的 numeric ID；之后只能继续使用同一个
Bot，换 token 前必须先按迁移流程处理现有 cursor 与 inbox。

poller 会在同一 PostgreSQL transaction 中保存允许的 update 与下一 cursor。默认 4 个 worker
跨频道并行，但同频道严格按 update ID 处理。每个 `edited_channel_post` 都生成不可变 revision；
即使首次看见的就是编辑，也会从 revision 1 开始。单条失败指数重试 10 次后只阻塞对应频道，初版
不会自动跳过。Owner Desk 可以带理由 retry 或显式 skip，动作会进入审计；raw/error evidence 会
保留。频道 disable 只停止未来采集，不删除既有归档。Bot 级 offset 仍会推进，因此停用期间的
update 在重新启用后不会补回。

Telegram 只保留尚未取得的 update 最多约 24 小时；服务离线超过上游 retention 时，Bot API 无法
补回已经删除的 update。

发布消息后，先发现 suite channel ID，再读取消息：

```bash
curl http://localhost:3000/api/v1/channels
curl "http://localhost:3000/api/v1/messages?channel=<suiteChannelId>&limit=50"
curl "http://localhost:3000/api/v1/messages?channel=<suiteChannelId>&limit=50&cursor=<nextCursor>"
curl http://localhost:3000/api/v1/messages/<suiteMessageId>
```

消息列表返回 `{ items, nextCursor }`；`limit` 默认为 50，范围 1–100，`cursor` 是与频道绑定的
opaque 值，不应由客户端解析或修改。归档 revision 会保存 escaped text/entities 生成的安全 HTML；
renderer 升级后可在 Owner Desk 运行 “Rerender outdated”，只更新派生 HTML/version，不改 revision
历史。

公开 API 使用稳定的 suite ID。M1 只归档 Telegram 媒体元数据，不下载文件。公开响应不会包含原始
update、Telegram 数字 ID、内部 file ID 或 Bot token。原始 update 只由 owner/session 或具有
`admin:read` 的 service token 显式读取，响应为 `private, no-store`。

跨域读取默认关闭。需要独立前端时，把精确的 canonical origins 以逗号分隔写入
`PUBLIC_CORS_ORIGINS`；不支持 `*` 或 credentialed CORS。公开 API 默认每个客户端每 60 秒 120 次，
可用 `PUBLIC_RATE_LIMIT_MAX` 与 `PUBLIC_RATE_LIMIT_WINDOW_SECONDS` 调整。这是单进程内的基础
fixed-window 限流，重启会清空、多副本不共享。`TRUST_PROXY` 默认 `false`；只有 server 仅可经可信
反向代理访问时才能设为 `true` 并信任第一个 `X-Forwarded-For`。

## 运维诊断

部署后可运行只读诊断：

```bash
pnpm exec kodama doctor
```

它检查配置、PostgreSQL 18 与 schema、singleton owner、Bot identity 和已启用频道的公开/管理员
状态；不会调用 `getUpdates`、修改 cursor 或输出数据库密码、Bot token、auth secret、raw update
与 API key。关键检查失败时退出码为 1。该命令会调用 Telegram `getMe/getChat/getChatMember`，测试
和 CI 应使用 fixture/安全环境，不要对未授权的真实频道运行。

## Docker

生产环境的 `BETTER_AUTH_URL` 必须是 Admin/API 的 canonical HTTPS origin，并使用唯一的高熵
`BETTER_AUTH_SECRET`。

```bash
docker compose up -d db
docker compose build migrate
docker compose run --rm migrate
docker compose run --rm --no-deps worker \
  node dist/cli.js channel add --telegram-id=-1001234567890
docker compose run --rm --no-deps server \
  node dist/cli.js owner create --email you@example.com
docker compose up -d server worker
```

Compose 使用 PostgreSQL 18；数据库端口默认只绑定主机的 `127.0.0.1`。`migrate`、`server` 与
`worker` 使用同一个镜像，以命令区分职责；先迁移、配置频道并创建 owner，再启动 server 和唯一
worker。生产 Admin 位于 `http://localhost:3000/admin/`（或你配置的 HTTPS origin 下的
`/admin/`）。完整流程见[部署手册](./docs/deployment/README.md)。

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
