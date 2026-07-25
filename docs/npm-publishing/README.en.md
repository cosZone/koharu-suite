# Publishing `@coszone/koharu-astro` to npm

This process publishes only `packages/koharu-astro`. The server, Admin app, and internal UI package remain private
and are not published by the npm workflow.

## Pull request artifact gate

The feature branch carries version `0.0.0`. Its minor Changeset makes the first Version Packages pull request
produce `0.1.0`. Before publishing, run:

```bash
pnpm install --frozen-lockfile
pnpm pack:koharu-astro
```

The command builds the package, writes `.artifacts/koharu-astro/package.tgz`, enforces a tarball allowlist, scans
for common credentials and private paths, validates public npm metadata, runs `npm publish --dry-run --access
public`, and prints the artifact SHA-256.

Fixtures must consume an audited tarball instead of a `workspace:*` dependency. Pull request CI packs once and
passes that same tarball to the minimal fixture and the pinned template fixture.

## First-package bootstrap: owner checkpoint

Before the first publish, the owner must personally confirm:

- the `coszone` npm organization exists and the current account can publish to it;
- account-level 2FA is enabled and usable;
- the Version Packages pull request is merged, the tarball version is `0.1.0`, and the registry is
  `https://registry.npmjs.org/`;
- `npm view @coszone/koharu-astro` still returns 404;
- the original artifact downloaded from successful main CI after the Version Packages merge has the same SHA-256
  printed by the `Pack and audit koharu-astro` step.

Download and inspect the file that will actually be published:

```bash
gh run download <main-ci-run-id> \
  --name koharu-astro-npm-package \
  --dir .artifacts/koharu-astro-ci
shasum -a 256 .artifacts/koharu-astro-ci/package.tgz
tar -xOf .artifacts/koharu-astro-ci/package.tgz package/package.json
```

The gzip implementations on macOS and Linux can give content-identical `.tgz` files different compressed-file
SHA-256 values. Do not replace the CI artifact with a local rebuild. Publish the downloaded and verified original.

A trusted publisher cannot be attached before the package exists, and npm cannot stage a brand-new package. The
first public release must be an owner-interactive local publish:

```bash
npm login --registry=https://registry.npmjs.org/
npm publish .artifacts/koharu-astro-ci/package.tgz \
  --access public \
  --tag latest \
  --provenance=false \
  --registry=https://registry.npmjs.org/
```

This command is the irreversible owner checkpoint and npm will require 2FA. `--provenance=false` is limited to this
local bootstrap because a local terminal cannot create GitHub Actions provenance. Keep
`publishConfig.provenance: true` in the package metadata. Stop on any scope ownership, 2FA, version, or digest
mismatch. Do not switch to a personal scope or create a long-lived automation token.

## Later versions: OIDC plus staged approval

After the package exists, add its only trusted publisher in npm package Settings:

- Provider: GitHub Actions
- Organization/User: `cosZone`
- Repository: `koharu-suite`
- Workflow: `stage-koharu-astro.yml`
- Environment: `npm`

Create a protected GitHub `npm` environment that requires owner approval. After both sides are configured, set the
repository variable `NPM_TRUSTED_PUBLISHING_CONFIGURED=true` to unlock the workflow's fail-closed gate. Do not add
an `NPM_TOKEN` repository secret. The workflow uses a GitHub-hosted runner, pinned npm `11.18.0`, and
`id-token: write` to obtain a short-lived OIDC identity. npm staged publishing requires CLI `>=11.15.0`.

For each later version:

1. merge the Version Packages pull request produced by Changesets;
2. manually run `Stage koharu-astro on npm`, select `latest` or `next`, and confirm staging;
3. let the workflow rebuild and audit the tarball before `npm stage publish` authenticates through OIDC;
4. inspect the staged manifest, SHA-256, version, and dist-tag, then approve with owner 2FA;
5. install the exact registry version in an isolated Astro fixture and rerun the smoke test.

Trusted publishing automatically generates provenance for a public package from a public GitHub repository. It
does not require a long-lived npm token or an explicit `--provenance` flag.

## Rollback

Published npm versions are immutable. Deprecate an affected version and publish a fix; do not rely on unpublish.
Astro sites that never enabled the adapter are unaffected. Enabled sites can pin an earlier version or remove the
live config to return to static-only behavior.

See [README.md](./README.md) for the Chinese documentation.
