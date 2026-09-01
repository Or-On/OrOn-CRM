# Phase 2B live PostgreSQL validation

Phase 2A does not claim any item below has passed. Execute against an isolated,
disposable PostgreSQL 18.6 database through `make db-verify-live` after Docker and
GNU Make are available.

## Clean migration and catalog

1. Start healthy PostgreSQL 18.6; confirm required `pgcrypto` and `citext` and
   confirm optional pgvector is not required.
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

Every item remains **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B** until its
real server evidence is recorded in `docs/progress.md`.
