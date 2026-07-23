# Deployment, upgrades, and rollback

[中文](./README.md)

This guide targets a single-host Docker Compose deployment of the `v0.1.x` Preview. The Preview supports one
worker only. Do not scale `worker`, and do not run another `getUpdates` consumer for the same bot.

## Runtime boundaries

One image provides three entry points:

- `migrate` applies PostgreSQL migrations and exits;
- `server` serves the Admin, public API, `/healthz`, and `/readyz`, and receives only database and Better Auth
  configuration;
- `worker` collects Telegram updates, processes tasks, and writes its heartbeat, and receives only database
  and Telegram configuration.

Compose pins PostgreSQL 18. Server and worker have a 25-second graceful shutdown deadline, with a 30-second
Compose grace period.

The deployment image version is always anchored to `@koharu-suite/server`. Every server, Admin, or internal UI
change that alters image contents must include a server changeset before release. Admin and UI still receive
their own changesets under independent SemVer when appropriate, plus a server patch changeset that records the
image-content change. The release workflow fails when the same version tag belongs to an older commit; it
never moves the tag or reuses that version.

## First deployment

The host needs Docker Engine, Docker Compose v2, and access to PostgreSQL, Telegram Bot API, and the container
registry. Create a deployment directory, save the repository's `compose.yaml`, and create an untracked `.env`:

```dotenv
KOHARU_IMAGE=ghcr.io/coszone/koharu-suite:0.1.0
KOHARU_VERSION=0.1.0
KOHARU_REVISION=<release-commit-sha>
KOHARU_HTTP_PORT=3000
POSTGRES_PUBLISHED_PORT=5432

POSTGRES_DB=koharu
POSTGRES_USER=koharu
POSTGRES_PASSWORD=<unique-high-entropy-password>

BETTER_AUTH_URL=https://blog-admin.example.com
BETTER_AUTH_SECRET=<at-least-32-high-entropy-characters>

TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_WORKER_CONCURRENCY=4
```

Never commit `.env`, backups, bot tokens, or passwords. Production `BETTER_AUTH_URL` must be the canonical
public HTTPS origin for the Admin and API. Compose binds `POSTGRES_PUBLISHED_PORT` only to host loopback
`127.0.0.1` by default for local maintenance. If the database does not need host access, remove the port in a
deployment-specific Compose override.

Pull the image, start the database, and apply migrations:

```bash
docker compose pull
docker compose up -d db
docker compose run --rm migrate
```

Configure the first public channel and the singleton owner:

```bash
docker compose run --rm --no-deps worker \
  node dist/cli.js channel add --telegram-id=-1001234567890
docker compose run --rm --no-deps server \
  node dist/cli.js owner create --email you@example.com
```

The owner command hides and confirms the password in an interactive TTY. Start both long-running roles:

```bash
docker compose up -d server worker
docker compose ps
curl --fail https://blog-admin.example.com/healthz
curl --fail https://blog-admin.example.com/readyz
docker compose exec worker node dist/cli.js health worker
```

`/healthz` proves only that the HTTP process is alive; `/readyz` also probes PostgreSQL. The worker refreshes
its heartbeat every 10 seconds, and a heartbeat older than 30 seconds is stale. A reverse proxy should route
traffic only to the server's port 3000.

## Reproducible local smoke

The repository smoke uses a synthetic message and a local Telegram fixture, so it needs no real secret:

```bash
./scripts/compose-smoke/run.sh
```

It builds one image and verifies migration ordering, server readiness, worker heartbeat, rejection of a second
worker, public API ingestion, role-secret isolation, SIGTERM shutdown, and advisory-lock release. On failure it
prints Compose logs, then removes its isolated project and volume. The temporary smoke PostgreSQL port is also
bound only to `127.0.0.1`. `KOHARU_TEST_TELEGRAM_API_ROOT` and
`KOHARU_ENABLE_TEST_TELEGRAM_API_ROOT` belong only to this explicit test path and must not be set in
production.

## Backup

Before every upgrade, create a verifiable PostgreSQL backup and copy it off the deployment host:

```bash
mkdir -p backups
docker compose exec -T db \
  sh -c 'pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom' \
  > "backups/koharu-before-upgrade.dump"
pg_restore --list "backups/koharu-before-upgrade.dump" >/dev/null
```

Also record the current image digest, version, commit, and a redacted copy of `docker compose config`. Do not
put expanded secrets in an Issue, pull request, or log.

## Upgrade

Preview upgrades permit a short maintenance window. Read the GitHub pre-release notes and confirm migration
and minimum Node/PostgreSQL requirements first:

