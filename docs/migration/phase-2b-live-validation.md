# Phase 2B live PostgreSQL validation

The complete Phase 2B gate ran against fresh, disposable PostgreSQL 18.6
databases on 2026-09-01. All 25 PostgreSQL tests passed, including the extended
downgrade/backfill/importer/constraint matrix. GNU Make is still unavailable, so
the repository runner was invoked directly; it is the same implementation used
by `make db-verify-live`.

| Item | Status | Evidence / remaining work |
| --- | --- | --- |
| 1 | passed | PostgreSQL 18.6 and required `citext` verified; pgvector and pgcrypto are not required by the base graph. |
| 2 | passed | Empty databases upgraded through 27 revisions to sole head `f5e8b540dfeb`; expected catalog objects passed. |
| 3 | passed | Target-owned successors downgraded from `f5e8b540dfeb` to the Or-on head and re-upgraded; non-empty Or-on `0004` AES-GCM/blind-index semantics passed with test-only keys. Its data downgrade remains intentionally backup-based. |
| 4 | passed | Development seed, OpenLive JSON/SQLite writes, and the implemented WACRM export slice are idempotent. |
| 5 | passed | Historical/successor role existence and unprivileged runtime attributes passed. |
| 6 | passed | Runtime DDL denial and voice/messaging domain separation passed. |
| 7 | passed | Missing context and cross-tenant select/insert/update/delete isolation passed. |
| 8 | passed | Membership, `SET LOCAL` clearing, forced RLS, domain separation, and audit immutability passed. |
| 9 | passed | All 91 unified-schema FKs declare CASCADE/RESTRICT/SET NULL; representative action families plus cross-domain check/unique constraints execute. |
| 10 | passed | Provider event/message and E.164 deduplication passed. |
| 11 | passed | Domain mutation plus outbox rollback atomicity passed. |
| 12 | passed | Concurrent `SKIP LOCKED`, stale leases, bounded retry/backoff, and terminal failure passed. |
| 13 | passed | Published flow immutability and chronological `(timestamp, UUID)` message/audit keyset pagination passed. |
| 14 | passed | OpenLive JSON and real SQLite fixture imports plus WACRM mapping ran twice; checksums/IDs remained stable and no duplicates appeared. |
| 15 | passed | PostgreSQL FTS passed with the schema's `simple` multilingual configuration; vector search remains optional. |

## Clean migration and catalog

1. Start healthy PostgreSQL 18.6; confirm required `citext`, confirm optional
   pgvector is not required, and confirm deferred `pgcrypto` is not needed by
   the base graph.
2. Upgrade an empty database to the sole Alembic head; run `alembic current
   --check-heads` and inspect every expected schema/table/view/function/index.
3. Test supported downgrade/re-upgrade boundaries and Or-on `0004` backfill with
   explicit test-only encryption/blind-index secrets.
4. Verify deterministic development seed and importer writes are idempotent.

## Roles and RLS

5. Assert all historical/successor roles exist and runtime roles lack superuser,
   database/role creation, replication, and `BYPASSRLS`.
6. Prove runtime roles cannot perform DDL and only access granted domains.
7. Prove missing tenant context fails closed and tenant A cannot select, insert,
   update, or delete tenant B data.
8. Prove user/membership policies, `SET LOCAL`, forced RLS, rollback/pool context
   clearing, voice/messaging separation, and audit immutability.

## Integrity and concurrency

9. Exercise every FK/check/unique/partial index and intentional delete action.
10. Deduplicate webhook/provider/message IDs and E.164 identities.
11. Prove domain mutation + outbox atomicity.
12. Run concurrent `SKIP LOCKED` claims; prove no double claim, stale lease
    recovery, bounded retries/jitter, and terminal failure behavior.
13. Prove immutable published flow versions and chronological keyset pagination.

## Import and search

14. Execute the OpenLive importer twice (SQLite and JSON fixtures) and WACRM
    mapping import twice; compare checksums/ID mappings and confirm no duplicates.
15. Verify PostgreSQL FTS and confirm semantic vector search remains optional.

The status table above and `docs/progress.md` are the evidence authority. All
Phase 2B database items are passed.

The final consolidated gate also passed 35 repository-controlled Python tests
(with the 25 live tests correctly skipped when no explicit URL is supplied), 15
TypeScript tests, strict typing/lint/format, deterministic contracts, the Next.js
production build, both production container builds, the healthy core Compose
chain, prohibited-runtime/security guards, and dependency audits. A vulnerable
`cryptography 49.0.0` pin discovered by `pip-audit` was replaced with patched
50.0.0; the real non-empty historical backfill passed again afterward.

## Prepared command surface

```text
make db-verify-offline
TEST_DATABASE_URL=postgresql://... make db-verify-live
```

`db-verify-live` refuses to run without an explicit PostgreSQL URL, upgrades the
single graph, checks the current head, and runs tests marked `postgres`. Local
evidence passed through `uv run python scripts/dev.py db-verify-live`; CI remains
prepared with a disposable PostgreSQL 18.6 service, but no remote CI result is
claimed until that workflow actually runs.
