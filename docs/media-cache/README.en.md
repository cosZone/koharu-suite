# Media cache and S3 operations

[中文](./README.md)

Media storage is an optional, disposable acceleration layer. It is not the authoritative copy of an article,
revision, media metadata, or source evidence. Local caching remains the default deployment. With no S3
configuration, the process does not construct an S3 client or read S3 credentials. An operator who needs a
more durable cache copy can add one S3-compatible tier: local is the preferred, evictable hot tier and S3 is
the more durable cached tier.

The suite server always proxies the public URL; it never redirects a reader to the bucket. If no healthy
cached location exists, the media route fails closed while the message itself still succeeds. Consumers
should use its `sourceUrl` to link to the original Telegram message.

## Scope, capacity, and identity

- Cache `photo`, `animation`, and `video` originals.
- Photos are limited to 10 MiB; animations and videos are limited to 20 MiB.
- Eligible originals for one message are limited to 50 MiB in aggregate.
- Local originals, thumbnails, and temporary files share an application ledger capped at 5 GiB.
- `S3_MAX_BYTES` defaults to 5 GiB and may be raised, but never above 5 TiB.
- Photos and supported first animation frames receive static WebP thumbnails. Videos are not decoded.
- Audio, voice, and general documents are not cached.
- Identical bytes share a SHA-256 content-addressed blob across messages, channels, and sources.

Declared upstream sizes allow early rejection only. The worker still applies a streaming hard limit, computes
SHA-256, checks magic-number MIME, and verifies the complete object before publication.
`sha256 + byteLength + detectedMime` is the cross-backend identity; an S3 ETag is transport metadata only.

## Enable the local cache

`MEDIA_CACHE_ENABLED=false` is the default. Compose already creates one `media-cache-data` named volume:
the worker mounts it read-write and the server mounts it read-only. Both roles must use the same
`MEDIA_CACHE_ROOT`, but only the worker may write.

```dotenv
MEDIA_CACHE_ENABLED=true
MEDIA_CACHE_ROOT=/var/lib/koharu/media-cache
MEDIA_CACHE_MAX_BYTES=5368709120
MEDIA_CACHE_DOWNLOAD_CONCURRENCY=2
```

`MEDIA_CACHE_MAX_BYTES` may be lower but cannot exceed 5 GiB. Download concurrency must be 1–4. The image
seeds `.tmp/` and `blobs/` into a new volume. The server only validates directory type, `realpath`, and
containment; it does not create directories through its read-only mount. A non-Compose deployment must create
the complete layout first and grant the worker UID read-write access and the server UID read-only access.

Restart the server and singleton worker after enabling the cache or changing its root:

```bash
docker compose up -d server worker
docker compose logs --tail=100 worker
docker compose exec server node dist/cli.js media status
```

Never expose the root as a static directory or place it inside a web root, personal shared directory, or
Telegram Desktop export.

## Enable the S3-compatible tier

S3 requires the local media cache to be enabled. The following four core settings are all-or-none. Leaving all
of them empty is local-only mode; a partial set fails configuration closed:

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

- `S3_ENDPOINT` must be a canonical HTTP(S) origin without a username, password, query, fragment, or path.
- Plain HTTP is appropriate only for controlled private MinIO and requires
  `S3_ALLOW_INSECURE=true` explicitly.
- `S3_BUCKET` is one bucket name; `S3_PREFIX` is a safe relative object-key prefix.
- Path-style behavior is provider-specific. MinIO commonly needs `true`.
- Connect timeout accepts 250–30,000 ms; the request/body deadline accepts 1,000–120,000 ms.
- `S3_MAX_BYTES` is an application ledger, not a provider quota, and does not constrain unrelated bucket
  objects.

The server and worker must receive the same configuration; Compose already passes these variables to both.
Bucket, endpoint, region, prefix, and path-style settings jointly identify the storage namespace. Do not
change an existing location ledger in place to point at another namespace. Prepare the new deployment, copy
and verify required data, and only then switch. The access key and secret are not part of the namespace, so
they can be rotated by creating a new provider credential, updating and restarting server and worker
together, and then revoking the old credential.

The implementation uses `@aws-sdk/client-s3`. Its only CI compatibility baseline is a pinned MinIO release,
covering create-only put, head, full/range read, and delete. The configuration surface may work with other
S3-compatible providers, but that does not make every provider verified. Run the smoke at the end of this
guide against the target provider, especially `If-None-Match: *` conditional creation, ranges, timeouts, and
permissions. If safe conditional creation is unavailable, writes fail instead of degrading to an unsafe
HEAD-then-PUT overwrite.

