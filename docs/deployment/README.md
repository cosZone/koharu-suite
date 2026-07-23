# 部署、升级与回滚

[English](./README.en.md)

本文面向 `v0.1.x` Preview 的单机 Docker Compose 部署。Preview 只支持一个 worker；不要扩容
`worker`，也不要让同一个 Bot 同时运行其他 `getUpdates` consumer。

## 运行边界

同一镜像提供三个入口：

- `migrate`：运行 PostgreSQL migration 后退出；
- `server`：提供 Admin、公开 API、`/healthz` 与 `/readyz`，只接收数据库和 Better Auth 配置；
- `worker`：采集 Telegram、处理任务并写 heartbeat，只接收数据库和 Telegram 配置。

Compose 固定使用 PostgreSQL 18。server 和 worker 的优雅停机 deadline 为 25 秒，Compose
保留 30 秒 grace period。

部署镜像版本始终以 `@koharu-suite/server` 的版本为准。任何会改变镜像内容的 server、Admin 或
内部 UI 变更，都必须在发版前包含 server changeset；Admin/UI 仍按 independent SemVer 添加各自
changeset，同时为 server 添加一个记录镜像变化的 patch changeset。发布 workflow 遇到已由旧
commit 占用的同版本 tag 会直接失败，不会移动 tag 或复用版本。

## 首次部署

需要 Docker Engine、Docker Compose v2，以及一台可以访问 PostgreSQL、Telegram Bot API 和镜像
仓库的主机。先创建部署目录，保存仓库的 `compose.yaml`，然后创建不会进入版本控制的 `.env`：

```dotenv
KOHARU_IMAGE=ghcr.io/coszone/koharu-suite:0.1.0
KOHARU_VERSION=0.1.0
KOHARU_REVISION=<release-commit-sha>
KOHARU_HTTP_PORT=3000
POSTGRES_PUBLISHED_PORT=5432

POSTGRES_DB=koharu
POSTGRES_USER=koharu
POSTGRES_PASSWORD=<unique-high-entropy-password>

BETTER_AUTH_URL=https://blog-admin.example.com
BETTER_AUTH_SECRET=<at-least-32-high-entropy-characters>

TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_WORKER_CONCURRENCY=4
```

不要把 `.env`、备份、Bot token 或密码提交到 Git。生产环境的 `BETTER_AUTH_URL` 必须是 Admin/API
对外暴露的 canonical HTTPS origin。Compose 默认把 `POSTGRES_PUBLISHED_PORT` 只绑定到主机
`127.0.0.1`，供本地维护；数据库不需要从主机访问时，仍建议在部署专用 Compose override 中移除
该端口。

拉取镜像、启动数据库并运行 migration：

```bash
docker compose pull
docker compose up -d db
docker compose run --rm migrate
```

配置第一个公开频道和唯一 owner：

```bash
docker compose run --rm --no-deps worker \
  node dist/cli.js channel add --telegram-id=-1001234567890
docker compose run --rm --no-deps server \
  node dist/cli.js owner create --email you@example.com
```

owner 命令会在交互式 TTY 中隐藏并确认密码。启动两个长期运行的角色：

```bash
docker compose up -d server worker
docker compose ps
curl --fail https://blog-admin.example.com/healthz
curl --fail https://blog-admin.example.com/readyz
docker compose exec worker node dist/cli.js health worker
```

`/healthz` 只证明 HTTP 进程存活；`/readyz` 还会探测 PostgreSQL。worker heartbeat 每 10 秒刷新，
超过 30 秒视为 stale。反向代理只应把流量转到 server 的 3000 端口。

## 本地可重复 smoke

仓库内的 smoke 使用合成消息和本地 Telegram fixture，不需要真实 secret：

```bash
./scripts/compose-smoke/run.sh
```

