# OpenLive legacy importer

This directory is the only target code permitted to read legacy SQLite and
OpenLive JSON stores. Application runtimes must never import it. Stop the legacy
OpenLive processes before planning an import so the SQLite database and WAL are
quiescent.

The Phase 2A CLI is dry-run only. It requires explicit source paths plus a
destination tenant and user, computes source/record checksums, maps IDs with a
stable UUID namespace, rejects conflicting duplicates, omits plaintext secrets,
and prints counts/digests rather than customer content. A real apply requires the
canonical PostgreSQL writer and ledger tables and is **PENDING LIVE POSTGRESQL
VALIDATION — PHASE 2B**.

Example (dry-run only):

```text
python -m db.importers.openlive_legacy.cli \
  --tenant-id 10000000-0000-0000-0000-000000000001 \
  --user-id 20000000-0000-0000-0000-000000000002 \
  --sqlite C:/explicit/source/openlive.db \
  --providers C:/explicit/source/providers.json
```

Do not use `--apply` until Phase 2B supplies a reviewed PostgreSQL writer and a
live disposable-database acceptance run.
