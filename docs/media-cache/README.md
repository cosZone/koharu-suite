# 本地媒体缓存运维

[English](./README.en.md)

本地媒体缓存是可选的、可丢弃的加速层。它不会成为文章、revision、媒体 metadata 或来源证据的
唯一副本；缓存未命中、超限、损坏、被驱逐或整个 volume 被删除时，公开消息仍返回成功，调用方应使用
消息的 `sourceUrl` 引导读者查看 Telegram 原消息。

## 范围与限制

- 缓存 `photo`、`animation`、`video` original；
- photo 最多 10 MiB，animation/video 最多 20 MiB；
- 同一篇消息所有 eligible originals 合计最多 50 MiB；
- original、thumbnail 与临时文件共用最多 5 GiB 的应用账本；
- photo 与受支持的 animation 第一帧生成静态 WebP thumbnail；视频不抽帧；
- audio、voice 与普通 document 不进入本地缓存；
- 相同 bytes 使用 SHA-256 content address 跨消息、频道和来源复用。

上游声明大小只用于提前拒绝。worker 仍会在流式写入时执行 hard limit、计算 SHA-256、检查
magic-number MIME，并在发布前完成 `fsync`。超过限制或内容格式不受支持时不保留文件。

## 启用

默认 `MEDIA_CACHE_ENABLED=false`。Compose 已创建同一个 `media-cache-data` named volume：
worker 以 read-write 挂载，server 以 read-only 挂载。两者必须使用完全相同的
`MEDIA_CACHE_ROOT`，但只有 worker 可以写入。

镜像预置空的 `.tmp/` 与 `blobs/`，因此 Docker 第一次创建 named volume 时会先得到完整目录布局，
再以只读方式挂载给 server。server 启动只执行 `realpath`、目录类型与 containment 校验；不会创建
root 或子目录。启用缓存但布局缺失时，server 会 fail closed，而不是尝试写只读 volume。

```dotenv
MEDIA_CACHE_ENABLED=true
MEDIA_CACHE_ROOT=/var/lib/koharu/media-cache
MEDIA_CACHE_MAX_BYTES=5368709120
MEDIA_CACHE_DOWNLOAD_CONCURRENCY=2
```

`MEDIA_CACHE_MAX_BYTES` 可以调低，不得高于 5 GiB；下载并发范围为 1–4。启用或修改 root 后同时重启
server 与唯一 worker：

```bash
docker compose up -d server worker
docker compose logs --tail=100 worker
docker compose exec server node dist/cli.js media status
```

非 Compose 部署必须在启动 server 之前预先创建 root、`.tmp/` 与 `blobs/`，并让 worker UID
拥有读写权限、server UID 只有读取权限。先准备和校验目录，再启动 server 与 worker；不要依赖
server 创建目录。不要把 root 暴露为静态目录，也不要把它放在 Web root、共享个人目录或
Telegram Desktop export 目录中。

## 公开读取与隐私

公开消息只返回 opaque suite media object ID，以及可用时的
`/api/v1/media/<objectId>` URL。公开 API 和 Owner Desk 都不会输出：

- Bot token 或含 token 的临时下载 URL；
- Telegram `file_id` / `file_path`；
- Desktop export root 或绝对路径；
- blob SHA-256、内部相对 key 或临时文件名。

媒体响应只在 object、blob、current revision 与 non-tombstoned message 同时有效时返回；否则普通
`404`。original 支持单一 byte range，thumbnail 只返回完整响应。成功响应使用 opaque ETag 与
`Cache-Control: public, no-cache`：缓存可以保存 bytes，但每次复用前都必须回源，server 只会在重新
确认 current/non-tombstoned gate 且成功打开文件后返回 `304`。无效 range 和所有媒体错误使用
`private, no-store`。这样 owner tombstone 或新 revision 不会被仍处于 fresh 状态的公共缓存绕过。

## CLI 与 Owner Desk

只读状态：

```bash
pnpm exec kodama media status
pnpm exec kodama media status --json
pnpm exec kodama media scan --channel=-1001234567890 --json
```

不带 `--channel` 的 `media scan` 只推进一次全局 durable discovery batch；即使还有 backlog
也不会在一次 CLI 调用里全部扫完。指定一个或多个已配置的 canonical Telegram channel ID
时，CLI 使用独立的本地 keyset cursor 自动分页，不会读取或推进全局 discovery cursor。自动分页
最多 10,000 页，cursor 不前进时也会停止；输出只包含聚合后的 scanned、plans、objects、
sources 与 `hasMore`，不会暴露 cursor 或任何内部媒体标识。正常完成时 `hasMore` 为 `false`；
若为 `true`，说明命中了安全上限或 cursor 保护，应缩小频道范围或检查 discovery 状态。

容量驱逐和 DB/filesystem 对账默认 dry-run。任何 mutation 都需要显式 `--apply` 与 1–500 字符原因：

