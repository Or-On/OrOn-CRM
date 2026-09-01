# Authentication operations

## Local bootstrap

`make bootstrap` (or `uv run python scripts/dev.py bootstrap`) installs the locked
workspace, runs `pnpm auth:material`, migrates PostgreSQL, and applies the
idempotent fictional identity seed. Generated secrets stay in ignored `.env`.
The generated password is written only to ignored
`.artifacts/development-login.txt` with restrictive permissions.

Never copy local auth secrets or password hashes into tracked files. To rotate a
local development login, clear `DEV_AUTH_PASSWORD_HASH` in `.env`, rerun
`pnpm auth:material`, then run `make seed`. Existing sessions should be deleted
from `platform.auth_sessions` only in the explicitly targeted development
database.

## Session behavior

- `POST /api/auth/login` creates an opaque server session.
- `GET /api/auth/session` returns the safe current identity and memberships.
- `POST /api/auth/tenant` validates CSRF and membership, then rotates both tokens.
- `POST /api/auth/logout` validates CSRF and revokes the database session.
- `POST /api/auth/live-grant` issues a 60-second audience/capability-bound grant.

Unsafe routes require same-origin `Origin`, acceptable Fetch Metadata, the CSRF
cookie, and matching `x-csrf-token`. The session cookie is `HttpOnly`, `SameSite`
and Secure in production. Never log either cookie.

## Incident actions

For a suspected session compromise, disable the canonical user or revoke the
specific session through an audited administrative operation. Database-wide
deletion is not an incident response mechanism. Rotate `AUTH_TOKEN_PEPPER` only
with an intentional all-session invalidation plan; rotate `AUTH_SERVICE_SECRET`
with coordinated BFF/service deployment because it invalidates outstanding
short-lived assertions.

## Verification

Run `make migration-check`, `make db-verify-live`, and `make verify`. Live tests
prove session lifecycle, function grants, last-owner protection, PostgreSQL 18.6
migration history, RLS, and audit behavior. TypeScript tests prove Argon2id,
token digests, CSRF/origin checks, RBAC, and signed assertions.
