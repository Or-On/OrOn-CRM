# Database security

## Tenant team directory (Phase 6 Inbox fix)

`platform.current_tenant_team()` is a read-only, narrowly scoped
`SECURITY DEFINER` function created by revision `9d3038bec65e`. Only
`platform_web` receives EXECUTE; PUBLIC and unrelated runtime roles do not.
It returns only user ID, email, and canonical role for active members of the
active tenant. Both transaction-local tenant/user context and an active actor
membership are required. Missing context, non-membership, revoked membership,
or a disabled actor/tenant returns no rows. Legacy `editor` maps to `admin`.

The search path is fixed to `pg_catalog`, with all application relations and
functions schema-qualified. `public.users` and `public.memberships` remain
unreadable directly by the web role; no broad identity-table grants are added.
Inbox team listing and assignment validation both consume this function.
The trusted authenticated BFF supplies `app.current_tenant` and
`app.current_user`; these settings are not authentication on an untrusted SQL
connection. Normal browser users never receive database credentials.

Regression tests exercise the actual Inbox data queries as `platform_web` in a
disposable database, plus missing context, foreign tenants, revoked memberships,
disabled users, EXECUTE privileges, and the fixed search path on PostgreSQL.
Downgrade removes the function; roll back the consuming application revision
as well before downgrading a running deployment.

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
