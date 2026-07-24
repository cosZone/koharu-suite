# koharu-suite

[中文](./README.md)

`koharu-suite` is an optional content backend and publishing companion for
[astro-koharu](https://github.com/cosZone/astro-koharu). It is planned to provide multi-channel Telegram
archiving, live content, unified administration, and static publishing workflows.

Core principles:

- keep astro-koharu's static build and deployment experience as the default;
- connect the standalone suite backend only when its dynamic capabilities are needed;
- keep content and media exportable and recoverable so removing the backend does not affect existing static
  posts;
- build on PostgreSQL 18, Astro 6 Live Content Collections, and an open JSON API.

[G2.3 #22](https://github.com/cosZone/koharu-suite/issues/22) adds an optional local media cache on top of
multi-channel archiving and auditable recovery:

- `apps/server`: Hono API, PostgreSQL ledger, crash-safe content-addressed blob store, Bot and explicit
  Desktop caching, bounded thumbnails, public media routes, and `kodama media` operations;
- `apps/admin`: a React and Vite Owner Desk for sanitized status, paginated objects, retry, eviction, and
  reconciliation;
- PostgreSQL 18, Testcontainers, Docker Compose, and CI.

See [Roadmap #1](https://github.com/cosZone/koharu-suite/issues/1) for the complete roadmap.
See the [deployment guide](./docs/deployment/README.en.md) for production setup, upgrades, backups, and
rollback.
See the [reconciliation and recovery guide](./docs/reconciliation/README.en.md) for Telegram gap evidence,
Desktop-assisted recovery, explicit repair, and tombstone behavior.
See the [media cache operations guide](./docs/media-cache/README.en.md) for capacity, privacy, backup,
deletion, and crash recovery of the optional local cache.

## Local development

Node.js 22.20+, pnpm 10.28.2, and Docker are required.

Create one bot with [@BotFather](https://t.me/BotFather), make it an administrator of every target public
channel, then prepare the local environment:

```bash
corepack enable
pnpm install
cp .env.example .env
openssl rand -base64 32
```

- put the generated value in `BETTER_AUTH_SECRET`; never reuse the example value;
- keep `BETTER_AUTH_URL=http://localhost:3000` for local development;
- set the real `TELEGRAM_BOT_TOKEN`; `TELEGRAM_CHANNEL_ID` is only an optional one-time legacy bootstrap;
- Git ignores `.env`; never put a token, auth secret, password, cookie, or recovery code in a commit, Issue,
  pull request, or log.

Initialize the database and singleton owner:

```bash
docker compose up -d db
pnpm build
pnpm exec kodama migrate
pnpm exec kodama channel add --telegram-id=-1001234567890
pnpm exec kodama owner create --email you@example.com
```

Then run the two roles in separate terminals:

```bash
# Terminal 1: HTTP server and Admin (does not read the bot token or collect updates)
pnpm dev

# Terminal 2: the singleton Telegram collector/task worker
pnpm dev:worker
```

The CLI hides password input and confirms it when attached to a TTY. Automation must explicitly use
`--password-stdin` to read one line from standard input; passwords are never accepted as argv values. To reset
the owner password:

```bash
pnpm exec kodama owner reset-password --email you@example.com
```

- Server: <http://localhost:3000>
- Development Admin: <http://localhost:5173/admin/>
- Health: <http://localhost:3000/api/v1/health>

Vite proxies `/api` only in development and rewrites Origin to the canonical server origin. Production serves
Admin and API from the same origin at `/admin/`.

TOTP can be enabled after signing in. Recovery codes are shown once during setup; save them in a password
manager, because each code is single-use. A TOTP challenge can explicitly trust the current device for 30 days;
the checkbox is off by default. Trust skips only the second factor and never bypasses the password. Password or
TOTP state changes revoke every database session. Sign-in always uses a seven-day sliding session and does not
offer a “remember me” switch.

### Service tokens

Browsers use only the owner session and never store a shared token. CLI and CI clients can create revocable,
least-privilege service tokens:

```bash
pnpm exec kodama token create --name deploy --scope admin:read --expires-in 30d
pnpm exec kodama token create --name renderer --scope content:write
pnpm exec kodama token list
pnpm exec kodama token revoke --id <api-key-id>
```

`--scope` is repeatable; accepted values are `admin:read`, `ingestion:write`, and `content:write`. Create
requires at least one scope, and `--expires-in` accepts a whole number of days from `1d` through `3650d`. The
plaintext key is printed only once at creation time, the database stores only its hash, and list never prints
the key or hash. Send it to management APIs as `Authorization: Bearer <key>`; an invalid Bearer credential
never falls back to a browser cookie.

## Telegram and the public API

Telegram updates form one bot-wide stream. Run exactly one suite poller and make the same bot an administrator
of every target public channel; do not run another `getUpdates` consumer for that bot. The database allowlist is
default-deny, and raw payloads from unknown channels are not persisted:

```bash
pnpm exec kodama channel add --telegram-id=-1001234567890
pnpm exec kodama channel list
pnpm exec kodama channel disable --telegram-id=-1001234567890
pnpm exec kodama channel enable --telegram-id=-1001234567890
```

The first `channel add` (or `worker` start) binds the database to that Bot's numeric ID. Every later token must belong
to the same Bot; changing Bots requires an explicit migration of the existing cursor and inbox.

The poller stores allowed updates and its next cursor in one PostgreSQL transaction. Four workers run by
default: different channels can progress concurrently, while each channel remains strictly ordered by update
ID. Every `edited_channel_post` creates an immutable revision; a first-known edit starts at revision 1. A failed
task retries exponentially ten times, then blocks only its channel. The initial version never skips it
automatically. Owner Desk can retry or explicitly skip it with a required reason, and records the action in the
audit trail while retaining raw/error evidence. Disabling a channel stops only future ingestion and does not
delete its archive. Because the bot-wide offset still advances, updates sent while disabled are not backfilled
after re-enabling.

Telegram retains unfetched updates for at most roughly 24 hours. If the service remains offline beyond that
upstream window, the Bot API cannot restore updates Telegram has already removed.

After publishing a message, discover the suite channel ID before reading its messages:

```bash
curl http://localhost:3000/api/v1/channels
curl "http://localhost:3000/api/v1/messages?channel=<suiteChannelId>&limit=50"
curl "http://localhost:3000/api/v1/messages?channel=<suiteChannelId>&limit=50&cursor=<nextCursor>"
curl http://localhost:3000/api/v1/messages/<suiteMessageId>
```

Message lists return `{ items, nextCursor }`. `limit` defaults to 50 and accepts 1–100; `cursor` is an opaque
value bound to the selected channel and clients should neither decode nor modify it. Archived revisions store
safe HTML rendered from escaped text/entities. After a renderer upgrade, “Rerender outdated” in Owner Desk
updates only derived HTML/version fields and leaves revision history unchanged.

The public API uses stable suite IDs. M1 archives Telegram media metadata without downloading files. Public
responses omit raw updates, numeric Telegram IDs, internal file IDs, and the bot token. Raw updates are exposed
only on an explicit request by the owner/session or a service token with `admin:read`, with a
`private, no-store` response.

Cross-origin reads are denied by default. If a separate frontend needs them, set exact canonical origins as a
comma-separated `PUBLIC_CORS_ORIGINS` value; wildcard and credentialed CORS are not supported. Public endpoints
default to 120 requests per client per 60 seconds, configurable with `PUBLIC_RATE_LIMIT_MAX` and
`PUBLIC_RATE_LIMIT_WINDOW_SECONDS`. This is a basic in-process fixed-window limiter: restarts clear it and
replicas do not share quotas. `TRUST_PROXY` defaults to `false`; enable it and trust the first
`X-Forwarded-For` value only when the server is reachable exclusively through a trusted reverse proxy.

## Import Telegram Desktop history

Export each target public channel as JSON from Telegram Desktop first. Every target must already exist in the
database allowlist through `kodama channel add`; the command never imports private chats, groups, private
channels, or channels that were not selected explicitly.

```bash
# The default analyzes the file and database without writing a run, message, or provenance
pnpm exec kodama import telegram-desktop \
  --input /path/to/result.json \
  --channel=-1001234567890

# Apply only after reviewing the dry-run; --channel is repeatable
pnpm exec kodama import telegram-desktop \
  --input /path/to/result.json \
  --channel=-1001234567890 \
  --channel=-1009876543210 \
  --apply

# Declare only a bounded range known to be complete; repeat as needed
pnpm exec kodama import telegram-desktop \
  --input /path/to/result.json \
  --channel=-1001234567890 \
  --complete-range=-1001234567890:1:500 \
  --apply

# Automation can consume the versioned JSON report
pnpm exec kodama import telegram-desktop \
  --input /path/to/result.json \
  --channel=-1001234567890 \
  --json
```

Exit code `0` means clean/replay, `2` means the run completed with conflicts or item errors, and `1` means a
fatal error or interruption. Apply uses a dedicated advisory lock, bounded transactions, and replay-safe
provenance, so the same input can safely resume after an interruption. A Desktop export is only a final
snapshot: only a snapshot with unambiguously newer time can become current, while stale or ambiguous content
is reported without replacing the archive. G2.1 stores media metadata and constrained relative references
only; it never reads, copies, or hashes media files, and absence from an export never implies deletion.

Reports contain only counts, numeric channel/message IDs, and bounded sanitized errors. They exclude message
text, unselected chats, absolute paths, and secrets. Apply stores owner-only source evidence for selected
public channels; dry-run does not write to the database.

## Deployment diagnostics

Run the read-only doctor after deployment:

```bash
pnpm exec kodama doctor
```

It checks configuration, PostgreSQL 18 and the schema, the singleton owner, bot identity, and whether enabled
channels remain public with the bot as an administrator. It never calls `getUpdates`, changes the cursor, or
prints database passwords, bot tokens, auth secrets, raw updates, or API keys. A critical failure produces exit
code 1. Because the command does call Telegram `getMe/getChat/getChatMember`, tests and CI should use
fixtures/a safe environment rather than an unauthorized real channel.

## Docker

In production, `BETTER_AUTH_URL` must be the canonical HTTPS origin shared by Admin and API. Use a unique,
high-entropy `BETTER_AUTH_SECRET`.

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

Compose uses PostgreSQL 18 and binds its published database port to host loopback `127.0.0.1` by default.
`migrate`, `server`, and `worker` use one image with distinct commands. Run migrations, configure channels,
and create the owner before starting the server and singleton worker. Production Admin is available at
`http://localhost:3000/admin/`, or at `/admin/` under the configured HTTPS origin. See the
[deployment guide](./docs/deployment/README.en.md) for the complete procedure.

## Commands

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
