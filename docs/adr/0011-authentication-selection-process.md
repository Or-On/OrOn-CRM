# ADR 0011: Authentication selection process

- Status: Accepted process; selection deferred
- Date: 2026-08-31
- Owners: Security architecture

## Context

Or-on and WACRM use different identity integrations, including target-prohibited
Firebase and Supabase coupling. The platform eventually needs one login, session,
user, membership, role, and permission model that cooperates with PostgreSQL RLS.
Selecting a framework during foundation work without migration and threat-model
evidence would create unnecessary lock-in.

## Decision

Defer the final framework choice. Evaluate candidates against active maintenance,
security history, self-hostability, PostgreSQL ownership, Next.js compatibility,
secure cookie sessions, CSRF controls, MFA and recovery capability, service
authentication, tenant/RLS integration, auditability, migration effort, and
operational complexity.

The final choice must remove Firebase Auth and Supabase Auth from target runtime
use. It must establish one canonical user and tenant-membership model and must not
bypass fail-closed database authorization. Popularity alone is not a criterion.

## Consequences

Phase 1 exposes no production login and makes no certification claim. Local health
surfaces contain no business data. A later decision must include a migration plan,
abuse analysis, and compatibility proof before implementation.

## Verification

Future decision matrix, session/CSRF tests, RLS-context tests, role/permission
tests, and source identity migration fixtures.
