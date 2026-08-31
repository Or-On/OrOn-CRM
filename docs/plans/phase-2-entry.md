# Recommended Phase 2 entry task

First reconcile the target Alembic bootstrap revision with the locked Or-on
Alembic history at `cece174f4d590a1b8a283d539dd66e08cc689aa9`.

The task must inventory every Or-on revision ID/down-revision, preserve its order
and SQL/RLS behavior, choose a reviewed connection between the retained lineage
and Phase 1 foundation revision, and prove clean upgrade to exactly one head on a
fresh PostgreSQL 18 database. Do not import Or-on packages or translate WACRM SQL
until this lineage plan passes review and migration tests.

The source repository remains read-only. Every imported revision must be recorded
in `docs/audit/source-map.md` with locked commit and license treatment.
