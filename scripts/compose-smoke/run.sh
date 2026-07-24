#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repository_root"

project_seed="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
project_name="$(printf 'koharu-smoke-%s' "$project_seed" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')"
compose=(docker compose --project-name "$project_name" --file compose.yaml --file compose.smoke.yaml)

export BETTER_AUTH_SECRET="compose-smoke-better-auth-secret-32-chars"
export BETTER_AUTH_URL="http://localhost:${KOHARU_SMOKE_PORT:-39000}"
export KOHARU_HTTP_PORT="${KOHARU_SMOKE_PORT:-39000}"
export KOHARU_IMAGE="${KOHARU_IMAGE:-koharu-suite-smoke:${project_name}}"
export KOHARU_REVISION="${KOHARU_REVISION:-smoke}"
export KOHARU_SOURCE="${KOHARU_SOURCE:-https://github.com/cosZone/koharu-suite}"
export KOHARU_VERSION="${KOHARU_VERSION:-0.1.0-smoke}"
export MEDIA_CACHE_ENABLED=true
export POSTGRES_DB="${POSTGRES_DB:-koharu}"
export POSTGRES_PASSWORD="compose-smoke-postgres-password"
export POSTGRES_PUBLISHED_PORT="${KOHARU_SMOKE_POSTGRES_PORT:-55432}"
export POSTGRES_USER="${POSTGRES_USER:-koharu}"
export TELEGRAM_BOT_TOKEN="123456789:fixture-token-not-valid-outside-smoke"

cleanup() {
  status=$?
  if (( status != 0 )); then
    "${compose[@]}" ps --all || true
    "${compose[@]}" logs --no-color --timestamps || true
  fi
  "${compose[@]}" down --volumes --remove-orphans --timeout 10 || true
  exit "$status"
}
trap cleanup EXIT

if [[ "${KOHARU_SMOKE_SKIP_BUILD:-false}" != "true" ]]; then
  "${compose[@]}" build migrate
fi

"${compose[@]}" up --detach --no-build --wait --wait-timeout 60 server worker telegram-fixture

"${compose[@]}" exec --no-TTY server node -e \
  "Promise.all(['/healthz', '/readyz'].map((path) => fetch('http://localhost:3000' + path).then((response) => { if (!response.ok) process.exit(1) })))"
"${compose[@]}" exec --no-TTY worker node dist/cli.js health worker

"${compose[@]}" exec --no-TTY server sh -c \
  'test "${TELEGRAM_BOT_TOKEN+x}" != x && test "${KOHARU_TEST_TELEGRAM_API_ROOT+x}" != x'
"${compose[@]}" exec --no-TTY worker sh -c \
  'test "${BETTER_AUTH_SECRET+x}" != x && test "${BETTER_AUTH_URL+x}" != x'
"${compose[@]}" exec --no-TTY server sh -c \
  'test -d /var/lib/koharu/media-cache/.tmp && test -d /var/lib/koharu/media-cache/blobs'
"${compose[@]}" exec --no-TTY worker sh -c \
  'test -w /var/lib/koharu/media-cache && printf "media-cache-volume-smoke\n" > /var/lib/koharu/media-cache/.compose-smoke'
"${compose[@]}" exec --no-TTY server sh -c \
  'test -r /var/lib/koharu/media-cache/.compose-smoke && grep -q media-cache-volume-smoke /var/lib/koharu/media-cache/.compose-smoke'
if "${compose[@]}" exec --no-TTY server sh -c \
  'printf "server-must-not-write\n" > /var/lib/koharu/media-cache/.server-write-test' 2>/dev/null; then
  printf 'Server unexpectedly wrote to the read-only media cache volume.\n' >&2
  exit 1
fi

node scripts/compose-smoke/assert-public-api.mjs

leader_before="$("${compose[@]}" exec --no-TTY db psql \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align \
  --command "select instance_id from worker_runtime
    where singleton_key = 'telegram' and last_telegram_success_at is not null")"
test -n "$leader_before"

set +e
second_worker_output="$("${compose[@]}" run --rm --no-deps worker node dist/cli.js worker 2>&1)"
second_worker_status=$?
set -e
if (( second_worker_status == 0 )); then
  printf '%s\n' "$second_worker_output"
  printf 'A second worker unexpectedly started successfully.\n' >&2
  exit 1
fi

leader_after="$("${compose[@]}" exec --no-TTY db psql \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align \
  --command "select instance_id from worker_runtime where singleton_key = 'telegram'")"
test "$leader_before" = "$leader_after"
"${compose[@]}" exec --no-TTY worker node dist/cli.js health worker

server_container="$("${compose[@]}" ps --quiet server)"
worker_container="$("${compose[@]}" ps --quiet worker)"
test -n "$server_container"
test -n "$worker_container"
"${compose[@]}" stop --timeout 30 server worker
server_state="$(docker inspect --format '{{.State.Running}}:{{.State.ExitCode}}' "$server_container")"
worker_state="$(docker inspect --format '{{.State.Running}}:{{.State.ExitCode}}' "$worker_container")"
if [[ "$server_state" != "false:0" || "$worker_state" != "false:0" ]]; then
  printf 'Graceful shutdown failed (server=%s worker=%s).\n' "$server_state" "$worker_state" >&2
  exit 1
fi

"${compose[@]}" up --detach --no-build --wait --wait-timeout 60 worker
"${compose[@]}" exec --no-TTY worker node dist/cli.js health worker
"${compose[@]}" stop --timeout 30 worker

printf 'Compose smoke passed.\n'
