# Execution baseline

Captured 2026-09-15 in `C:\Users\almo9\Or-On-Integration\OrOn-Platform`.
No secrets or customer records are included in the identifiers below.

## Repository identity

| Item | Observed value |
| --- | --- |
| Target remote | `https://github.com/Abssel-AI/OrOn-CRM.git` |
| Branch | `main` |
| HEAD | `a7d18bc7bf937154af9d120fede61355a0a09271` |
| Working tree | 75 unstaged tracked paths, 87 untracked paths, no staged paths |
| Implementation source files | 1,196 tracked/untracked, non-ignored files; `.env*`, `.artifacts` and this evidence directory excluded |
| Implementation snapshot SHA-256 | `d4c92c5c1c103dd7bd1d2fe4f3a2fc4d539f4199e9d57afed69a601d716ad29d` |
| Tracked implementation diff SHA-256 | `fa0fb5588f0f5fd86016cb5fb2a5979643a00671ec892ac809cd40f09f082b47` |
| Read-only source reference | `https://github.com/Abssel-AI/Brimag.git`, `main`, `08228541cf0ccf7f65eb8517ec9c5346c29f280f` |

The implementation snapshot hashes a sorted manifest of paths and Git blob IDs
while excluding this self-referential evidence directory. It is a working-tree
identity, not a Git commit. The tree was deliberately left dirty:
no reset, clean, commit, push, deployment or shared-environment mutation was
performed.

## Toolchain and locks

| Tool | Observed | Repository requirement / note |
| --- | --- | --- |
| Git | 2.54.0 | available |
| Node.js | 25.9.0 | **unsupported locally**; repository requires `>=24.20.0 <25` |
| pnpm | 11.24.0 | lockfile `pnpm-lock.yaml` |
| Python | 3.14.7 | repository requires `>=3.14,<3.15` |
| uv | 0.12.7 | lockfile `uv.lock` |
| Docker client | 29.7 | daemon unavailable on this workstation |
| GNU make | unavailable | canonical commands were invoked directly |

Node 25 emitted an engine warning for every pnpm command. Successful compilation
under Node 25 does not replace the required supported-Node CI/release run.

## Database and migration state

| Check | Observation |
| --- | --- |
| Alembic bases | `0001` |
| Alembic heads | exactly one: `b72c5f0e4d91` |
| Revision count | 68 total; 22 Or-On revisions |
| Offline schema contract | PASS |
| Offline SQL | 373,206 bytes; SHA-256 `68bf55c7b04d740de9e0d7412034dc9ffa14d6f607653e522dd1a50add554a2a` |
| Local PostgreSQL | unavailable on checked ports; no explicit isolated `TEST_DATABASE_URL` |
| Online migration/RLS suite | BLOCKED, not passed |

The additive lifecycle migration is present in source but was not applied to a
shared or deployed database. No application database was repointed for tests.

## Runtime and deployment observation

- `https://dev.or-on.io` answered read-only HTTP checks: HTTP redirected to
  HTTPS, the root/login surface returned 200, and the protected health endpoint
  returned 401 without authentication.
- The public response does not expose enough trusted release/schema identity to
  prove that this working tree is deployed. No ordinary-role DEV credentials
  were used, so authenticated workflow acceptance is `BLOCKED`.
- A local production server was started only with providers disabled and an
  intentionally unreachable database. The login route rendered the generic
  service-unavailable state, correctly demonstrating that a database-backed
  browser journey cannot be claimed without PostgreSQL. It was stopped after
  the check.
- Local ports used for preview were released after validation. Docker's daemon
  was unavailable, so the owned readiness Compose stack could not be started.

## Safety boundary

The repository `.env` contains user-managed real-provider configuration and no
isolated test database. The aggregate verifier's provider preflight therefore
refused to run as designed. Individual provider-free gates were run directly;
the `.env` was not changed. There was no live-provider run manifest because no
live side effect was authorized in this request.
