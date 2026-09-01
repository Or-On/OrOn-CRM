# Or-on Alembic lineage integration

## Locked source

- Repository: `../or-on`
- Commit: `cece174f4d590a1b8a283d539dd66e08cc689aa9`
- Source: `alembic/versions/`
- Revisions: 22

Mechanical metadata inspection—not filename inference—found root `0001`, branch
point `8eda5976c920`, merge revision `8aa960fd77ec`, and sole source head
`a41d2f6c2925`. All revision IDs, `down_revision` values, branch/dependency
metadata, ordering, upgrade SQL, and downgrade intent are preserved.

## Necessary target adaptations

Three historical files imported `oron_db.DbRole`. The target must build and run
without `../or-on`, so only those import lines point to
`db.alembic.oron_migration_compat.DbRole`, whose two string values exactly match
the locked source. No SQL changes.

Revision `0004` performs a live data query/backfill. Alembic offline connections
cannot return query rows, so a narrow `context.is_offline_mode()` return was
added after its schema operations. Live execution and data semantics are
unchanged; offline SQL now emits the column/index and defers the data backfill to
the real upgrade.

## Phase 1 bootstrap reconciliation

The retired revision is `0001_platform_foundation`. Repository evidence in
`docs/progress.md` states Docker/PostgreSQL was unavailable, live `alembic
upgrade`/`current` were blocked, and only deterministic offline SQL ran. There is
no repository evidence of a persistent database receiving it. It is retained in
`db/alembic/retired/` as a non-executable provenance artifact.

Its useful `platform.system_metadata` content is recreated in a new
Alembic-generated successor of `a41d2f6c2925`. Git history is not rewritten.

```mermaid
flowchart TD
  O[Or-on root 0001] --> H[Or-on head a41d2f6c2925]
  H --> P[generated platform successor]
  P --> U[generated unified domain revisions]
  R[retired Phase 1 proof] -. never live-applied .-> P
```

Fresh upgrade, roles, extensions, and RLS execution passed against PostgreSQL
18.6 in Phase 2B. A non-empty revision `0004` backfill also passed with explicit
test-only LOCAL keys: ciphertext decrypted to the original value, the E.164
blind index matched, empty values remained untouched, and existing ciphertext
was not double-encrypted.

The preserved revision files remain Ruff-checked. Pyrefly excludes the historical
version directory. Revision `0004` now imports a narrow target-local migration
compatibility module that preserves Or-on's AES-256-GCM `v1:` format, tenant UUID
additional authenticated data, E.164 HMAC-SHA256 blind index, LOCAL/KMS selection,
and direct/`SECRET__` environment aliases. It neither mass-copies
`oron_sessions` nor depends on `../or-on`.

Revision `0004`'s downgrade remains intentionally data-irreversible: it drops
the blind-index column but does not recreate plaintext. An operational rollback
across that boundary requires a pre-migration backup. Phase 2B separately
validated downgrade/re-upgrade across all target-owned successors
(`f5e8b540dfeb` down to `a41d2f6c2925` and back to head) on a disposable
database.
