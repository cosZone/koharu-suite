# 媒体缓存与 S3 运维

[English](./README.en.md)

媒体缓存是可选、可丢弃的加速层，不是文章、revision、媒体 metadata 或来源证据的权威副本。
默认部署仍是本地缓存；不配置 S3 时不会创建 S3 client，也不会读取 S3 credentials。需要更耐久的
缓存副本时，可以增加一个 S3-compatible tier：本地是优先读取、可驱逐的 hot tier，S3 是较耐久的
cached tier。

公开 URL 始终由 suite server 代理，不会重定向到 bucket。没有健康缓存位置时，媒体 route 会
fail closed，消息本身仍正常返回，调用方应使用 `sourceUrl` 引导读者查看 Telegram 原消息。

## 范围、容量与身份

- 缓存 `photo`、`animation`、`video` original；
- photo 最多 10 MiB，animation/video 最多 20 MiB；
- 同一篇消息所有 eligible originals 合计最多 50 MiB；
- 本地 original、thumbnail 与临时文件共用最多 5 GiB 的应用账本；
- `S3_MAX_BYTES` 默认 5 GiB，允许调高但不得超过 5 TiB；
- photo 与受支持的 animation 第一帧生成静态 WebP thumbnail；视频不抽帧；
- audio、voice 与普通 document 不进入缓存；
- 相同 bytes 使用 SHA-256 content address 跨消息、频道和来源复用。

上游声明大小只用于提前拒绝。worker 仍会在流式写入时执行 hard limit、计算 SHA-256、检查
magic-number MIME，并在发布前验证完整对象。`sha256 + byteLength + detectedMime` 才是跨后端
身份；S3 ETag 只是 transport metadata。

## 启用本地缓存

默认 `MEDIA_CACHE_ENABLED=false`。Compose 已创建同一个 `media-cache-data` named volume：
worker 以 read-write 挂载，server 以 read-only 挂载。两者必须使用完全相同的
`MEDIA_CACHE_ROOT`，但只有 worker 可以写入。

```dotenv
MEDIA_CACHE_ENABLED=true
MEDIA_CACHE_ROOT=/var/lib/koharu/media-cache
MEDIA_CACHE_MAX_BYTES=5368709120
MEDIA_CACHE_DOWNLOAD_CONCURRENCY=2
```

`MEDIA_CACHE_MAX_BYTES` 可以调低，不得高于 5 GiB；下载并发范围为 1–4。镜像会为新 volume
预置 `.tmp/` 与 `blobs/`。server 只校验目录类型、`realpath` 和 containment，不会在只读挂载中
创建目录。非 Compose 部署必须预先创建完整布局，并让 worker UID 可读写、server UID 只读。

以上 `MEDIA_CACHE_*` 变量也可以在管理面板设置页的「媒体缓存」分区修改：面板写入数据库
override，重启 server 与 worker 后才生效。优先级为显式 shell 环境变量 > 面板 override >
`.env`；显式设置的环境变量会锁定对应面板字段（「由环境变量锁定」），override 不生效。

启用或修改 root 后，同时重启 server 与唯一 worker：

```bash
docker compose up -d server worker
docker compose logs --tail=100 worker
docker compose exec server node dist/cli.js media status
```

不要把 root 暴露为静态目录，也不要放在 Web root、共享个人目录或 Telegram Desktop export 中。

## 启用 S3-compatible tier

S3 依赖已启用的本地媒体缓存。以下四项是 all-or-none 的 core settings；全部留空就是 local-only，
只填写一部分会让配置 fail closed：

```dotenv
MEDIA_CACHE_ENABLED=true

S3_ENDPOINT=https://s3.example.com
S3_BUCKET=koharu-media
S3_KEY=<access-key-id>
S3_SECRET=<secret-access-key>
S3_REGION=us-east-1
S3_PREFIX=koharu/media-cache
S3_FORCE_PATH_STYLE=true
S3_ALLOW_INSECURE=false
S3_MAX_BYTES=5368709120
S3_CONNECT_TIMEOUT_MS=5000
S3_REQUEST_TIMEOUT_MS=30000
```

