# Search and RSS operations

[中文](./README.md)

G2.5 adds PostgreSQL 18 `pg_trgm` search and global/per-channel RSS 2.0 to the public current-message
projection. Both read the archive directly; there is no second search document or feed cache.

## Public and privacy boundaries

- Only the revision referenced by `messages.current_revision_number` is returned. Edits stop old revisions
  from matching; tombstoned messages disappear immediately.
- Raw updates, revision history, Telegram numeric IDs, internal file locators/backends, and owner-only source
  evidence are neither searched nor returned.
- Search snippets are plain text and at most 280 Unicode code points. RSS descriptions XML-escape stored safe
  HTML instead of injecting it into XML.
- RSS has no media enclosures. Item links prefer public Telegram source URLs and otherwise use the public
  suite message URL, so local/S3 media policy does not change feed identity.

These public routes use the existing exact-origin CORS and public rate limit. Cross-origin reads are denied by
default. Put exact origins in `PUBLIC_CORS_ORIGINS`; do not use wildcard or credentialed CORS.
`PUBLIC_RATE_LIMIT_MAX` and `PUBLIC_RATE_LIMIT_WINDOW_SECONDS` tune the per-process fixed-window limiter.

## Global latest messages and context

The global latest endpoint returns stable cursor pages ordered by
`publishedAt DESC, message UUID DESC`:

```http
GET /api/v1/messages/latest?channel=<suiteChannelId>&limit=50&cursor=<opaque>
GET /api/v1/messages/:suiteMessageId/context
```

`latest` accepts no `channel` parameter or up to 32 distinct repeated suite UUIDs. Duplicate IDs are removed;
omitting the parameter reads every public channel. Filtering happens before database pagination, so it cannot
create fetch-then-filter gaps. The cursor is bound to the first request's channel set and snapshot; repeat the same
`channel` parameters on later pages.

`context` returns the full current message plus lightweight, media-free `newer` and `older` references from the
same channel; boundaries are `null`. Ordering matches the feed and tombstoned messages cannot be anchors or
neighbors. A channel UUID exists only after its first archived message. Owner Desk copies the full ID, while
`GET /api/v1/channels` remains the headless fallback. Consumers of all public channels need no manual UUID config.

## Search API

```http
GET /api/v1/search/messages
  ?q=<text>
  &channel=<suiteChannelId>  # repeatable, at most 32 distinct UUIDs
  &from=<canonical-UTC>
  &to=<canonical-UTC>
  &sort=relevance|newest
  &limit=20
  &cursor=<opaque>
```

After trimming, `q` must contain 1–200 Unicode code points. `channel`, `from`, and `to` are optional for
queries of at least three characters. Repeated `channel` values form a server-side visible set before pagination,
and the cursor is bound to the normalized set. `from` is inclusive and `to` is exclusive. Timestamps must be canonical
ISO 8601 UTC, such as `2026-07-01T00:00:00.000Z`.

Queries of at least three characters default to `sort=relevance` and may use `newest`. `limit` defaults to 20
and accepts 1–50:

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

The response contains `{ items, mode, nextCursor }`; each item has the public `message` plus
`match: { score, snippet }`. `score` is only a PostgreSQL relevance-ordering value and is `null` for newest
and short searches. Repeat all parameters and append the opaque `nextCursor` for another page. The cursor is
bound to the query, channel, time range, and sort; do not parse or alter it.

`%`, `_`, and `\` are literal characters, not SQL wildcards. `pg_trgm` affects ranking but does not add fuzzy
non-substring results.

### One- and two-character queries

A short query must select exactly one channel, provide `from` and `to` spanning at most 31 days, use
`sort=newest`, and use a `limit` from 1–20:

```bash
curl --get "$ORIGIN/api/v1/search/messages" \
  --data-urlencode 'q=星' \
  --data-urlencode 'channel=<suiteChannelId>' \
  --data-urlencode 'from=2026-07-01T00:00:00.000Z' \
  --data-urlencode 'to=2026-08-01T00:00:00.000Z' \
  --data-urlencode 'sort=newest' \
  --data-urlencode 'limit=20'
