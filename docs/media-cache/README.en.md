# Local media cache operations

[中文](./README.md)

The local media cache is an optional, disposable acceleration layer. It is never the sole copy of an article,
revision, media metadata, or source evidence. When a file is pending, over a limit, damaged, evicted, or the
whole volume is gone, the public message still succeeds and consumers should use its `sourceUrl` to link to the
original Telegram message.

## Scope and limits

- Cache `photo`, `animation`, and `video` originals.
- Photos are limited to 10 MiB; animations and videos are limited to 20 MiB.
- Eligible originals for one message are limited to 50 MiB in aggregate.
- Originals, thumbnails, and temporary files share a 5 GiB application ledger.
- Photos and supported first animation frames receive static WebP thumbnails. Videos are not decoded.
- Audio, voice, and general documents are not cached.
- Identical bytes share a SHA-256 content-addressed blob across messages, channels, and sources.

Declared upstream sizes allow early rejection only. The worker still applies a streaming hard limit, computes
SHA-256, checks magic-number MIME, and completes `fsync` before publication. Oversized and unsupported content
is not retained.

## Enable the cache

`MEDIA_CACHE_ENABLED=false` is the default. Compose already creates one `media-cache-data` named volume:
the worker mounts it read-write and the server mounts it read-only. Both roles must use the same
`MEDIA_CACHE_ROOT`, but only the worker may write.

The image seeds empty `.tmp/` and `blobs/` directories, so Docker gives a newly created named volume its
complete layout before mounting it read-only in the server. Server startup performs only `realpath`,
directory-type, and containment validation; it never creates the root or its children. If the cache is
enabled but the layout is missing, the server fails closed instead of trying to write to the read-only volume.

```dotenv
MEDIA_CACHE_ENABLED=true
MEDIA_CACHE_ROOT=/var/lib/koharu/media-cache
MEDIA_CACHE_MAX_BYTES=5368709120
MEDIA_CACHE_DOWNLOAD_CONCURRENCY=2
```

`MEDIA_CACHE_MAX_BYTES` may be lower but cannot exceed 5 GiB. Download concurrency must be 1–4. Restart both
the server and the singleton worker after enabling the cache or changing its root:

```bash
docker compose up -d server worker
docker compose logs --tail=100 worker
docker compose exec server node dist/cli.js media status
```

For a non-Compose deployment, create the root, `.tmp/`, and `blobs/` before starting the server. Give the
worker UID read-write access and the server UID read-only access. Prepare and validate the layout before
starting the server and worker; do not rely on the server to create it. Never expose the root as a static
directory or place it inside a web root, personal shared directory, or Telegram Desktop export.

## Public reads and privacy

Public messages expose only an opaque suite media object ID and, when ready, a
`/api/v1/media/<objectId>` URL. Neither the public API nor Owner Desk exposes:

- bot tokens or token-bearing temporary download URLs;
- Telegram `file_id` or `file_path`;
- a Desktop export root or absolute path;
- blob SHA-256, internal relative keys, or temporary filenames.

A media response is available only while the object, blob, current revision, and non-tombstoned message are
all valid; otherwise it is an ordinary `404`. Originals accept one byte range. Thumbnails are full responses
only. Successful responses use an opaque ETag and `Cache-Control: public, no-cache`: caches may retain the
bytes, but they must contact the server before every reuse. The server returns `304` only after rechecking the
current/non-tombstoned gate and opening the file successfully. Invalid ranges and all media errors use
`private, no-store`. This prevents an owner tombstone or newer revision from being bypassed by a still-fresh
shared-cache entry.

## CLI and Owner Desk

Read-only status:

```bash
pnpm exec kodama media status
pnpm exec kodama media status --json
pnpm exec kodama media scan --channel=-1001234567890 --json
```

Without `--channel`, `media scan` advances exactly one global durable discovery batch; it does not drain a
remaining backlog in one CLI invocation. With one or more configured canonical Telegram channel IDs, the CLI
automatically pages with an independent local keyset cursor and never reads or advances the global discovery
cursor. Automatic pagination stops after 10,000 pages or when the cursor does not advance. Output contains
only aggregate scanned, plans, objects, sources, and `hasMore` values; it does not expose the cursor or
internal media identifiers. A normal completion reports `hasMore: false`. If it is `true`, the safety limit
or cursor guard was reached; narrow the channel scope or inspect discovery health.