## Public reads, recaching, and privacy

Public messages expose only an opaque suite media object ID and, when ready, a
`/api/v1/media/<objectId>` URL. The server selects identity-matching `ready` locations from PostgreSQL in read
priority order: local first, then S3. It can try the next location only before emitting any bytes; a
mid-stream failure never splices two sources. Originals accept one byte range, while thumbnails are full
responses only.

Successful responses retain an opaque ETag and `Cache-Control: public, no-cache`. Every reuse must contact the
server to recheck current revision, tombstone, and object state. Invalid ranges and media errors use
`private, no-store`. Public APIs, Owner Desk, and command results do not expose:

- bot tokens, S3 credentials, or token-bearing temporary URLs;
- Telegram `file_id` or `file_path`;
- endpoints, buckets, object keys, prefixes, or backend fingerprints;
- Desktop export roots, absolute paths, blob SHA-256 values, temporary filenames, or lease tokens.

`recache_on_access` is the default object policy. When a public request succeeds from S3 and no healthy local
copy exists, the system best-effort enqueues a bounded local restore; the public request does not wait.
`stay_evicted` suppresses that automatic recache, so only an explicit owner/local-operator restore can recover
the location. Neither policy synchronously downloads from Telegram when no healthy cache location exists;
consumers still fall back to the message `sourceUrl`.

## CLI and Owner Desk

Read-only status and discovery:

```bash
pnpm exec kodama media status
pnpm exec kodama media status --json
pnpm exec kodama media scan --channel=-1001234567890 --json
```

`status` reports sanitized backend IDs, ready bytes, and state counts. `local` and `s3-default` are the current
backend IDs accepted by storage commands.

Copy and restore are durable worker commands and require explicit `--apply` plus a 1–500 character reason.
Copy supports local ↔ S3 only. It may target one object or let the worker process one bounded batch:

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

Protection and eviction policy are synchronous PostgreSQL mutations:

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

Protection belongs to an object, but multiple objects may share one SHA-256 blob. While any current reference
has active protection, the whole shared blob is protected. Policy pruning and explicit eviction fail closed
until protection is removed or expires. The Admin API accepts an optional protection expiry; the current CLI
creates indefinite protection.

Pruning plans shared-blob LRU within one backend. Preview performs zero mutation. Apply replans from the
current ledger rather than blindly executing an old preview:

```bash
pnpm exec kodama media prune \
  --backend local --target-bytes 4294967296
pnpm exec kodama media prune \
  --backend local --target-bytes 4294967296 \
  --apply --reason "reserve local hot-tier space"
```

Local DB/filesystem reconciliation remains a dry-run by default:

```bash
pnpm exec kodama media reconcile
pnpm exec kodama media reconcile \
  --apply --reason "local volume restored after host maintenance"
```

Owner Desk's Cache panel provides the same sanitized backend/location state, per-object copy/restore,
protect/unprotect, policy, batch copy, and prune preview/apply. Preview and apply must use the same
backend/target; apply also requires a reason and confirmation. Owner Desk mutations require an owner session,
while CLI mutations are recorded as `local_operator`. A service token cannot perform these disk/object
mutations even with `content:write`.

## Crashes, leases, reconciliation, and audit

- Downloads and local copies first enter token-scoped staging, then publish atomically after verification and
  complete database settlement.
- S3 creates use conditional writes. The destination becomes `ready` only after another full verification.
- Copy and restore retain the healthy source; a destination failure never deletes or degrades the source early.
- Copy, restore, prune, eviction, and reconciliation use bounded leases with token fencing.
- After a worker crash, only an expired lease can be taken over, and retries converge on canonical identity.
- Prune is claim → backend delete → token-fenced finalize; accounting is not decremented early.
- Local reconciliation repairs local DB/filesystem drift. It is not a scanner for every provider.
- Mutations audit initiator, reason, action, and sanitized before/after/result/error without secrets, storage
  keys, or provider response bodies.

Do not edit cache/location/backend tables, delete individual blobs, move staging files, or adjust ready bytes
by hand. Doing so bypasses leases, shared identity, protection aggregation, and capacity accounting.

## Cost, credentials, and provider lifecycle

S3 PUT, HEAD, GET, range GET, DELETE, storage, and public egress may all incur charges. Public requests still
pass through the suite server, so an S3 read consumes both provider egress and server bandwidth. The local hot
tier can reduce repeated remote reads but is not a CDN. Estimate costs from the access pattern before changing
capacity or prune targets.