```bash
docker compose stop -t 30 worker server
docker compose pull
docker compose run --rm migrate
docker compose up -d worker
docker compose exec worker node dist/cli.js health worker
docker compose up -d server
curl --fail https://blog-admin.example.com/readyz
```

Then check the Owner Desk, channel list, and one new message. Use only an explicit version or digest;
`koharu-suite` does not publish `latest`. Never overlap the old and new workers during an upgrade.

## Rollback

1. Stop the new server and worker with `docker compose stop -t 30 worker server`.
2. Restore the prior tag or digest in `KOHARU_IMAGE`.
3. Start the prior worker, verify `kodama health worker`, and confirm there is one lock owner.
4. Start the prior server and check `/readyz`, the public API, and the Owner Desk.

The heartbeat migration is forward-compatible, and an ordinary application rollback must not execute a
destructive down migration. If release notes identify an incompatible schema, stop all application containers
and restore the pre-upgrade backup:

```bash
docker compose stop worker server
docker compose exec -T db sh -c 'dropdb --username "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'createdb --username "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c \
  'pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --clean --if-exists' \
  < "backups/koharu-before-upgrade.dump"
```

Restoring the database drops archive changes made after the backup and is a last resort.

## Preview release and one-time repository setup

The manually dispatched `Publish Preview` workflow reruns lint, typecheck, unit tests, PostgreSQL 18
integration tests, workspace and Storybook builds, and the Compose smoke before creating and anchoring a
`vX.Y.Z` GitHub pre-release. When GHCR is enabled, container publishing starts only after that source
pre-release and tag have been created successfully.

Container publishing is off by default. After the owner explicitly accepts that first-time GHCR public
visibility is irreversible:

1. set the Actions repository variable `GHCR_PUBLIC_APPROVED=true`;
2. dispatch the workflow with both `publish_ghcr` and `confirm_public_visibility` selected;
3. after the first push, manually make the package public in its GitHub package settings;
4. verify `X.Y.Z`, `X.Y`, `preview`, and `sha-*` tags exist and that `latest` does not.

`X.Y.Z` and `sha-*` are immutable. The workflow reads both remote digests. If neither exists, it pushes
`X.Y.Z` first and creates the `sha-*` alias from that digest. If a partial publish left one tag missing, it
checks the existing image's version/revision OCI labels before adding only the missing alias. If both exist at
the same digest, it safely skips them. Different digests, mismatched provenance, or an ambiguous
registry/auth/network error fail closed and never overwrite immutable content. `X.Y` and `preview` are
intentionally floating and always move to that canonical digest.

A GitHub package made public cannot return to private. Until the owner confirms, leave both inputs off and
create only the source pre-release. If public publishing is approved later, select that same `vX.Y.Z` tag in
the workflow ref picker and rerun with both GHCR inputs enabled. The workflow accepts only a tag that points
exactly to the current commit and whose existing release is still a pre-release; it never recreates or moves
the release tag. If a GHCR push failed partway through, rerun from that same release tag. The workflow verifies
the matching digest and creates only the missing immutable alias; it never replaces different content.

Changesets maintains independent versions for private workspace packages and never publishes to npm. The
recommended Version Packages credential is a GitHub App installed only on this repository with Contents and
Pull requests read/write. Store its App ID as the Actions variable `CHANGESETS_APP_ID` and its
private key as `CHANGESETS_APP_PRIVATE_KEY`, then set the variable `CHANGESETS_APP_CONFIGURED=true`. Only the
token-minting step receives the private key; checkout, dependency installation, and the Changesets step do not.
The workflow mints a short-lived installation token restricted to this repository and those two permissions,
and App-created or updated pull requests trigger CI normally.

As a fallback, store a repository-only fine-grained PAT with Contents and Pull requests read/write as
`CHANGESETS_GITHUB_TOKEN`. If neither credential exists, the workflow falls back to the built-in
`GITHUB_TOKEN`: enable "Allow GitHub Actions to create and approve pull requests" in Actions settings, then a
maintainer must select "Approve workflows to run" for CI created by that token. Alternatively, manually
dispatch the `CI` workflow with `changeset-release/main` selected in the ref picker. Do not merge a Version
Packages pull request until `CI / Validate` passes.

After installing and authorizing the Renovate GitHub App, Renovate proposes grouped minor and patch updates
weekly. Major updates require dependency dashboard approval, and Renovate automerges patches only after
observing the full CI pass. Keep `CI / Validate` configured as a required status check on `main` so
repository-protection drift cannot weaken that gate.