- `S3_ENDPOINT` 必须是无用户名、密码、query、fragment 和 path 的 canonical HTTP(S) origin；
- 明文 HTTP 只适用于受控的私有 MinIO，并且必须显式设置 `S3_ALLOW_INSECURE=true`；
- `S3_BUCKET` 是单一 bucket name，`S3_PREFIX` 是安全的相对 object-key prefix；
- path-style 是否需要由 provider 决定；MinIO 常用 `true`；
- connect timeout 范围为 250–30,000 ms，request/body deadline 范围为 1,000–120,000 ms；
- `S3_MAX_BYTES` 是应用容量账本，不是 provider quota，也不会阻止 bucket 中的其他对象增长。

`S3_*` 变量同样可在设置页的「S3 存储」分区配置，优先级与锁定规则同上。

server 与 worker 必须获得同一套配置；Compose 已将这些变量传给两者。bucket、endpoint、region、
prefix 与 path-style 共同确定存储 namespace。已有 location 时不要原地改成另一 namespace；应配置
新的部署、复制并验证所需数据后再切换。access key 和 secret 不属于 namespace，可以在 provider
创建新 credential 后协调更新 server/worker 并重启，再撤销旧 credential。

实现使用 `@aws-sdk/client-s3`，CI compatibility baseline 只有固定版本的 MinIO，覆盖 create-only
put、head、full/range read 和 delete。配置面可以用于其他 S3-compatible provider，但不能据此声称
所有 provider 都已验证。上线前必须用目标 provider 做本文末尾的 smoke，尤其确认
`If-None-Match: *` 条件创建、range、timeout 与权限；不支持安全条件创建时写入会失败，不会退化为
可能覆盖对象的 HEAD-then-PUT。

## 公开读取、回填与隐私

公开消息只返回 opaque suite media object ID，以及可用时的
`/api/v1/media/<objectId>` URL。server 在 PostgreSQL 中选择身份匹配且状态为 `ready` 的可读位置，
按 read priority 先尝试本地，再尝试 S3。只有在尚未输出任何 bytes 时才会切换到下一个位置；
stream 中途失败不会拼接两个来源。original 支持单一 byte range，thumbnail 只返回完整响应。

成功响应继续使用 opaque ETag 与 `Cache-Control: public, no-cache`。每次复用都必须回源重新检查
current revision、tombstone 和对象状态；无效 range 与媒体错误使用 `private, no-store`。公开 API、
Owner Desk 与命令结果都不会输出：

- Bot token、S3 credentials 或带 token 的临时 URL；
- Telegram `file_id` / `file_path`；
- endpoint、bucket、object key、prefix 或 backend fingerprint；
- Desktop export root、绝对路径、blob SHA-256、临时文件名或 lease token。

通过设置页写入的 `S3_KEY`/`S3_SECRET` 只写不读：保存后永不回显，面板与 API 只显示
「已配置」和末四位。

`recache_on_access` 是默认对象策略：当公开请求成功从 S3 读取且本地没有健康副本时，系统会
best-effort 入队一个有界 local restore；公开请求不会等待回填。`stay_evicted` 会禁止这次自动
回填，只有 owner/local operator 的显式 restore 才能恢复位置。两种策略都不能在没有健康缓存位置时
同步从 Telegram 下载，调用方仍应回退到消息 `sourceUrl`。

## CLI 与 Owner Desk

只读状态与 discovery：

```bash
pnpm exec kodama media status
pnpm exec kodama media status --json
pnpm exec kodama media scan --channel=-1001234567890 --json
```

`status` 会显示脱敏 backend ID、ready bytes 与状态计数。`local` 和 `s3-default` 是当前可用于存储
命令的 backend ID。

copy/restore 是 durable worker command，必须显式 `--apply` 和 1–500 字符原因。copy 只支持
local ↔ S3，可以指定一个 object，也可以让 worker 处理一个有界批次：

```bash
pnpm exec kodama media copy \
  --from local --to s3-default \
  --apply --reason "seed durable cache"

pnpm exec kodama media copy \
  --from s3-default --to local --object <suite-object-uuid> \
  --apply --reason "restore hot copy"

pnpm exec kodama media restore \
  --object <suite-object-uuid> --to local \
  --apply --reason "restore selected object"
```