```bash
pnpm exec kodama media prune --target-bytes 4294967296
pnpm exec kodama media prune \
  --target-bytes 4294967296 \
  --apply \
  --reason "reserve space before upgrade"

pnpm exec kodama media reconcile
pnpm exec kodama media reconcile \
  --apply \
  --reason "volume restored after host maintenance"
```

Desktop 媒体只允许本机 operator 显式绑定已完成的 import run、同一份 `result.json` 与 export root：

同一帖同时含 Bot 与 Desktop 来源时，exact import run 必须覆盖该帖的全部 active originals，CLI
才会整帖 claim 和 publish；覆盖不完整时会保持等待本地来源，不会发布半帖。

```bash
pnpm exec kodama media cache \
  --import-run <suite-import-run-uuid> \
  --input /path/to/result.json \
  --desktop-root /path/to/export \
  --apply \
  --reason "cache approved Desktop export"
```

命令会重新计算 JSON hash、执行 `realpath` containment，并在 open 前后比较 regular file 的
device/inode identity，拒绝 symlink escape 与父目录换链。命令运行期间 export 必须保持稳定且
只读；不要让同步工具或其他进程改写它，也不要把完整个人 Telegram export 挂载到常驻 worker。

Owner Desk 的 Cache panel 显示 enabled 状态、ready/reserved/max、状态计数、最近脱敏失败和分页
object/post 状态。retry、evict 与 reconcile 只接受 owner session，并要求原因和确认；service token
即使拥有 `content:write` 也不能删除磁盘副本。`admin:read` 只获得脱敏状态。

Owner Desk 中 retry 是纯数据库事务，会同步完成。evict/reconcile 返回 opaque command ID 与
`pending` 状态；server 只向 PostgreSQL 入队，即使媒体卷只读也不会 unlink、fsync 或修复账本。
worker 持有读写卷，以 lease/token fence 执行命令；崩溃后接管过期 lease。reconcile 的所有分页由
同一 worker command 自动完成。Cache panel 的最近命令只显示状态、脱敏计数结果或 error code，
不显示 blob hash、路径、Bot token 或 lease token。cache disabled 时命令 fail closed，不会入队。

## 崩溃恢复与驱逐

- 下载先写入 mode `0600` 的 token-scoped staging 文件；
- 验证后原子发布 content-addressed blob，再以两阶段 DB settlement 公开；
- worker 重启会接管过期 lease：pre-commit staging 回滚，post-commit staging完成 settlement；
- eviction 先 token-fenced 标记 `deleting`，再 unlink + directory sync，最后扣减账本；
- eviction 在 unlink 前失败会恢复 `ready`；unlink 已完成或文件已不存在时按成功收敛；
- LRU 按 coalesced shared-blob access time 与 SHA-256 稳定排序，不删除 canonical archive 或 evidence。

不要直接修改 cache 表、删除单个 blob 或手工移动 staging 文件。这样会绕过 lease、sticky identity 与
5 GiB 账本。使用 `kodama media reconcile` 或 Owner Desk。

## 备份、恢复与删除整个缓存

PostgreSQL 备份是 canonical archive、provenance 与 cache ledger 的权威备份。blob tree 是可重建
副本，普通备份可以不包含它；恢复数据库后运行 reconcile，再让 worker bounded recache。

若业务要求保留 warm cache，必须在停止 server/worker 后同时快照 PostgreSQL 与整个
`MEDIA_CACHE_ROOT`，并保持二者来自同一个停机窗口。不要把正在写入的 blob tree 与不同时间点的
数据库 dump 拼在一起。

删除整个缓存的安全顺序：

1. 停止 server 与 worker；
2. 备份 PostgreSQL；
3. 删除或替换 cache volume；
4. 以 `MEDIA_CACHE_ENABLED=false` 启动 server；
5. 运行 `kodama media reconcile --apply --reason "cache volume replaced"`；
6. 重新启用 cache 并启动 worker，让它从有界队列重新下载；
7. 检查 Owner Desk usage、blocked/retry 计数与一条公开 media fallback。

卷丢失不会让文章消失。对账完成前数据库中的旧 ready row 也不会让 server 从目录猜测内容：文件
open 失败会 fail closed 为 `404`。

## 故障排查

- `permission denied`：核对 root owner/mode，以及 worker RW、server RO 挂载；
- 连续 `disk_full`：先检查宿主机空间，再 dry-run prune；5 GiB 账本不是宿主机磁盘配额；
- `blocked` 增长：查看脱敏 error class/code，修复上游或权限后由 owner retry；
- `missing`：先 reconcile，确认卷是否被替换或外部清理程序删除文件；
- Telegram original 可读但 cache 不下载：核对 Bot 仍是目标公开频道管理员，且文件未超过
  Telegram Bot API 与本产品限制；
- animation thumbnail 不可用：original 仍可公开；unsupported/corrupt/timeout 不阻塞文章。

日志、Issue 与 CI artifact 中只记录 suite object ID、kind、state/reason、bytes 与 duration。不要粘贴
`.env`、Telegram 下载 URL、Desktop export、数据库 dump 或 cache root 内容。
