# Execution baseline

Captured 2026-09-15 in `C:\Users\almo9\Or-On-Integration\OrOn-Platform` and
reconciled after the authorized GitHub/DEV release. No secrets or customer
records are included in the identifiers below.

## Repository identity

| Item | Observed value |
| --- | --- |
| Target remote | `https://github.com/Abssel-AI/OrOn-CRM.git` |
| Branch | `main` |
| Initial HEAD | `a7d18bc7bf937154af9d120fede61355a0a09271` |
| Initial working tree | 75 unstaged tracked paths, 87 untracked paths, no staged paths |
| First candidate commit | `18009d089210591d402f542e0f10e61c847956ba` |
| Validated implementation commit | `d5cead92603ac6118968f609edd9344efec5fa73` |
| Release-image preload follow-up | `15f82a2b4059594f850f849aff7c58a19ed86ca3` |
| Successful CI/deployment run | `34927297654` — all seven jobs passed |
| Implementation source files | 1,196 tracked/untracked, non-ignored files; `.env*`, `.artifacts` and this evidence directory excluded |
| Corrected implementation snapshot SHA-256 | `8eb27ea00b90c6f2474617ccb505a98bdfba254214c8b37833dc2388ab072fcb` |
| Initial tracked implementation diff SHA-256 | `fa0fb5588f0f5fd86016cb5fb2a5979643a00671ec892ac809cd40f09f082b47` |
| Read-only source reference | `https://github.com/Abssel-AI/Brimag.git`, `main`, `08228541cf0ccf7f65eb8517ec9c5346c29f280f` |

The implementation snapshot hashes a sorted manifest of paths and Git blob IDs
while excluding this self-referential evidence directory. The initial audit
preserved the dirty tree. At the user's later direction it was committed and
pushed. Repeated disposable CI runs exposed and then verified fixes for invalid
rendered SQL, migration teardown/RLS dependencies, worker-poll assumptions and
same-second WhatsApp ordering. A later evidence-only rollout exposed that
profiled one-shot images were not included in the default Compose pull. Enabling
those profiles still omitted the migrator on the actual host, so the final
release follow-up explicitly pulls all five immutable application references
before inspecting digests or touching the active release. No reset, clean or
shared-database mutation was performed locally.

## Toolchain and locks

| Tool | Observed | Repository requirement / note |
| --- | --- | --- |
| Git | 2.54.0 | available |
| Node.js | 25.9.0 | **unsupported locally**; repository requires `>=24.20.0 <25` |
| CI Node.js | 24.20.0 | supported; full pnpm gates and image builds passed |
| pnpm | 11.24.0 | lockfile `pnpm-lock.yaml` |
| Python | 3.14.7 | repository requires `>=3.14,<3.15` |
| uv | 0.12.7 | lockfile `uv.lock` |
| Docker client | 29.7 | daemon unavailable on this workstation |
| GNU make | unavailable | canonical commands were invoked directly |

Node 25 emitted an engine warning for every local pnpm command. Those local
results are retained, while GitHub Actions supplied the required supported Node
24.20.0 verification and release build.

## Database and migration state

| Check | Observation |
| --- | --- |
| Alembic bases | `0001` |
| Alembic heads | exactly one: `b72c5f0e4d91` |
| Revision count | 68 total; 22 Or-On revisions |
| Offline schema contract | PASS |
| Offline SQL | 372,669 bytes; SHA-256 `83a2cfbbd09c33f39d5abbc3fc41e9fb0a40e4c8667c238d4f327f796fb507f4` |
| Local PostgreSQL | unavailable on checked ports; no explicit isolated `TEST_DATABASE_URL` |
| Online migration/RLS suite | PASS — PostgreSQL 18.6; 128 passed, 3 explicitly environment-gated skips |
| Provider-free cross-channel acceptance | PASS — 13 passed against isolated PostgreSQL |
| Deployed DEV schema | PASS — upgraded from `91bd6f76a3e4` through `a26f09c4d13e` to `b72c5f0e4d91` |

CI applied the entire migration chain to an owned disposable database and ran
runtime-role/RLS coverage. The authorized DEV deployment created a pre-migration
backup and applied both new revisions. No local application database was
repointed for tests.

## Runtime and deployment observation

- GitHub Actions deployed exact source `d5cead92603ac6118968f609edd9344efec5fa73`
  using five digest-pinned images and a checksum-bound release archive. Remote
  verification reported PostgreSQL, control API, web, Caddy, dispatcher and
  messaging worker healthy.
- Independent checks after deployment observed HTTP root `308`, HTTPS login
  `200`, and protected health `401` without authentication.
- No disposable ordinary-role DEV credentials were used, so authenticated
  owner/admin/agent/technician/viewer and second-tenant browser acceptance
  remains `BLOCKED`; this is not conflated with deployment success.
- A local production server was started only with providers disabled and an
  intentionally unreachable database. The login route rendered the generic
  service-unavailable state, correctly demonstrating that a database-backed
  browser journey cannot be claimed without PostgreSQL. It was stopped after
  the check.
- Local ports used for preview were released after validation. Docker's daemon
  was unavailable, so the owned readiness Compose stack could not be started.

## Safety boundary

The repository `.env` contains user-managed real-provider configuration and no
isolated local test database. The aggregate local verifier's provider preflight
therefore refused to run as designed. CI supplied an isolated database and kept
all real-provider flags disabled. The `.env` was not changed, and deployment did
not authorize or execute a real message, call, payment, OAuth, OCR or calendar
side effect.
