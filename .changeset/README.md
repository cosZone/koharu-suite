# Changesets

Add a changeset to feature and fix pull requests that change a versioned workspace package:

```bash
pnpm changeset
```

All M1 packages remain private. Changesets updates their independent versions and changelogs through the
Version Packages pull request; it does not publish anything to npm. The initial `v0.1.0` Preview is tagged from
the fully validated commit without a synthetic bump to `0.1.1`.

The deployment image version is always read from `@koharu-suite/server`. Every change that alters image
contents must therefore include a server changeset before the next release, including changes whose primary
owner is `@koharu-suite/admin` or `@koharu-suite/ui`. Add the package's own changeset as appropriate, plus a
server patch changeset that records the image-content change. This keeps independent package SemVer while
ensuring that a new image never reuses an existing immutable server version.