保护和驱逐策略是同步 PostgreSQL mutation：

```bash
pnpm exec kodama media protect \
  --object <suite-object-uuid> \
  --apply --reason "keep campaign asset cached"
pnpm exec kodama media unprotect \
  --object <suite-object-uuid> \
  --apply --reason "campaign ended"
pnpm exec kodama media policy \
  --object <suite-object-uuid> --policy recache \
  --apply --reason "restore normal hot-tier behavior"
pnpm exec kodama media policy \
  --object <suite-object-uuid> --policy stay \
  --apply --reason "keep this object evicted"
```

保护标记属于 object，但相同 SHA-256 可被多个 object 共享。只要任一当前引用有 active protection，
整个 shared blob 都会被视为 protected，policy prune 和显式 eviction 都会 fail closed，直到保护被
移除或到期。Admin API 支持可选保护到期时间；当前 CLI 创建长期保护。

prune 按 backend 内的 shared-blob LRU 规划。preview 是零 mutation；apply 会基于当前账本重新规划，
不会盲目执行旧 preview：

```bash
pnpm exec kodama media prune \
  --backend local --target-bytes 4294967296
pnpm exec kodama media prune \
  --backend local --target-bytes 4294967296 \
  --apply --reason "reserve local hot-tier space"
```

本地 DB/filesystem 对账仍默认 dry-run：

```bash
pnpm exec kodama media reconcile
pnpm exec kodama media reconcile \
  --apply --reason "local volume restored after host maintenance"
```

Owner Desk 的 Cache panel 提供同一套脱敏 backend/location 状态、对象 copy/restore、
protect/unprotect、policy、批量 copy 和 prune preview/apply。preview 与 apply 的 backend/target
必须一致，apply 前还会要求原因和确认。Owner Desk mutation 只接受 owner session；CLI 记录为
`local_operator`。service token 即使拥有 `content:write` 也不能执行这些磁盘/对象 mutation。

## Crash、lease、对账与审计

- 下载和本地 copy 先写 token-scoped staging，验证后原子发布，再完成 DB settlement；
- S3 create 使用条件写，destination 会再次完整校验后才变为 `ready`；
- copy/restore 保留健康 source；destination 失败不会提前删除或降级 source；
- copy、restore、prune、evict 与 reconcile 使用 bounded lease 和 token fence；
- worker 崩溃后只接管过期 lease，重复运行按 canonical identity 收敛；
- prune 是 claim → backend delete → token-fenced finalize，不会提前扣减账本；
- local reconcile 修复本地 DB/filesystem 漂移；它不是全 provider 扫描器；
- mutation 记录 initiator、reason、动作和脱敏 before/after/result/error，不记录 secret、storage key
  或 provider response body。

不要直接修改 cache/location/backend 表、删除单个 blob、移动 staging 文件或手工调整 ready bytes。
这样会绕过 lease、共享身份、保护聚合和容量账本。

## 成本、credentials 与 provider lifecycle

S3 的 PUT、HEAD、GET、range GET、DELETE、存储和公网 egress 都可能计费。公开请求仍经 suite server
代理，所以从 S3 读取既消耗 provider egress，也消耗 server 带宽；local hot tier 可以降低重复读取
成本，但不是 CDN。先用访问模式估算费用，再调整容量和 prune target。

使用只允许目标 bucket/prefix 所需操作的独立 credential，并在 secret manager 或未跟踪的 `.env`
中保存。日志、Issue、CI artifact 和 `docker compose config` 分享前必须脱敏 endpoint、bucket、
key 与 secret。轮换时先创建并验证新 credential，协调重启 server/worker，再撤销旧 credential；
不要在迁移运行中途撤销唯一可用 credential。

provider lifecycle、自动清理、控制台删除或 bucket replication 状态都不是权威账本。不要配置会在
应用不知情时删除 `S3_PREFIX` 对象的 lifecycle rule。外部删除可能表现为读取失败并回退到下一个
健康位置或 Telegram 原消息；必须由 operator 查明后显式 restore/copy。应用 prune 才是受保护、
有审计、会更新 PostgreSQL location 状态的删除路径。

