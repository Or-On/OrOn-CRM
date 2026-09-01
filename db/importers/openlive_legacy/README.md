# OpenLive legacy importer

This directory is the only target code permitted to read legacy SQLite and
OpenLive JSON stores. Application runtimes must never import it. Stop the legacy
OpenLive processes before planning an import so the SQLite database and WAL are
quiescent.

The CLI defaults to dry-run. It requires explicit source paths plus a
destination tenant and user, computes source/record checksums, maps IDs with a
stable UUID namespace, rejects conflicting duplicates, omits plaintext secrets,
and prints counts/digests rather than customer content. The canonical PostgreSQL
writer and import-ledger transaction are implemented. Phase 2B read JSON and a
real SQLite fixture and proved that applying either plan twice to PostgreSQL
creates no duplicate canonical rows.

Example (dry-run only):

```text
python -m db.importers.openlive_legacy.cli \
  --tenant-id 10000000-0000-0000-0000-000000000001 \
  --user-id 20000000-0000-0000-0000-000000000002 \
  --sqlite C:/explicit/source/openlive.db \
  --providers C:/explicit/source/providers.json
```

`--apply` still requires an explicit PostgreSQL destination and an operator-owned
source/tenant/user mapping review. Never point it at an unverified database or a
live SQLite file; stop the legacy process first and retain a source backup.
