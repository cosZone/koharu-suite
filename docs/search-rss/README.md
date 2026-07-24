# 搜索与 RSS 运维手册

[English](./README.en.md)

G2.5 为公开的 current message 投影增加 PostgreSQL 18 `pg_trgm` 搜索，以及全局/频道 RSS 2.0。
两项能力都直接读取现有归档，不建立第二份搜索文档或 feed cache。

## 公开与隐私边界

- 只返回 `messages.current_revision_number` 指向的 current revision；编辑后旧 revision 不再命中。
- tombstoned 消息立即从搜索和 RSS 隐藏；取消隐藏后按当前内容重新出现。
- 不搜索或输出 raw update、历史 revision、Telegram numeric ID、内部 file ID/locator、storage backend
  或 owner-only source evidence。
- 搜索 snippet 是最多 280 个 Unicode code point 的纯文本，不包含 `<mark>` 或动态 HTML。
- RSS `<description>` 来自已保存的安全 HTML，但会作为 XML 文本转义，不会原样注入 XML。
- RSS 不包含 media enclosure。条目链接优先使用公开 Telegram 原消息；没有 `sourceUrl` 时回退到公开
  suite message URL，因此 local/S3 媒体策略不改变 feed 身份。

这些路由是公开 API，沿用 exact-origin CORS 与公开限流。跨域读取默认关闭；需要独立客户端时用
`PUBLIC_CORS_ORIGINS` 列出精确 origin。`PUBLIC_RATE_LIMIT_MAX` 和
`PUBLIC_RATE_LIMIT_WINDOW_SECONDS` 调整单进程 fixed-window 限流；不要使用 `*` 或
credentialed CORS。

## 搜索 API

```http
GET /api/v1/search/messages
  ?q=<text>
  &channel=<suiteChannelId>
  &from=<canonical-UTC>
  &to=<canonical-UTC>
  &sort=relevance|newest
  &limit=20
  &cursor=<opaque>
```

`q` trim 后必须为 1–200 个 Unicode code point。`channel`、`from` 和 `to` 对 3 字符以上查询均可选；
`from` inclusive、`to` exclusive，时间必须是 canonical ISO 8601 UTC，例如
`2026-07-01T00:00:00.000Z`。

3 字符以上查询默认 `sort=relevance`，也可用 `newest`；`limit` 默认为 20，范围 1–50：

```bash
ORIGIN=https://blog-admin.example.com

curl --get "$ORIGIN/api/v1/search/messages" \
  --data-urlencode 'q=Astro 6'

curl --get "$ORIGIN/api/v1/search/messages" \
  --data-urlencode 'q=PostgreSQL' \
  --data-urlencode 'channel=<suiteChannelId>' \
  --data-urlencode 'from=2026-07-01T00:00:00.000Z' \
  --data-urlencode 'to=2026-08-01T00:00:00.000Z' \
  --data-urlencode 'sort=newest' \
  --data-urlencode 'limit=50'
```

返回：

```json
{
  "items": [
    {
      "message": {},
      "match": {
        "score": 0.42,
        "snippet": "…Astro 6…"
      }
    }
  ],
  "mode": "trigram",
  "nextCursor": "<opaque-or-null>"
}
```

`score` 只用于相关性排序，不是跨 PostgreSQL 版本稳定的业务分数；`newest` 和短查询返回 `null`。
`nextCursor` 与规范化后的 query、频道、时间和排序绑定，不要解析或修改。请求下一页时原样重复全部
参数并附加 cursor：

```bash
curl --get "$ORIGIN/api/v1/search/messages" \
  --data-urlencode 'q=Astro 6' \
  --data-urlencode 'cursor=<nextCursor>'
```

`%`、`_` 与 `\` 被视为字面字符，不是 SQL wildcard。搜索只返回包含字面 query 的 current text；
`pg_trgm` 只影响相关性排序，不会引入模糊的非子串结果。

### 1–2 字符查询

短查询无法有效利用 trigram index，必须同时满足：

- 指定恰好一个 `channel`；
- 同时指定 `from` 和 `to`，范围不超过 31 天；
- 使用 `sort=newest`；
- `limit` 为 1–20。

```bash
curl --get "$ORIGIN/api/v1/search/messages" \
  --data-urlencode 'q=星' \
  --data-urlencode 'channel=<suiteChannelId>' \
  --data-urlencode 'from=2026-07-01T00:00:00.000Z' \
  --data-urlencode 'to=2026-08-01T00:00:00.000Z' \
  --data-urlencode 'sort=newest' \
  --data-urlencode 'limit=20'
