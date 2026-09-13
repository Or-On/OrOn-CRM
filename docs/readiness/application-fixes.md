# Application readiness fixes — isolated candidate

Date: 2026-09-12. Scope: APP-001, APP-002, APP-003/004 admission safeguards, SEC-004 and the real-PostgreSQL retained-user-model regression. These changes exist only in `.artifacts/readiness/candidate`; they have not been promoted to the live checkout. The live development runner, real queues, provider settings and upstream repositories were not touched.

## Changes

### APP-001 — contact records survive optional voice outages

The contact page preserves its tenant-authorized CRM reads independently of the optional voice-flow request. Voice transport has a 1,500 ms timeout. Failed/unavailable/forbidden voice reads render the contact with an explicit unavailable notice and disabled calling; contact editing remains available. Authentication expiry still redirects, CRM permission denials still show access denied, and CRM/database failures are not disguised as empty contact data.

Changed files:

- `apps/web/src/app/contacts/[id]/page.tsx`
- `apps/web/src/features/contacts/contact-detail-panel.tsx`
- `apps/web/src/i18n/messages/en.json`
- `apps/web/src/i18n/messages/he.json`
- `apps/web/tests/contact-page-resilience.test.tsx`
- `apps/web/tests/form-recovery.test.tsx`

### APP-002 — truthful partial contact imports

Each CSV row runs in a PostgreSQL savepoint. Counters advance only after that row completes. Recognized validation/constraint errors roll back the row and return a fixed, PII-safe diagnostic; permission errors, connection failures, deadlocks and unexpected errors fail the entire import rather than returning misleading success. Duplicate recipients retain their current consent/opt-out state. No database error text or source row content is returned.

Changed files:

- `packages/ts/crm/src/contacts.ts`
- `packages/ts/crm/src/contact-creation-policy.test.ts`
- `packages/ts/crm/src/contact-creation-policy.postgres.test.ts`

### SEC-004 — top-up keys are bound to immutable financial requests

Atomic `ON CONFLICT ... DO UPDATE ... WHERE` compares amount, currency, provider, requesting user and expected Stripe customer before replaying the stored row. Reusing a tenant-scoped key with different data returns conflict without opening provider checkout. The API passes the stored amount/currency to checkout, after the admission transaction has ended. The expected customer comes from the tenant billing profile, not the browser. Customer binding depends on security successor `74e4f347dbbd` owned by the separate security workstream; no migration is authored by this workstream.

The returned checkout session is bound only once: identical reattachment is idempotent, while replacement with a different provider session is refused. After the external checkout request, attachment rechecks the current authorization and pins the original tenant, user and session rather than trusting the earlier admission. Unit/API tests cover revocation/identity drift; real PostgreSQL tests cover immutable session attachment and concurrent idempotency.

Changed files:

- `packages/ts/crm/src/billing.ts`
- `apps/web/src/app/api/billing/topups/route.ts`
- `packages/ts/crm/src/billing-idempotency.test.ts`
- `packages/ts/crm/src/billing-idempotency.postgres.test.ts`
- `apps/web/tests/billing-topup-route.test.ts`

### Retained model parity

The existing `public.users` avatar migration already added nullable BYTEA, TEXT and TIMESTAMPTZ columns. The retained SQLModel now represents those columns without changing migrations, IDs, authentication DTOs or image validation. A model unit test verifies exact SQL types and absent-image defaults. This is a target-owned compatibility adaptation of `packages/py/oron-tenancy/src/oron_tenancy/models.py`, originally preserved from locked Or-on source; no new upstream code was copied. Existing source/license notices remain intact.

Changed files:

- `packages/py/oron-tenancy/src/oron_tenancy/models.py`
- `packages/py/oron-tenancy/tests/test_users_models.py`

## Regression evidence

### APP-003/004 — simulation cannot masquerade as staging execution

Web simulation actions now require the exact explicit setting `PLATFORM_ENV=development`. Production, staging, test and absent values refuse with HTTP 403 / `simulation_disabled` before persistence. The real Meta admission route is unchanged when `provider=meta`; voice/canonical real routes are untouched. Legacy empty automation responses in development explicitly identify `mode=simulator` and `noOp=true`. This prevents new simulation writes through these web entrypoints; it does not delete or reclassify historical data. Existing simulated analytics mixing is still a tracked limitation. The worker workstream separately gates execution of prequeued simulation jobs.

Additional changed files:

- `apps/web/src/features/simulation-policy/index.ts`
- `apps/web/src/app/api/campaigns/route.ts`
- `apps/web/src/app/api/campaigns/[id]/deliver/route.ts`
- `apps/web/src/app/api/orchestration/simulate/route.ts`
- `apps/web/src/app/api/orchestration/flows/[id]/simulate/route.ts`
- `apps/web/src/app/api/automations/[id]/run/route.ts`
- `apps/web/src/app/api/messaging/conversations/[id]/messages/route.ts`
- `apps/web/src/app/api/messaging/simulate/inbound/route.ts`
- `apps/web/src/app/api/voice/simulated-calls/route.ts`
- `apps/web/tests/simulation-deployment-policy.test.ts`
- `apps/web/tests/orchestration.test.tsx`
- `apps/web/tests/whatsapp-api.test.ts`

