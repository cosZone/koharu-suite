# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/server/bin apps/server/bin

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/admin apps/admin
COPY apps/server apps/server

RUN pnpm --filter @koharu-suite/admin build \
  && pnpm --filter @koharu-suite/server build \
  && pnpm --filter @koharu-suite/server deploy --prod --legacy /opt/koharu-suite

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV ADMIN_ASSETS_ROOT=/app/admin

WORKDIR /app

COPY --from=build /opt/koharu-suite ./
COPY --from=build /app/apps/admin/dist ./admin

USER node

EXPOSE 3000

CMD ["node", "dist/cli.js", "serve"]