## 备份与恢复一致性

PostgreSQL 是 canonical archive、provenance、policy、protection 和 location ledger 的权威备份。
本地与 S3 bytes 都是可重建缓存，因此普通备份可以只包含 PostgreSQL。

如果业务要求保留 warm cache，先阻止新 mutation、停止 server/worker，再在同一停机窗口保存：

1. PostgreSQL dump；
2. 完整 `MEDIA_CACHE_ROOT` snapshot；
3. `S3_BUCKET/S3_PREFIX` 的 provider-consistent snapshot/versioned copy；
4. 镜像 digest 和一份脱敏配置记录。

不要把 live blob tree、不同时间的 DB dump 和稍后取得的 bucket listing 拼成“一致备份”。恢复后先
启动 PostgreSQL 与本地布局，运行 local reconcile dry-run，再启用 worker；对重要对象使用
copy/restore 和公开读取验证，不要把 provider listing 当成 PostgreSQL ledger。

## 停用 S3、回到 local-only

1. 停止从 Owner Desk/CLI 发起新 storage mutation；
2. 查看最近命令，等待需要的 copy/restore/prune 完成；崩溃命令让 worker 在 lease 过期后收敛；
3. 将仍需缓存的对象 copy/restore 到 `local`，并检查 `media status` 和公开读取；
4. 停止 server/worker；
5. 同时清空 `S3_ENDPOINT`、`S3_BUCKET`、`S3_KEY`、`S3_SECRET`，不要留下 partial config；
6. 重启 server/worker，确认 `s3-default` 已 disabled 且本地读取正常。

停用 S3 不会删除 bucket 对象，也不会删除 PostgreSQL 中的 additive backend/location/audit rows。
保留它们用于诊断和将来重新启用；不要执行 destructive down migration。只有在另有备份、已确认
不再需要恢复且 local/source fallback 已验证后，才在应用之外单独安排 bucket 清理。

## 手工 smoke

目标 provider 上线或 credential/namespace 变更前，至少完成一次：

1. `media status` 确认 `local` 与 `s3-default` 的脱敏状态和容量；
2. copy 一个已验证的本地 object 到 S3，并从公开 opaque URL 完整读取和 range 读取；
3. 在第二个 copy 运行中中断 worker，重启后确认 lease 过期接管并收敛；
4. restore 一个缺失的 local location，再验证本地优先读取；
5. 保护一个与其他 object 共享 blob 的对象，preview prune，确认 shared blob 不会成为 candidate；
6. unprotect 后重新 preview，再 apply 一个未保护位置的 eviction；
7. 确认 S3 读取成功时 `recache_on_access` 会回填本地，而 `stay_evicted` 不会；
8. 让两个位置都不可用，确认媒体 route fail closed，消息仍包含可用的 Telegram `sourceUrl`；
9. 检查 Owner Desk 最近命令和 audit 只有脱敏状态、计数与 error code。

项目目前没有 S3 provider doctor 命令，也不宣称目标 provider 通过验证；请保存 smoke 时间、版本、
provider 和脱敏结果作为发布证据。

## 故障排查

- local `permission denied`：核对 root owner/mode，以及 worker RW、server RO 挂载；
- S3 配置启动失败：确认四项 core settings 全部填写、endpoint 是 canonical origin，HTTP 已显式允许；
- S3 `403`：检查 clock、credential 和 bucket/prefix 权限，不要在日志粘贴 provider response；
- 连续 `disk_full`：先检查宿主机空间，再 preview local prune；5 GiB 账本不是磁盘配额；
- `missing`/`corrupt`：不要手改 location，保留健康 source 并显式 copy/restore；
- `blocked` 增长：查看脱敏 error class/code，修复权限或上游后由 owner/local operator 重试；
- animation thumbnail 不可用：original 仍可公开；unsupported/corrupt/timeout 不阻塞文章。

日志、Issue 与 CI artifact 中只记录 suite object ID、backend ID、kind、state/reason、bytes 与
duration。不要粘贴 `.env`、Telegram 下载 URL、S3 配置、Desktop export、数据库 dump 或 cache
内容。