### Browser-discovered layout defects

Real production-build browser inspection found a settings account grid extending87px beyond a1440px viewport and an Overview tablet chart compressed into an implicit grid column. `apps/web/src/app/workspace-details.css` corrects the account grid minimum widths. `apps/web/src/app/studio-replica.css` restores full-width automatic rows for all five Overview cards at the existing62rem mobile-shell breakpoint. Inbox visuals and behavior are unchanged.

The isolated screenshot harness `scripts/capture_ui_preview.mjs` adds an eight-scenario readiness matrix (EN/HE, light/dark, 1440/390) plus a targeted768px tablet case, includes `/tenants`, records navigation timings, and refuses browser network requests outside its two owned loopback origins. `scripts/verify_workspace_ui_preview.mjs` updates a stale chart selector while retaining its exact14-day, keyboard and accessible-table assertions, and records failure screenshots. New `scripts/verify_contact_outage_preview.mjs` requires the isolated voice service to be stopped and verifies actual HTTP200 contact rendering, disabled calling, localized warning, editable core data and no overflow without submitting mutations.

All commands below run from the isolated candidate with pinned Node 24.20.0 and no `.env` or live provider credentials.

| Check | Result |
| --- | --- |
| `pnpm --filter @or-on/crm exec vitest run src/contact-creation-policy.test.ts src/billing-idempotency.test.ts` | PASS: 19 tests |
| `pnpm --filter @or-on/web exec vitest run tests/contact-page-resilience.test.tsx tests/form-recovery.test.tsx tests/billing-topup-route.test.ts` | PASS: 25 tests; provider and transport mocked |
| `pnpm --filter @or-on/crm test` without a database URL | PASS: 70 unit/static tests; 17 PostgreSQL tests explicitly skipped, not validated by mocks |
| `pnpm --filter @or-on/crm typecheck` | PASS |
| `pnpm --filter @or-on/web typecheck` | PASS: route generation and TypeScript |
| ESLint for all 12 changed TS/TSX source/test files | PASS, zero warnings after correcting test-only lint findings |
| Prettier for changed TS/TSX/JSON files | Formatted |
| `uv run --no-sync pytest -p no:cacheprovider -q packages/py/oron-tenancy/tests/test_users_models.py` | PASS: 11 tests |
| Ruff check and format check of both changed Python files | PASS |
| `uv run --no-sync pyrefly check packages/py/oron-tenancy/src/oron_tenancy/models.py` | PASS: zero errors; 7 pre-existing suppressions |
| `uv run --no-sync python scripts/preview_ui.py --check-db` against separate cluster localhost:55439 | PASS final rerun: 88 tests, 19 files; one legacy alternate-DB test skipped. Fresh UUID database migrated through `74e4f347dbbd`; real CSV savepoint recovery, committed/concurrent billing idempotency and immutable checkout binding verified. Owned DB/login removed automatically |
| Simulator deployment/API regression suite plus existing WhatsApp/orchestration tests | PASS: 42 tests; staging/production/missing/test fail closed, explicit development allowed, real Meta path preserved |
| ESLint for additional simulator source/test files and screenshot harness | PASS, zero warnings |
| Retained-model real PostgreSQL parity suite | PENDING main-agent rerun |
| `pnpm --filter @or-on/web... build` | PASS: all 6 packages; Next compiled20.4s, TypeScript6.1s. BUILD_ID `aOiaZeUDtlGcNCPcHkEKa` |
| Final focused web regressions (`studio-replica-contract`, `form-recovery`, `billing-topup-route`, `simulation-deployment-policy`, `contact-page-resilience`) | PASS:78 tests |
| Final CRM billing idempotency unit suite | PASS:9 tests |
| Final `pnpm --filter @or-on/web build` after CSS and checkout safeguards | PASS: BUILD_ID `k31ud0-n3liKDZ9DtRJ2r`; compilation5.3s, TypeScript4.5s. A preceding build caught a shared BodyInit type regression, fixed by the security workstream before this successful rerun |
| Final ESLint for all three changed browser scripts | PASS |
| Production-build browser interactions | PASS:25/25 checks across1440/1024/768/390/360, EN/HE, light/dark; optional voice outage2/2 pass.85 indexed page/tab screenshots across31 URLs, plus2 outage screenshots; no horizontal overflow. Sampled images inspected visually; exact builds and limits in `ui-verification.md` |

## Remaining risks and boundaries

- Optional voice timeout applies to the transport request; normal authentication/tenant admission retains its existing database timeout behavior.
- Top-up code must deploy with the successor that adds `expected_customer_id`. Legacy unbound pending top-ups require explicit reconciliation; this change never assigns a customer retrospectively.
- No real Stripe checkout, WhatsApp message or telephone call occurred. Mock tests prove orchestration only, never PostgreSQL rollback/locking behavior.
- Browser testing ended and owned preview database, login and process trees were removed. Ports3100/3101/3102 were no longer listening. The live developer database, runner and `.env` remained untouched.
- The final security workstream added authorization-lock successor `bfb741c767fd` after browser validation. These browser results apply to the stated build through74e, not an untested later build. The root workstream owns the final full verification with the new head.
- Other findings in `application-inventory.md` remain separately tracked; these bounded fixes do not imply entire-platform readiness.
