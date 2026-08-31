# ADR 0004: Canonical identity and PostgreSQL RLS direction

- Status: Accepted architectural direction; implementation deferred
- Date: 2026-08-31
- Owners: Security and database architecture

## Context

Or-on uses Firebase identity bindings and many-to-many memberships with
transaction-local RLS. WACRM uses Supabase Auth and one account per profile.
OpenLive has no product identity. Application filters alone cannot safely unify
these trust models.

## Decision

Create one PostgreSQL-backed user, session, tenant, membership, role, and
permission model in a later phase. Retain legacy provider subjects as migration
identities, not runtime authentication dependencies.

Tenant transactions use `SET LOCAL app.current_tenant`, `app.current_user`, and
`app.current_role`. Tenant tables enable and force RLS and fail closed without
context. Separate runtime roles receive the minimum table/function privileges.

## Consequences

Final authentication selection remains deferred under ADR 0011. Service helpers
must own transaction context; browser code never accesses PostgreSQL. Connection
pool reuse requires explicit leakage tests.

## Verification

Phase 2 RLS negative tests for cross-tenant reads/writes, missing context, pooled
tenant switching, and cross-role denial.
