# koharu-suite

[中文](./README.md)

`koharu-suite` is an optional content backend and publishing companion for
[astro-koharu](https://github.com/cosZone/astro-koharu). It is planned to provide multi-channel Telegram
archiving, live content, unified administration, and static publishing workflows.

Core principles:

- keep astro-koharu's static build and deployment experience as the default;
- connect the standalone suite backend only when its dynamic capabilities are needed;
- keep content and media exportable and recoverable so removing the backend does not affect existing static posts;
- build on PostgreSQL 18, Astro 6 Live Content Collections, and an open JSON API.

The repository is now implementing the first complete channel-message path in
[G1.2 #4](https://github.com/cosZone/koharu-suite/issues/4):

- `apps/server`: Hono API, sequential Telegram long polling, a Drizzle repository, and the `kodama` CLI;
- `apps/admin`: React and Vite administration shell;
- PostgreSQL 18, Testcontainers, Docker Compose, and CI foundations.

See [Roadmap #1](https://github.com/cosZone/koharu-suite/issues/1) for the complete roadmap.

## Local development

Node.js 22.20+, pnpm 10.28.2, and Docker are required.

Create a bot with [@BotFather](https://t.me/BotFather), make it an administrator of one public channel,
and replace the placeholders in `.env` with the real bot token and the channel's negative numeric Telegram
ID. Git ignores `.env`; never put the real token in a commit, Issue, pull request, or log.

Telegram updates form one bot-wide stream. G1.2 persists only the configured channel, but advancing the
polling offset also acknowledges updates that the same bot received from other channels. Do not run another
`getUpdates` consumer with the same bot. G1.4 will use one collector for every channel in the database
allowlist.

```bash
corepack enable
pnpm install
cp .env.example .env
# Edit TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID in .env
docker compose up -d db
pnpm build
pnpm exec kodama migrate
pnpm dev
```

- Server: <http://localhost:3000>
- Admin: <http://localhost:5173>
- Health: <http://localhost:3000/api/v1/health>

`pnpm dev` starts the Server and Admin together. Vite proxies `/api` to the local Server.

After publishing a message in the configured channel, discover the suite channel ID before reading its
messages:

```bash
curl http://localhost:3000/api/v1/channels
curl "http://localhost:3000/api/v1/messages?channel=<suiteChannelId>"
curl http://localhost:3000/api/v1/messages/<suiteMessageId>
```

The public API uses stable suite IDs. M1 archives Telegram media metadata without downloading files. Public
responses also omit raw updates, numeric Telegram IDs, internal file IDs, and the bot token.

## Docker

```bash
docker compose up -d db
docker compose build server
docker compose run --rm server node dist/cli.js migrate
docker compose up -d server
```

Compose starts PostgreSQL 18 and the Server. Run the migration before starting the collector. Production
Admin hosting is outside G1.2's scope.

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
