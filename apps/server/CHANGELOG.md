# @koharu-suite/server

## 0.3.3

### Patch Changes

- 210f6ac: Preserve visible Telegram Desktop custom emoji text when exports omit or leave empty the document ID, retain poll questions as marked text while deferring options, and make documented Compose diagnostics wait for healthy services.

## 0.3.2

### Patch Changes

- b45f3b3: Preserve Telegram Desktop messages when custom emoji entities omit their document IDs, and record the updated parser version in import reports.

## 0.3.1

### Patch Changes

- 54a7644: Refresh the server image so the embedded Owner Desk ships with the redesigned administration interface.

## 0.3.0

### Minor Changes

- 03c7203: Add global message pagination, same-channel message context, bounded visible-channel filters, Owner Desk channel ID copying, and Astro 6/7 consumer support for the Moments integration.

## 0.2.0

### Minor Changes

- 2c393fd: Add PostgreSQL trigram message search, bounded short queries, public RSS feeds, Owner Desk discovery, and
  deployment diagnostics.
- 0b9524e: Add auditable Telegram reconciliation, explicit deterministic repairs, scheduled scans, exact import lineage, and
  Owner Desk recovery controls.
- c64f268: Add the optional crash-safe local media cache, bounded Telegram originals and thumbnails, revalidated public
  media responses, deterministic 5 GiB eviction, and Owner Desk/CLI cache operations.
- 7bad252: Add resumable Telegram Desktop JSON imports with dry-run reporting, source provenance, and revision-aware idempotency.
