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

[G1.3 #6](https://github.com/cosZone/koharu-suite/issues/6) introduces the first owner control surface:

- `apps/server`: Hono API, sequential Telegram long polling, a Drizzle repository, Better Auth, and the
  `kodama` CLI;
- `apps/admin`: a React and Vite Owner Desk for authentication, archive status, message browsing, explicit raw
  reveal, and TOTP;
- PostgreSQL 18, Testcontainers, Docker Compose, and CI.

See [Roadmap #1](https://github.com/cosZone/koharu-suite/issues/1) for the complete roadmap.

## Local development

Node.js 22.20+, pnpm 10.28.2, and Docker are required.

Create a bot with [@BotFather](https://t.me/BotFather), make it an administrator of one public channel, then
prepare the local environment:

```bash
corepack enable
pnpm install
cp .env.example .env
openssl rand -base64 32
```

- put the generated value in `BETTER_AUTH_SECRET`; never reuse the example value;
- keep `BETTER_AUTH_URL=http://localhost:3000` for local development;
- set the real `TELEGRAM_BOT_TOKEN` and the channel's negative numeric Telegram ID;
- Git ignores `.env`; never put a token, auth secret, password, cookie, or recovery code in a commit, Issue,
  pull request, or log.

Initialize the database and singleton owner:

```bash
docker compose up -d db
pnpm build
pnpm exec kodama migrate
pnpm exec kodama owner create --email you@example.com
pnpm dev
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

## Telegram and the public API

Telegram updates form one bot-wide stream. The current version persists only the configured channel, but
advancing the polling offset also acknowledges updates that the same bot received from other channels. Do not
run another `getUpdates` consumer with the same bot. G1.4 will use one collector for every channel in the
database allowlist.

After publishing a message, discover the suite channel ID before reading its messages:

```bash
curl http://localhost:3000/api/v1/channels
curl "http://localhost:3000/api/v1/messages?channel=<suiteChannelId>"
curl http://localhost:3000/api/v1/messages/<suiteMessageId>
```

The public API uses stable suite IDs. M1 archives Telegram media metadata without downloading files. Public
responses omit raw updates, numeric Telegram IDs, internal file IDs, and the bot token. Raw updates are
available only to the owner through a separate `private, no-store` endpoint after an explicit click in Admin.

## Docker

In production, `BETTER_AUTH_URL` must be the canonical HTTPS origin shared by Admin and API. Use a unique,
high-entropy `BETTER_AUTH_SECRET`.

```bash
docker compose up -d db
docker compose build server
docker compose run --rm server node dist/cli.js migrate
docker compose run --rm server node dist/cli.js owner create --email you@example.com
docker compose up -d server
```

Compose uses PostgreSQL 18. Run migrations and create the owner before starting the collector. Production Admin
is available at `http://localhost:3000/admin/`, or at `/admin/` under the configured HTTPS origin.

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
