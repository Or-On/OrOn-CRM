# Validation commands and results

Executed 2026-09-15 against the safe source snapshot recorded in
[Baseline](baseline.md). Commands ran from the repository root. Skips are
reported, not counted as passes.

## Passing gates

| Command | Result |
| --- | --- |
| `pnpm format:check` | PASS — all configured TypeScript/React/YAML files use Prettier style |
| `pnpm lint` | PASS — Next route types generated; ESLint zero warnings/errors |
| `uv run ruff format --check packages/py services/py db scripts` | PASS — 408 scoped Python files formatted |
| `uv run ruff check packages/py services/py db scripts` | PASS — zero lint errors |
| `pnpm typecheck` | PASS — all 11 applicable TypeScript workspaces |
| `uv run pyrefly check <scripts/dev.py PYTHON_TYPE_PATHS>` | PASS — 0 errors, 33 suppressions, 12 unshown warnings |
| `pnpm test` | PASS — **977 passed, 69 skipped** across package, worker and web Vitest suites |
| `uv run pytest -p no:cacheprovider` | PASS — **1,065 passed, 133 skipped, 5 warnings** in 32.45 s |
| `pnpm build` | PASS — all packages/workers and Next.js 16.3.3 production application; static page-data generation completed for 75 build units |
| `pnpm contracts:check` | PASS — generated OpenAPI/client/contracts match current tracked contract state |
| `uv run python scripts/db_verify.py offline` | PASS — one head, 68 revisions, schema contract and deterministic offline SQL |
| `pnpm peers check` | PASS — no peer dependency issue |
| `pnpm audit --audit-level critical` | PASS — no known vulnerability returned |
| `uv run python scripts/pip_audit.py` | PASS WITH EXCEPTION — no unexcepted known vulnerability; one time-bounded exception through 2026-10-13 |
| `wsl bash -n scripts/deploy-dev.sh scripts/backup-dev.sh` | PASS — shell syntax |
| `pnpm --filter @or-on/web test -- private-objects customer-document-permissions field-service-attachment-download` | PASS — 11 focused upload/authorization/header regressions |
| `pnpm --filter @or-on/web test -- oauth-disconnect-route oauth-disconnect tenant-product-workspaces` | PASS — 19 focused OAuth lifecycle/UI tests |
| `uv run pytest -p no:cacheprovider scripts/tests/test_deployment_release.py scripts/tests/test_db_verify.py` | PASS — 19 focused release/database-contract tests |
| `uv run pytest -p no:cacheprovider scripts/tests/test_deployment_release.py` after release hardening | PASS — 12 focused release tests |
| GitHub Actions CI `34927297654` on Node 24.20.0 / Python 3.14.7 | PASS — TypeScript, Python, contracts, architecture/security, PostgreSQL/Alembic and all five container builds |
| CI PostgreSQL 18.6 migration/RLS suite | PASS — 128 passed, 3 explicit readiness-environment skips |
| CI isolated messaging diagnostic | PASS — 4 passed; provider HTTP mocked |
| CI isolated WhatsApp → AI → call acceptance | PASS — 13 passed; PostgreSQL real, provider HTTP/calls mocked |
| CI `Deploy GCP DEV` | PASS — backup, migrations, exact five-image/source verification, service health and public endpoint checks |

Vitest passed-test total is the sum of runner results: API client 4, config 13,
contracts 2, auth 48, CRM 104, observability 1, platform integration 1, UI 37,
live agent 4, messaging worker 228 and web 535. Skips are CRM 38, messaging
worker 30 and web 1.

## Explicitly skipped or unavailable

| Boundary | Count / result | Reason |
| --- | --- | --- |
| Python real PostgreSQL/RLS/provider eval | 133 skipped | No explicit owned `TEST_DATABASE_URL`; no LLM evaluation credentials/endpoint |
| CRM PostgreSQL Vitest files | 38 skipped | `TEST_DATABASE_URL` absent |
| Messaging-worker PostgreSQL/live-named simulations | 30 skipped | Dedicated guarded cross-channel/readiness DB URL absent |
| Web optional test | 1 skipped | Environment-gated by the suite |
| Separate-destination restore | **BLOCKED** | CI proved migration/downgrade behavior and DEV created a backup, but a complete off-host restore drill was not authorized |
| Browser authenticated acceptance | **BLOCKED** | Exact release identity is proven, but no disposable ordinary-role DEV credentials were supplied |
| Real Meta/voice/OAuth/OCR/Stripe | **BLOCKED** | No authorized run manifest or controlled external fixtures |
| Container advisory scan | **BLOCKED** | Five exact images built, published and started healthy; no registry vulnerability scanner result was available |

## Warnings and failures encountered

