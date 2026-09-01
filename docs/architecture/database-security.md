# Database security

## Implemented in repository-controlled Phase 2A artifacts

- One Alembic graph and PostgreSQL-only SQL.
- Canonical tenant context is transaction-local `app.current_tenant`; optional
  user/role context is `app.current_user` and `app.current_role`.
- New tenant tables define `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL
  SECURITY` with fail-closed policies.
- Runtime roles are declared without superuser, role/database creation, or
  `BYPASSRLS` attributes.
- Static checks reject target migrations that reference `auth.uid()`,
  `auth.users`, Supabase Realtime/Storage authority, public grants, or privileged
  runtime roles.
- Credential-bearing records store encrypted material metadata/reference fields;
  no migration invents cryptography or plaintext provider secret storage.
- Audit metadata and durable-event payloads are documented as secret-free.

## Phase 2B live controls

PostgreSQL 18.6 tests validate that:

- roles/grants have the intended effective privileges;
- RLS fails closed with no tenant and blocks cross-tenant SELECT/INSERT/UPDATE/DELETE;
- transaction-local context does not leak through pooled connections;
- security-sensitive functions use controlled `search_path` and correct caller checks;
- normal roles cannot mutate audit history or execute DDL;
- voice and messaging roles cannot read each other's restricted data;
- the historical encryption/backfill migration works with explicit test-only
  secrets supplied out of band.

These tests establish the database foundation, not production authorization or
authentication certification. Future domain operations require policy fixtures
before they ship.

## Policy shape

Policies prefer direct, auditable comparisons:

```sql
tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
```

Membership checks use canonical `memberships` and `app.current_user`. Any
`SECURITY DEFINER` function is limited to atomic database-owned behavior, sets an
explicit trusted `search_path`, and revokes `PUBLIC` execution before granting a
specific runtime role. Application `WHERE tenant_id = ...` clauses remain useful
but are never the isolation boundary.