Use a dedicated credential limited to the required operations on the target bucket/prefix, stored in a secret
manager or untracked `.env`. Redact endpoint, bucket, key, and secret before sharing logs, Issues, CI
artifacts, or `docker compose config`. For rotation, create and verify the new credential, restart server and
worker together, and then revoke the old one. Do not revoke the sole working credential during a migration.

Provider lifecycle rules, automatic cleanup, console deletion, and bucket replication state are not the
authoritative ledger. Do not configure a lifecycle rule that deletes `S3_PREFIX` objects without the
application's knowledge. External deletion may cause a read to fall back to another healthy location or the
original Telegram message; an operator must investigate and explicitly restore/copy. Application pruning is
the protected, audited deletion path that also updates PostgreSQL location state.

## Backup and restore consistency

PostgreSQL is the authoritative backup for the canonical archive, provenance, policy, protection, and location
ledger. Local and S3 bytes are rebuildable caches, so an ordinary backup may contain PostgreSQL only.

If the business needs to preserve a warm cache, prevent new mutations and stop server and worker before
capturing these in one downtime window:

1. a PostgreSQL dump;
2. a complete `MEDIA_CACHE_ROOT` snapshot;
3. a provider-consistent snapshot/versioned copy of `S3_BUCKET/S3_PREFIX`;
4. the image digest and a sanitized configuration record.

Do not combine a live blob-tree copy, a database dump from another point in time, and a later bucket listing
and call them a consistent backup. After restore, start with PostgreSQL and the prepared local layout, run a
local reconciliation dry-run, and then enable the worker. Validate important objects with copy/restore and a
public read; never treat a provider listing as the PostgreSQL ledger.

## Disable S3 and return to local-only

1. Stop submitting new storage mutations from Owner Desk and CLI.
2. Inspect recent commands and let required copy/restore/prune operations finish. After a crash, let the worker
   converge once the lease expires.
3. Copy/restore objects that must remain cached to `local`, then check `media status` and public reads.
4. Stop server and worker.
5. Clear `S3_ENDPOINT`, `S3_BUCKET`, `S3_KEY`, and `S3_SECRET` together. Do not leave partial configuration.
6. Restart server and worker; confirm `s3-default` is disabled and local reads work.

Disabling S3 does not delete bucket objects or additive backend/location/audit rows in PostgreSQL. Preserve
those rows for diagnosis and future re-enablement; do not run a destructive down migration. Schedule
out-of-band bucket cleanup only with a separate backup, confirmed loss acceptance, and verified local/source
fallback.

## Manual smoke

Before using a target provider, or after a credential/namespace change, complete at least one smoke:

1. Use `media status` to confirm sanitized state and capacity for `local` and `s3-default`.
2. Copy one verified local object to S3, then perform a full and range read through its public opaque URL.
3. Interrupt the worker during a second copy, restart it, and confirm expired-lease takeover converges.
4. Restore one missing local location and verify that public reads prefer local again.
5. Protect an object whose blob is shared, preview prune, and confirm the shared blob is not a candidate.
6. Unprotect it, preview again, then apply one unprotected location eviction.
7. Confirm an S3 read under `recache_on_access` restores local while `stay_evicted` does not.
8. Make both locations unavailable and confirm that the media route fails closed while the message retains a
   usable Telegram `sourceUrl`.
9. Check that Owner Desk recent commands and audit contain only sanitized state, counts, and error codes.

The project currently has no S3 provider doctor command and does not claim that a target provider is verified.
Keep the smoke date, version, provider, and sanitized result as release evidence.

## Troubleshooting

- Local `permission denied`: verify root ownership/mode and worker-RW/server-RO mounts.
- S3 configuration startup failure: set all four core values, use a canonical endpoint origin, and explicitly
  allow HTTP when appropriate.
- S3 `403`: check clock, credentials, and bucket/prefix permissions without pasting provider responses in logs.
- Repeated `disk_full`: check host space, then preview local prune. The 5 GiB ledger is not a disk quota.
- `missing`/`corrupt`: do not edit a location; retain the healthy source and explicitly copy/restore.
- Growing `blocked`: inspect sanitized error class/code and retry as owner/local operator after repairing access.
- No animation thumbnail: the original remains usable; unsupported, corrupt, or timed-out thumbnails do not
  block the message.

Logs, Issues, and CI artifacts should contain only suite object IDs, backend IDs, kind, state/reason, bytes,
and duration. Never paste `.env`, Telegram download URLs, S3 configuration, Desktop exports, database dumps,
or cache contents.