```

A missing bound, a range over 31 days, or relevance sorting returns
`400 short_query_requires_bounded_scope`. Other validation codes are `invalid_query`, `invalid_channel`,
`channel_not_found`, `invalid_time_range`, `invalid_sort`, `invalid_limit`, `too_many_channels`, and
`invalid_cursor`.

## RSS

Both RSS 2.0 feeds return at most 50 public current messages ordered by
`publishedAt DESC, messageId DESC`. They do not paginate:

```text
GET|HEAD /api/v1/rss.xml
GET|HEAD /api/v1/channels/:suiteChannelId/rss.xml
```

```bash
curl "$ORIGIN/api/v1/rss.xml"
curl "$ORIGIN/api/v1/channels/<suiteChannelId>/rss.xml"
curl --head "$ORIGIN/api/v1/rss.xml"
```

An invalid channel UUID returns `400 invalid_channel`; an unknown one returns `404 channel_not_found`. Each
item uses the stable suite message UUID as its `guid`.

The server builds feed self URLs and suite fallback URLs from the origin of `BETTER_AUTH_URL`, never from the
request `Host`. Production must configure the publicly reachable canonical HTTPS origin:

```dotenv
BETTER_AUTH_URL=https://blog-admin.example.com
```

The value cannot contain credentials, a path, query, or fragment. Restart the server after changing it.

Feeds return `application/rss+xml; charset=utf-8`, `Cache-Control: public, no-cache`, a strong `ETag` for the
final UTF-8 bytes, and `Last-Modified`. A matching `If-None-Match` returns 304 without a body:

```bash
ETAG=$(curl --silent --dump-header - --output /dev/null \
  "$ORIGIN/api/v1/rss.xml" |
  awk 'tolower($1) == "etag:" { print $2 }' | tr -d '\r')
curl --include --header "If-None-Match: $ETAG" "$ORIGIN/api/v1/rss.xml"
```

`HEAD` returns the GET-equivalent content type, original body `Content-Length`, ETag, and Last-Modified without
a body. ETag is the correctness mechanism; Last-Modified is only an observation and client optimization.

## Deployment, upgrade, and rollback

The G2.5 migration runs `CREATE EXTENSION IF NOT EXISTS pg_trgm`, then creates project-owned GIN trigram and
public time-order indexes. A managed PostgreSQL migration role may lack extension-install permission. Ask the
database administrator to preinstall `pg_trgm` or grant the narrowly required permission before rollout.
Do not skip a failed migration.

Create and verify a PostgreSQL backup and record the old image digest before upgrading. After migration, run:

```bash
docker compose run --rm --no-deps doctor
```

`Search` must be `ok`. Doctor verifies the real `pg_extension` row and that
`message_revisions_text_trgm_idx` is a partial GIN index with `gin_trgm_ops` and `text IS NOT NULL`. It is
read-only and neither reads nor outputs queries or message text. Then smoke:

```bash
curl --get "$ORIGIN/api/v1/search/messages" --data-urlencode 'q=Astro'
curl --head "$ORIGIN/api/v1/rss.xml"
curl --head "$ORIGIN/api/v1/channels/<suiteChannelId>/rss.xml"
```

Keep the additive indexes and `pg_trgm` when rolling back the application. If schema rollback is unavoidable,
remove only the project-owned G2.5 indexes. **Do not run `DROP EXTENSION pg_trgm`** because other database
objects may share it. Search and RSS have no persistent derived data to clear or rebuild.

## Troubleshooting

- **Doctor reports missing `pg_trgm`:** confirm the PostgreSQL 18 target, have the database administrator run
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`, then rerun `kodama migrate` and `kodama doctor`.
- **Doctor reports an invalid index:** rerun the current image's migration; do not create only a matching
  name, because Doctor also verifies the opclass and partial predicate.
- **Search returns 400:** inspect `error.code`; bound short queries as above. Discard a bad cursor and restart
  from page one with otherwise unchanged parameters.
- **Old content remains after edit/hide:** call the API directly to exclude client caching, then inspect the
  current pointer/tombstone and server version. Do not paste message text, raw updates, or tokens into a
  public Issue.
- **RSS URLs use the wrong host:** fix the server's `BETTER_AUTH_URL` and restart; do not use request `Host`
  as feed configuration.
- **Reader does not refresh:** compare ETag/Last-Modified with `curl --head` and reproduce with
  `If-None-Match`. Feeds contain only the latest 50 messages and cannot restore older history.
- **429 or browser CORS failure:** respect `Retry-After` and use conditional GET. Add the exact client origin
  to `PUBLIC_CORS_ORIGINS`; do not switch to a wildcard.
