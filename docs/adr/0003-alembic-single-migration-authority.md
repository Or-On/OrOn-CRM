# ADR 0003: Alembic as the single migration authority

- Status: Accepted
- Date: 2026-08-31
- Owners: Database architecture

## Context

Or-on has a proven 22-revision Alembic graph. WACRM has 39 ordered Supabase SQL
migrations. OpenLive creates SQLite schema at runtime. Keeping multiple authorities
would make deployment ordering and schema truth ambiguous.

## Decision

Alembic is the only target migration authority.

1. Preserve/import Or-on's valid lineage in Phase 2 without squashing.
2. Translate required WACRM SQL/Supabase migrations into reviewed Alembic
   revisions; raw PostgreSQL SQL inside revisions is acceptable.
3. Create OpenLive PostgreSQL additions through Alembic.
4. Do not introduce Prisma, Drizzle, TypeORM, or Supabase migration runners.
5. Generated TypeScript database types are consumers only.
6. Use generated collision-resistant revision IDs and require exactly one head.

Phase 1 bootstraps a minimal target revision. Reconciliation with the Or-on base is
an explicit Phase 2 preservation task, not an excuse to invent the integrated
schema now.

## Consequences

All schema changes require review, deterministic upgrades, and downgrade/backup
notes. Runtime services never migrate on startup; migration is a one-shot command.

## Verification

`alembic heads`, `alembic current`, clean upgrade, migration check, and CI
single-authority scans.