Capacity pruning and DB/filesystem reconciliation are dry-runs by default. Every mutation requires explicit
`--apply` and a 1–500 character reason:

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

Desktop media requires a local operator to bind an exact completed import run, the same `result.json`, and its
export root:

For a post that mixes Bot and Desktop sources, the exact import run must cover every active original before the
CLI claims and publishes the whole post. Incomplete coverage remains awaiting a local source; it is never
partially published.

```bash
pnpm exec kodama media cache \
  --import-run <suite-import-run-uuid> \
  --input /path/to/result.json \
  --desktop-root /path/to/export \
  --apply \
  --reason "cache approved Desktop export"
```

The command re-hashes the JSON, applies `realpath` containment, and compares the regular file's device/inode
identity before and after open to reject symlink escapes and parent-directory swaps. Keep the export stable and
read-only for the entire command: do not let a sync tool or another process rewrite it, and never mount a full
personal Telegram export into the long-running worker.

Owner Desk's Cache panel shows enabled state, ready/reserved/max bytes, state counts, recent sanitized
failures, and paginated object/post status. Retry, eviction, and reconciliation require an owner session,
reason, and confirmation. A service token cannot delete disk data even when it has `content:write`;
`admin:read` receives sanitized status only.

Retry is a database-only transaction and completes synchronously. Eviction and reconciliation return an
opaque command ID in `pending` state. The server only enqueues the command in PostgreSQL, so it never unlinks,
syncs directories, or repairs the ledger through its read-only media mount. The worker owns the writable
mount and executes commands with leased token fencing; an expired lease can be taken over after a crash.
One reconcile command completes all internal pages. Recent command status exposes only sanitized counts or
an error code, never a blob hash, path, Bot token, or lease token. A disabled cache fails closed without
enqueueing a command.

## Crash recovery and eviction

- Downloads first enter token-scoped mode `0600` staging files.
- Verified bytes are atomically published as content-addressed blobs, then exposed by a two-phase DB settlement.
- On restart, the worker takes over expired leases: pre-commit staging rolls back and post-commit staging
  completes settlement.
- Eviction first marks a blob `deleting` under a fenced token, then unlinks and syncs the directory, then
  decrements the ledger.
- A failure before unlink restores `ready`; a completed unlink or already-absent file converges as success.
- LRU uses coalesced shared-blob access time with SHA-256 as a stable tie-breaker. It never deletes canonical
  archive rows or evidence.

Do not edit cache tables, delete individual blobs, or move staging files by hand. That bypasses leases, sticky
identity, and the 5 GiB ledger. Use `kodama media reconcile` or Owner Desk.

## Backup, restore, and deleting the whole cache

A PostgreSQL backup is authoritative for the canonical archive, provenance, and cache ledger. The blob tree is
rebuildable and may be excluded from an ordinary backup. After restoring the database, reconcile and let the
worker recache in bounded batches.

If a warm cache must be preserved, stop both server and worker, then snapshot PostgreSQL and the complete
`MEDIA_CACHE_ROOT` in the same downtime window. Never combine a live blob-tree copy with a dump from another
point in time.

Safe whole-cache deletion order:

1. Stop server and worker.
2. Back up PostgreSQL.
3. Remove or replace the cache volume.
4. Start the server with `MEDIA_CACHE_ENABLED=false`.
5. Run `kodama media reconcile --apply --reason "cache volume replaced"`.
6. Enable the cache and start the worker so it downloads from a bounded queue.
7. Check Owner Desk usage, blocked/retry counts, and one public media fallback.

Losing the volume does not remove articles. Before reconciliation, stale ready rows also cannot make the
server guess file content: a failed open closes safely as `404`.

## Troubleshooting

- `permission denied`: verify root ownership/mode and worker-RW/server-RO mounts.
- Repeated `disk_full`: check host free space, then dry-run prune. The 5 GiB ledger is not a host quota.
- Growing `blocked`: inspect sanitized error class/code and let the owner retry after fixing upstream access.
- `missing`: reconcile first and check whether the volume was replaced or an external cleaner removed files.
- Telegram original works but cache does not: verify the bot is still an administrator of the target public
  channel and that the file fits both Telegram Bot API and product limits.
- No animation thumbnail: the original remains usable; unsupported, corrupt, or timed-out thumbnails do not
  block the message.

Logs, Issues, and CI artifacts should contain only suite object IDs, kind, state/reason, bytes, and duration.
Never paste `.env`, Telegram download URLs, Desktop exports, database dumps, or cache-root contents.