它会构建一次镜像，并验证 migration 顺序、server readiness、worker heartbeat、第二 worker 拒绝
启动、消息可由公开 API 读取、角色 secret 隔离、SIGTERM 停机与 advisory lock 释放。失败时会打印
Compose 日志，最后删除独立 project 和 volume。smoke 的临时 PostgreSQL 端口同样只绑定
`127.0.0.1`。`KOHARU_TEST_TELEGRAM_API_ROOT` 与
`KOHARU_ENABLE_TEST_TELEGRAM_API_ROOT` 只用于这个显式测试路径，生产环境禁止配置。

## 备份

每次升级前生成可验证的 PostgreSQL 备份，并把它复制到部署主机之外：

```bash
mkdir -p backups
docker compose exec -T db \
  sh -c 'pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom' \
  > "backups/koharu-before-upgrade.dump"
pg_restore --list "backups/koharu-before-upgrade.dump" >/dev/null
```

同时记录当前镜像 digest、版本、commit 和 `docker compose config` 的脱敏副本。不要把展开后的
secret 写进 Issue、PR 或日志。

## 导入 Telegram Desktop 历史

导入前先完成数据库备份，并确认目标公开频道已经由 `kodama channel add` 加入 allowlist。把
Telegram Desktop JSON export 只读挂载到一次性 server 容器；不要把整个个人导出目录复制进镜像：

```bash
# 默认 dry-run，不写数据库
docker compose run --rm --no-deps \
  -v /host/export/result.json:/imports/result.json:ro \
  server node dist/cli.js import telegram-desktop \
  --input /imports/result.json \
  --channel=-1001234567890

# 审阅报告后显式 apply
docker compose run --rm --no-deps \
  -v /host/export/result.json:/imports/result.json:ro \
  server node dist/cli.js import telegram-desktop \
  --input /imports/result.json \
  --channel=-1001234567890 \
  --apply --json
```

`--channel` 可重复，但每个目标都必须在 export 中恰好匹配一个 `public_channel`，且已存在于
allowlist。disabled channel 可由这个显式命令导入；导入不会改变 enabled 状态、Bot binding、
cursor、inbox 或 worker heartbeat。

apply 使用独立 advisory lock 与有限批次。进程或数据库中断时，已经提交的批次会保留；修复原因后
用相同文件重跑，source provenance 会把已经处理的 snapshot 收敛为 replay/matched。退出码 `0`
表示 clean/replay，`2` 表示有 conflict 或单条错误，`1` 表示 fatal/interrupted。只有时间明确更新
的 Desktop snapshot 会切换 current；stale/ambiguous 内容不覆盖。导入不会读取媒体文件或推断
删除。

持久化 report 与 owner-only source evidence 不包含未选择 chat、account contacts/sessions 或本机
绝对路径。仍应把原始 export 当作敏感备份保管；不要上传到 Issue、PR、CI artifact 或公共对象存储。

## 升级

Preview 允许短维护窗口。先阅读 GitHub pre-release notes，确认 migration 和最低 Node/PostgreSQL
要求，再执行：

```bash
docker compose stop -t 30 worker server
docker compose pull
docker compose run --rm migrate
docker compose up -d worker
docker compose exec worker node dist/cli.js health worker
docker compose up -d server
curl --fail https://blog-admin.example.com/readyz
```

再检查 Owner Desk、频道列表和一条新消息。只使用明确版本或 digest；`koharu-suite` 不发布
`latest`。升级期间不要同时启动旧 worker 和新 worker。

## 回滚

1. 停止新 server 与 worker：`docker compose stop -t 30 worker server`。
2. 把 `KOHARU_IMAGE` 恢复为升级前记录的 tag 或 digest。
3. 启动旧 worker，确认 `kodama health worker` 成功且只有一个 lock owner。
4. 启动旧 server，检查 `/readyz`、公开 API 与 Owner Desk。

heartbeat migration 是向前兼容的，普通应用回滚不执行 destructive down migration。如果 release
notes 标注新旧 schema 不兼容，停止全部应用容器后恢复升级前备份：

```bash
docker compose stop worker server
docker compose exec -T db sh -c 'dropdb --username "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'createdb --username "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c \
  'pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --clean --if-exists' \
  < "backups/koharu-before-upgrade.dump"
```

