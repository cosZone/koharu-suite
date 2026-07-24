# Telegram reconciliation and recovery

[中文](./README.md)

`koharu-suite` reconciliation finds inconsistencies between continuous Bot ingestion, Telegram Desktop history
imports, and the public message projection. It does not treat numeric gaps as real messages and never fetches
Telegram history implicitly.

## What the evidence means

Findings preserve confidence instead of collapsing every signal into “a message is missing”:

- pending, blocked, and owner-skipped durable tasks are database facts;
- disabled windows, Bot retention, `update_id` discontinuities, and channel message-ID gaps are risks or weak
  signals;
- stale or conflicting Desktop observations are known source differences, but do not replace current content;
- missing source-media evidence, renderer drift, and invalid current pointers are repairable only when immutable
  evidence proves one result;
- Desktop absence candidates require an explicitly declared complete bounded channel range and still are not
  deletion facts.

A Bot `update_id` belongs to one global Bot stream, not to a channel. Other update types, filtering, long idle
periods, and retention can all create legitimate discontinuities. A numeric gap therefore never creates a
message, hides content, or infers a deletion.

## Scanning

Run a transient dry-run for one or more configured channels:

```bash
pnpm exec kodama reconcile telegram \
  --channel=-1001234567890 \
  --channel=-1009876543210
```

The default mode reads one PostgreSQL snapshot and writes no run, finding, or audit record. `--json` emits the
same versioned, bounded, privacy-safe report for automation. Exit codes are:

- `0`: clean or repaired;
- `2`: completed with open findings or item errors;
- `1`: fatal or interrupted.

The worker uses a PostgreSQL durable schedule and lease for persisted scans, hourly by default. It resumes claims
after restart and permits only one reconciliation run at a time. Scheduled work records findings but never
applies repairs.

Owner Desk shows the latest run, category counts, and a bounded findings list. Admin responses exclude message
bodies, raw JSON, absolute paths, Telegram file IDs, and Desktop locators.

## Explicit repair

Safe repair requires an explicit local CLI or Owner Desk action and a 1–500 character reason:

```bash
pnpm exec kodama reconcile telegram \
  --channel=-1001234567890 \
  --apply \
  --reason "Verified evidence before deterministic repair"
```

Apply revalidates the finding evidence version, uses a global advisory lock plus row locks, and audits the run,
reason, and before/after state. Allowed deterministic repairs are limited to:

- restoring a provable run/observation lineage link from an immutable Desktop observation;
- restoring source-media evidence from immutable observation raw data;
- rebuilding derived HTML and renderer version;
- repairing an invalid current pointer when the revision sequence is unique and contiguous.

Gaps, stale observations, conflicts, ambiguous media, and absence outside a declared complete range remain
findings. G2.2 never promotes a conflict to current content. Repeated apply returns the terminal state or records
an audited no-op without duplicating messages, revisions, raw records, or observations.

## Desktop-assisted recovery

For disabled, retention, or message-gap findings:

1. export the selected public channel as JSON from Telegram Desktop;
2. run `kodama import telegram-desktop` as a dry-run;
3. review the report, then add `--apply`;
4. rerun reconciliation.

```bash
pnpm exec kodama import telegram-desktop \
  --input /path/to/result.json \
  --channel=-1001234567890

pnpm exec kodama import telegram-desktop \
  --input /path/to/result.json \
  --channel=-1001234567890 \
  --apply
```

Imports continue through the same source-neutral writer. Replaying identical or overlapping exports records exact
run lineage without duplicating canonical content. Absence from one Desktop export does not mean deletion. Only
the owner may hide or unhide a message associated with an absence candidate, and must provide a reason.

Only when you know that an export completely covers a bounded range, repeat
`--complete-range=<channel>:<startMessageId>:<endMessageId>` on apply:

```bash
pnpm exec kodama import telegram-desktop \
  --input /path/to/result.json \
  --channel=-1001234567890 \
  --complete-range=-1001234567890:1:500 \
  --apply
```

The range must belong to a selected channel and is stored only for a clean import run. It can produce a weak
`desktop_absence_candidate`; it never hides a message automatically.

## Visibility and evidence retention

Owner-hidden messages use tombstones:

- public lists filter them out;
- public detail returns an ordinary `404`;
- the suite message ID remains stable;
- revisions, raw data, media, source observations, lineage, and audit history remain stored.

A service token may read Admin summaries or request deterministic content repair when its scope allows, but it
cannot hide or unhide. Raw and provenance data remain an explicit owner reveal and use
`Cache-Control: private, no-store`.

## Reruns, rollback, and upgrades

- scans, imports, and deterministic repairs are safe to rerun by stable key and evidence version;
- back up PostgreSQL before upgrades as described in the [deployment guide](../deployment/README.en.md);
- migrations are additive and rollback does not delete new evidence, but a pre-G2.2 public reader does not
  understand tombstones. The first hide writes `public_reader_compatibility_floor`; while that marker exists
  or any tombstone remains, do not roll the server back before G2.2;
- after upgrading again, rescan and apply only repairs provable from evidence written during rollback;
- do not manually delete reconciliation or source-evidence tables to clear findings.

G2.2 does not download media binaries, create a local cache, or generate thumbnails. Those capabilities belong
to G2.3.