```

缺少边界、超过 31 天或请求 relevance 时返回
`400 short_query_requires_bounded_scope`。Owner Desk 会提前提示，但 server validation 才是权威。

| code | 含义 |
|---|---|
| `invalid_query` | `q` 缺失、为空或超过 200 个 Unicode 字符 |
| `invalid_channel` | `channel` 不是 suite UUID |
| `channel_not_found` | suite channel 不存在 |
| `invalid_time_range` | 时间非 canonical UTC，或 `from >= to` |
| `invalid_sort` / `invalid_limit` | 排序或页大小不在允许范围 |
| `short_query_requires_bounded_scope` | 短查询缺少受限频道/时间/排序 |
| `invalid_cursor` | cursor 损坏，或与当前参数不匹配 |

## RSS

两条 RSS 2.0 feed 都固定返回最多 50 条公开 current message，按
`publishedAt DESC, messageId DESC` 排序，不分页：

```text
GET|HEAD /api/v1/rss.xml
GET|HEAD /api/v1/channels/:suiteChannelId/rss.xml
```

```bash
curl "$ORIGIN/api/v1/rss.xml"
curl "$ORIGIN/api/v1/channels/<suiteChannelId>/rss.xml"
curl --head "$ORIGIN/api/v1/rss.xml"
```

频道 UUID 格式错误返回 `400 invalid_channel`，不存在返回 `404 channel_not_found`。每个 item 的
`guid` 是稳定 suite message UUID；feed 不承诺超过最近 50 条的历史或分页。

Server 用 `BETTER_AUTH_URL` 的 origin 构造 feed self URL 与 suite fallback URL，不读取请求
`Host`。生产必须配置公开可达的 canonical HTTPS origin：

```dotenv
BETTER_AUTH_URL=https://blog-admin.example.com
```

若反向代理对外使用不同 host/path，应修正该值或代理路由，而不是依赖转发的 `Host`。配置不能包含
credentials、path、query 或 hash；修改后重启 server。

### HTTP cache 与 HEAD

Feed 返回：

- `Content-Type: application/rss+xml; charset=utf-8`
- `Cache-Control: public, no-cache`
- 最终 UTF-8 bytes 的 strong `ETag`
- newest relevant update 的 `Last-Modified`

用 ETag 做 conditional GET：

```bash
ETAG=$(curl --silent --dump-header - --output /dev/null \
  "$ORIGIN/api/v1/rss.xml" |
  awk 'tolower($1) == "etag:" { print $2 }' | tr -d '\r')

curl --include \
  --header "If-None-Match: $ETAG" \
  "$ORIGIN/api/v1/rss.xml"
```

内容未变时返回 `304` 且无 body。`HEAD` 返回与 GET 对应的 content type、原始 body
`Content-Length`、ETag 和 Last-Modified，但无 body。ETag 是 correctness 机制，Last-Modified
仅用于观察和客户端优化。

## 部署、升级与回滚

G2.5 migration 先执行：

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

随后创建 project-owned GIN trigram index 与公开时间排序 index。托管 PostgreSQL 上，deployment
role 可能没有安装 extension 的权限；首次升级前先由数据库管理员预装 `pg_trgm`，或授予 migration
role 所需的受限权限。migration 安装失败会停止，不应跳过后继续启动新镜像。

升级前执行可验证的 PostgreSQL 备份，并记录旧镜像 digest。应用 migration 后运行：

```bash
docker compose run --rm --no-deps server node dist/cli.js doctor
```

`Search` 必须为 `ok`；它会读取 `pg_extension` 和真实 index definition，确认
`message_revisions_text_trgm_idx` 是带 `gin_trgm_ops` 与 `text IS NOT NULL` predicate 的 GIN index。
Doctor 是只读的，不读取或输出 query/正文。

再 smoke：

```bash
curl --get "$ORIGIN/api/v1/search/messages" --data-urlencode 'q=Astro'
curl --head "$ORIGIN/api/v1/rss.xml"
curl --head "$ORIGIN/api/v1/channels/<suiteChannelId>/rss.xml"
```

应用回滚到旧镜像时保留 additive indexes 和 `pg_trgm`。若必须回滚 schema，只删除 G2.5
project-owned indexes；**不要执行 `DROP EXTENSION pg_trgm`**，它可能已被其他数据库对象共享。
搜索/RSS 没有持久派生数据，不需要重建或清空 cache。需要恢复升级前数据库时，遵循部署手册的完整
停机恢复流程。

## 故障排查

### `kodama doctor` 报缺少 `pg_trgm`

确认连接的是目标 PostgreSQL 18 数据库，并检查 migration 输出。让数据库管理员在该数据库执行
`CREATE EXTENSION IF NOT EXISTS pg_trgm`，再重跑 `kodama migrate` 和 `kodama doctor`。不要通过
关闭 Doctor 或手工伪造 schema version 绕过。

### Doctor 报 trigram index 缺失或定义错误

运行当前镜像的 `kodama migrate`，不要只创建同名 index。Doctor 会验证 opclass 和 partial
predicate，而不是只看名称。若 migration 中断，保留备份并检查 PostgreSQL 锁、磁盘与权限后重跑。

### 搜索返回 400

检查响应的 `error.code`。短 query 补齐单频道、canonical UTC 起止时间和 `newest`；cursor 错误时
丢弃旧 cursor，从第一页开始并保持其他参数不变。

### 编辑或隐藏后仍看到旧内容

直接请求 API，排除客户端缓存。搜索和 feed 每次重查 current revision/tombstone；若 API 仍错误，
记录 suite message UUID、响应状态和时间，检查数据库 current pointer/tombstone 与 server 版本。
不要把正文、raw update 或 token 粘贴到公开 Issue。

### RSS URL 指向错误 host

检查 server 实际读取的 `BETTER_AUTH_URL`，它必须是公开 canonical origin；修正后重启 server。
不要把请求 `Host` 当作 feed 配置。旧 ETag 客户端会在下一次 GET 得到新的 feed bytes。

### RSS reader 不刷新

用 `curl --head` 比较 ETag/Last-Modified，再带 `If-None-Match` 复现。`304` 表示内容 bytes 未变；
`200` 且 ETag 已变化则通常是 reader cache。Feed 只含最近 50 条且不分页，不能用来恢复更早历史。

### 429 或浏览器 CORS 失败

429 查看 `Retry-After`，降低轮询频率；RSS reader 应使用 conditional GET。浏览器跨域失败时把客户
端的精确 scheme/host/port 加入 `PUBLIC_CORS_ORIGINS` 并重启 server。不要改成 wildcard，也不要
把公开限流当作认证边界。
