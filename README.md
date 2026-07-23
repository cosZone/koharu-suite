# koharu-suite

[中文](#中文) · [English](#english)

## 中文

`koharu-suite` 是 [astro-koharu](https://github.com/cosZone/astro-koharu) 的可选伴生后台，计划提供
Telegram 多频道归档、动态内容、统一管理与静态发布能力。

核心原则：

- 默认保持 astro-koharu 的纯静态构建与部署体验；
- 需要时再连接独立的 suite 后端；
- 内容与媒体可导出、可恢复，移除后端不影响既有静态站点；
- 以 PostgreSQL 18、Astro 6 Live Content Collections 和开放 JSON API 为基础。

当前仓库已经包含第一个可运行骨架：

- `apps/server`：Hono API、Drizzle migration 与 `kodama` CLI；
- `apps/admin`：React + Vite 管理端壳；
- PostgreSQL 18、Testcontainers、Docker Compose 与 CI 基础。

完整路线图见 [Roadmap #1](https://github.com/cosZone/koharu-suite/issues/1)，当前实现 Goal 见
[G1.1 #2](https://github.com/cosZone/koharu-suite/issues/2)。

### 本地开发

需要 Node.js 22.20+、pnpm 10.28.2 与 Docker。

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d db
pnpm build
pnpm exec kodama migrate
pnpm dev
```

- Server：<http://localhost:3000>
- Admin：<http://localhost:5173>
- Health：<http://localhost:3000/api/v1/health>

`pnpm dev` 会同时启动 Server 与 Admin；Vite 会把 `/api` 代理到本地 Server。

### Docker

```bash
docker compose up --build -d
docker compose run --rm server node dist/cli.js migrate
```

Compose 启动 PostgreSQL 18 与 Server。Admin 的生产托管不属于 G1.1 范围。

### 常用命令

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm exec kodama --help
```

## English

`koharu-suite` is an optional content backend and publishing companion for
[astro-koharu](https://github.com/cosZone/astro-koharu). It is planned to provide multi-channel Telegram
archiving, live content, unified administration, and static publishing workflows.

The static astro-koharu experience remains the default. The suite is connected only when its dynamic
capabilities are needed.

The initial workspace foundation includes a Hono server, a React/Vite admin shell, the `kodama` CLI,
Drizzle migrations, PostgreSQL 18, Testcontainers, Docker Compose, and CI.

## License

[AGPL-3.0](./LICENSE)
