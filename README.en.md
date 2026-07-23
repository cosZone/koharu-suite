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

The repository now contains its first runnable foundation:

- `apps/server`: Hono API, Drizzle migrations, and the `kodama` CLI;
- `apps/admin`: React and Vite administration shell;
- PostgreSQL 18, Testcontainers, Docker Compose, and CI foundations.

See [Roadmap #1](https://github.com/cosZone/koharu-suite/issues/1) for the complete roadmap and
[G1.1 #2](https://github.com/cosZone/koharu-suite/issues/2) for the current implementation goal.

## Local development

Node.js 22.20+, pnpm 10.28.2, and Docker are required.

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d db
pnpm build
pnpm exec kodama migrate
pnpm dev
```

- Server: <http://localhost:3000>
- Admin: <http://localhost:5173>
- Health: <http://localhost:3000/api/v1/health>

`pnpm dev` starts the Server and Admin together. Vite proxies `/api` to the local Server.

## Docker

```bash
docker compose up --build -d
docker compose run --rm server node dist/cli.js migrate
```

Compose starts PostgreSQL 18 and the Server. Production Admin hosting is outside G1.1's scope.

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