数据库恢复会丢弃备份之后的归档变化，必须作为最后手段。

## Preview 发布与仓库一次性设置

`Publish Preview` workflow 只允许手动运行。它重新执行 lint、typecheck、单元测试、PostgreSQL 18
集成测试、workspace/Storybook build 和 Compose smoke，再创建并锚定 `vX.Y.Z` GitHub pre-release；
若启用 GHCR，容器发布只会在源码 pre-release/tag 成功创建之后开始。

默认不发布容器。若 owner 已明确接受首次 GHCR public 的不可逆性：

1. 在仓库 Actions variables 中设置 `GHCR_PUBLIC_APPROVED=true`；
2. 手动运行 workflow，并同时选择 `publish_ghcr` 与 `confirm_public_visibility`；
3. 首次 push 后，在 GitHub package settings 中把 package 手动设为 public；
4. 核对 `X.Y.Z`、`X.Y`、`preview`、`sha-*` 四类 tag；不应出现 `latest`。

`X.Y.Z` 与 `sha-*` 是 immutable tag。workflow 会读取两者的远端 digest：都不存在时先推送
`X.Y.Z`，再从它的 digest 创建 `sha-*` alias；部分发布只缺一个 tag 时，会在核对现有镜像的
version/revision OCI labels 后补齐缺失 alias；两者存在且 digest 相同则安全跳过。digest 不同、
provenance 不匹配，或 registry/auth/network 无法明确判断时都会 fail closed，绝不覆盖。
`X.Y` 与 `preview` 是明确允许随新 Preview 移动的浮动 tag，并始终指向该 canonical digest。

GitHub package 一旦改为 public 就不能恢复为 private。未完成 owner 确认时，保持两个输入关闭，
只创建源码 pre-release。若之后才确认公开，从 workflow 的 ref 选择器选中同一个 `vX.Y.Z` tag
重新运行并开启两个 GHCR 输入；workflow 只允许 tag 精确指向当前 commit 且现有 release 仍为
pre-release，不会重新创建或移动 release tag。若前一次 GHCR push 中途失败，再从同一个 release
tag 续跑；workflow 会验证相同 digest 并补齐缺失 immutable alias，不会覆盖不同内容。

Changesets 只维护 private workspace package 的独立版本，不发布 npm。推荐为 Version Packages
创建只安装到本仓库的 GitHub App，只授予 Contents 与 Pull requests read/write；把 App ID
保存为 Actions variable `CHANGESETS_APP_ID`，把 private key 保存为 secret
`CHANGESETS_APP_PRIVATE_KEY`，最后设置 variable `CHANGESETS_APP_CONFIGURED=true`。workflow 只在
创建 token 的单个 step 读取 private key，并生成短期、仅当前仓库且仅这两项权限的 installation
token；checkout、依赖安装和 Changesets step 都不会接收 private key。App 创建或更新的 PR 会正常
触发 CI。

备选方案是把仅限本仓库、Contents/Pull requests read/write 的 fine-grained PAT 保存为
`CHANGESETS_GITHUB_TOKEN`。两者都没有配置时，workflow 回退到内置 `GITHUB_TOKEN`，此时必须在
Actions settings 中允许 GitHub Actions 创建 Pull Request；GitHub 会为该 token 创建/更新 PR
产生需要 maintainer 点击 “Approve workflows to run” 的 CI。也可以从 Actions 手动运行 `CI`
workflow，并在 ref 选择器中选择 `changeset-release/main`。合并 Version Packages PR 前必须确认
`CI / Validate` 成功。

安装并授权 Renovate GitHub App 后，Renovate 每周提交 minor/patch 分组更新；major 需要
dependency dashboard 批准，patch 只有在 Renovate 观察到完整 CI 通过后才自动合并。仍应把
`CI / Validate` 设为 `main` 的 required status check，避免仓库保护设置漂移时弱化门槛。
