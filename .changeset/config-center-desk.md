---
"@koharu-suite/server": minor
"@koharu-suite/admin": minor
---

Redesign the owner desk and add an admin config center. Non-essential environment settings (media cache, S3 storage, public API, ingestion concurrency) are now editable from the admin settings page; overrides are stored in the new `config_overrides` table, merged at boot with explicit environment variables taking precedence, and applied after a restart. S3 credentials are write-only and never echoed back.
