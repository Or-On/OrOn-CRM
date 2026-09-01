# ADR 0016: Canonical application authentication

- Status: Accepted
- Date: 2026-09-01
- Owners: Security architecture and product engineering

## Context

The platform must replace Firebase and Supabase Auth with one self-hosted login,
session, tenant-membership, and authorization system. The canonical PostgreSQL
schema already owns users, provider-neutral identity bindings, tenants, and
memberships. Alembic must remain the only migration authority, browser code must
not reach PostgreSQL, session material must be hashed at rest, and tenant context
must be derived from a validated membership before PostgreSQL RLS is set.

Current stable candidates were evaluated from official documentation and package
registries on 2026-09-01:

| Candidate | Current state | Finding |
| --- | --- | --- |
| Better Auth 1.7.2 | Stable, active, MIT, Next.js 16 and PostgreSQL support | Strongest framework candidate, but its core user/account/session and organization schema, framework migration lifecycle, and session-token storage contract conflict with the already-live canonical schema and strict hash-at-rest requirement. Adapting its custom database adapter would put a large framework-internal compatibility surface on the authorization trust boundary. |
| Auth.js | Active ecosystem | Credentials flows do not provide the required canonical database-session lifecycle cleanly, and the current NextAuth v5 line remains an unsuitable foundation for this PostgreSQL-owned password/session model. |
| Lucia | Deprecated March 2025 | Rejected because it is no longer a supported runtime dependency. |
| Keycloak 26.7.2 | Mature and self-hosted | Rejected for the development target because it introduces a separate Java identity runtime, schema, operational lifecycle, and user/session authority rather than extending the canonical platform model. |

## Decision

Implement a narrow platform-owned authentication adapter over the canonical
PostgreSQL model. Use maintained, focused security primitives rather than writing
cryptography:

- `@node-rs/argon2` 2.2.0 for Argon2id password hashing and verification;
- Node Web Crypto/`node:crypto` for cryptographically random opaque tokens and
  HMAC-SHA-256 token digests;
- `jose` 6.2.10 for short-lived signed service and WebSocket assertions;
- `postgres` 3.4.9 through a typed repository owned by the server-only auth
  package.

The browser receives a random opaque session token. PostgreSQL stores only an
HMAC digest made with a secret held outside the database. Session resolution,
rotation, revocation, idle/absolute expiry, tenant switching, login throttling,
and audit writes remain explicit application/domain operations backed by
Alembic-owned tables and narrowly granted PostgreSQL functions.

RBAC remains a platform permission matrix over canonical `memberships`; no auth
framework organization/member tables are introduced. Final authorization is
enforced in the BFF/service layer and PostgreSQL RLS, never by UI state alone.

This is a required adaptation, not a general-purpose identity-provider rewrite.
OAuth, MFA, WebAuthn, public signup, and real email delivery remain deferred.

## Consequences

The trust boundary stays small and aligned with the live canonical schema, but
the platform owns session lifecycle tests, abuse controls, recovery evolution,
and security review. Adding an external identity protocol later must bind through
`platform.identity_bindings` and cannot replace canonical memberships or bypass
RLS. Better Auth may be reconsidered only if a future stable adapter can satisfy
the canonical schema and token-at-rest invariants without becoming a migration
authority.

## Verification

- Argon2id hash/verify and parameter tests.
- Raw-token absence and digest lookup tests.
- Login enumeration, throttle, cookie, CSRF, rotation, revocation, and expiry tests.
- Tenant switch, deny-by-default RBAC, last-owner, RLS, and pool-leakage tests.
- Signed assertion issuer/audience/expiry/tamper tests.
- Alembic one-head, clean PostgreSQL 18.6 upgrade, grant, function, and audit tests.