- Every pnpm command warned that Node 25.9.0 is outside the declared
  `>=24.20.0 <25` engine. This is an environment blocker, not hidden.
- `uv run python -m scripts.dev typecheck` refused at its safety preflight
  because the user-managed `.env` enables four real-provider flags. The
  environment was not edited; the provider-free `pnpm typecheck` and exact
  Pyrefly command were run separately and passed.
- Final lint reconciliation caught an await-free async mock in the OAuth
  disconnect route test. The mock was made synchronous, its focused test
  passed, and the full lint and 977-test TypeScript suite were rerun.
- The first online CI migration attempt exposed four inline Python lint comments
  rendered as PostgreSQL statements. The comments were removed and the offline
  validator now rejects any line that begins with a Python-style `#` comment.
- The next CI run upgraded to the new head and then exposed downgrade ordering,
  a polymorphic fixture parameter and a cross-role RLS policy dependency. The
  teardown was reordered, the fixture was typed, and object access was moved
  behind a tenant-bound security-definer predicate so the voice role does not
  receive direct field-service table privileges.
- Cross-channel CI then exposed a test that assumed one queue item per worker
  poll and duplicate latest-message queries that broke when several Meta events
  shared a one-second provider timestamp. The test now drains work until idle;
  trigger, callback and case-evidence ordering consistently use provider time,
  database ingestion time and UUID only as a final tie-breaker. The deterministic
  same-second scenario and all 13 cross-channel cases pass on PostgreSQL.
- A later documentation-only candidate passed all six build, test, database and
  container gates, then its DEV rollout found that default `compose pull`
  omitted the profiled migrator image on a clean host. Rollback preserved the
  previously healthy release. Enabling those profiles still omitted the
  migrator on the actual host, so deployment now explicitly pulls each of the
  five validated immutable references before revision inspection; shell syntax
  and all 12 release tests pass.
- That retry also proved CI was invoking the previously installed host deployer,
  not the corrected copy packaged in the candidate archive. The handoff now
  transfers the checked-out deployer separately, verifies its SHA-256 on the
  host and executes that exact copy. Regression coverage forbids the stale
  `/opt` deployer entrypoint while preserving archive checksum and exit status.
- With the candidate deployer active, all five images pulled, backup and Alembic
  completed, and every container became healthy. The VM's public-IP hairpin probe
  alone could not connect and correctly triggered rollback. The in-host probe now
  uses loopback with the real TLS hostname, while CI keeps the independent public
  HTTP/HTTPS check; the new release regression covers both boundaries.
- The first focused lint after adding strict UTF-8 validation caught one missing
  error `cause`; it was fixed and the full lint/type/build/test gates were rerun.
- A first production build during implementation exposed a client import through
  the CRM server root; a browser-safe subpath fixed it. The final clean build
  above passed.
- Two intermediate Turbopack cache panics occurred while overlapping build/type
  generation during implementation. Build was then run alone from a clean
  generated state and passed; no product pass is based on the panicked attempts.
- Pytest warnings: one Pipecat deprecation, Google GenAI internal type
  deprecation, Starlette/httpx deprecation and two intentionally short JWT test
  key warnings. Production credential validation requires stronger keys.
- An incorrectly scoped Ruff command named two nonexistent directories and
  returned path errors. It was replaced with the exact `scripts/dev.py` Python
  path lists; the canonical commands passed.

## Offline database artifact

`scripts/db_verify.py offline` reported:

- base `0001`, one head `b72c5f0e4d91`;
- 68 revisions total, 22 Or-On revisions;
- 372,669-byte PostgreSQL upgrade SQL;
- SHA-256 `83a2cfbbd09c33f39d5abbc3fc41e9fb0a40e4c8667c238d4f327f796fb507f4`.

Offline generation validates graph/contract/static SQL safety. GitHub Actions
separately proved the upgrade, downgrade, grants, functions, triggers and RLS on
PostgreSQL 18.6; it does not replace the still-required restore drill.

## Reproduction order

Use supported Node 24 and an owned isolated PostgreSQL 18.6 instance, keep real
providers disabled, then run:

```powershell
pnpm install --frozen-lockfile
uv sync --frozen --group voice
uv run python -m scripts.dev lint
uv run python -m scripts.dev typecheck
uv run python -m scripts.dev test
pnpm contracts:check
uv run python scripts/db_verify.py offline
$env:TEST_DATABASE_URL = '<owned disposable PostgreSQL 18.6 URL>'
uv run python -m scripts.dev db-verify-live
pnpm build
pnpm peers check
pnpm audit --audit-level critical
uv run python scripts/pip_audit.py
```

Do not point live-named worker tests or restore/migration rehearsals at the
application database.
