# Bilingual UI acceptance record

Date: 2026-09-03. Branch: `codex/phase-7-ui-polish`.
Brief baseline: `0408d5274af3c181aef32ec79352abfba1ed14be`.
Status: **working bilingual implementation; expanded Phase 7 acceptance partial**.
This is not a production-readiness, feature-parity or accessibility certification.

## Implemented experience

Public `/en` and `/he`, existing-account login/access guidance, `/start`, localized
Overview, Inbox, contact list/detail/forms/import, multi-board pipelines,
campaigns, agents/flows/handoffs, retained voice/call/campaign/flow views, settings,
health, errors/loading/empty/permission/offline states. Working APIs, tenant
transactions and provider confirmation boundaries remain in place.

## Executed automated checks

| Check | Evidence |
| --- | --- |
| Toolchain | Pinned Node 24.20.0, pnpm 11.24.0, Python 3.14.7 |
| `pnpm lint`, `pnpm format:check` | Passed after resolving issues; no ignored type/lint errors introduced |
| `pnpm typecheck` | All workspaces passed; final affected web typecheck passed after later refinements |
| `pnpm test` + final affected web rerun | 122 default TS tests in total: 42 web and 80 other workspace tests; 16 explicitly live tests not run by the default command |
| Web interaction coverage | Locale/draft preservation, real-send refusal/confirmation, stale-thread abort, recovery, read-only roles, actual provider mode, partial CSV feedback and typed custom field values |
| Locale contracts | Matching EN/HE keys and ICU arguments; every pattern formatted; native validation; public path/cookie/header selection; safe errors; exact decimal/currency formatting |
| `uv run --no-sync pytest -p no:cacheprovider` | 645 passed, 58 explicitly separated live/provider checks skipped, five warnings; no skipped test reported as passed |
| Ruff / Pyrefly | Full selected Python paths pass (Pyrefly retains existing suppressions); changed preview script and six safety tests rerun |
| `uv run --no-sync python scripts/preview_ui.py --check-db` | Real owned PostgreSQL database migrated to current head; 25 CRM tests pass as a non-superuser platform_web member, one unrelated fixture-dependent test remains skipped |
| SQL regression | 303-message keyset/microsecond history, sender projection, counts, tenant isolation and empty/canonical/unsupported flow classification pass |
| `pnpm contracts:check` | Generated OpenAPI/client/event artifacts fresh |
| `uv run --no-sync python scripts/db_verify.py offline` | 39 revisions, one head `50a6befe7903`, 22 preserved Or-on revisions; deterministic SQL/static contract pass |
| `pnpm build` | Every package/service and Next.js 16.3.3 production build pass; no new migration |
| Dependency checks | `pnpm peers check` passes; npm audit reports no known vulnerabilities |
| Python audit | No unexcepted findings; existing `PYSEC-2026-3740` exception expires 2026-09-09; private workspace packages are not registry-auditable |
| Guards | Repository/PostgreSQL-only/Alembic-only/sibling-independence, documentation links, tracked-and-new-file secret scan pass |

Next production compilation reported approximately 5.1 seconds and TypeScript
4.8 seconds on this host. These are **build timings**, not page latency, Core Web
Vitals, a Lighthouse score or field performance evidence.

## Browser evidence

Used the in-app browser against the owned localhost preview only. Authentication
used the user-approved fictional account, not developer/customer credentials.

- English/Hebrew public routes, localized titles, body copy and interactive
  controls; public language switching tested in development and built output.
  A real shared-layout cache issue was fixed with public document navigation.
- Hebrew desktop login, Overview, Inbox, contacts, pipeline, settings,
  orchestration and first-use guide inspected. Production fictional sign-in and
  mobile account/navigation controls inspected as well.
- Dark/light surfaces, desktop 1440×900, mobile 390×844 and public tablet
  768×1024 visually inspected. Minimum 320px testing found an inherited 20rem
  document minimum that ignored scrollbar width; removed rather than hiding overflow.
  The rebuilt 320px Hebrew page reports `clientWidth = scrollWidth = 305`
  (the remaining 15px is the browser scrollbar), confirming the correction.
- Workspace EN↔HE switch preserved an unsent Inbox draft. Mobile list/thread
  navigation, real-provider-disabled labelling, phone/code direction and reply
  counter were checked. A language change never queued or sent a message.
- Hebrew command search, Enter navigation, native Escape close, search autofocus
  and compact desktop rail inspected. Public workflow tabs support direction-aware
  arrow keys, Home/End and explicit selected/tab-panel relationships.
- Sample English customer names, stage names, notes/tags and provider/template
  identifiers remain authored data, not untranslated UI. No customer screenshots
  or real provider data were used.

## Still required before declaring Phase 7 complete

1. Complete all route combinations at 320/390/768/1024/1366/1440 and wide desktop,
   both themes/locales, zoom/text scaling and reduced motion. Representative
   inspection above is not the entire Cartesian matrix.
2. Screen-reader validation, measured contrast and full focus-order/keyboard
   regression, including long dialogs and all management forms.
3. Three clean-session **full** fictional rehearsals covering recorded voice call,
   durable follow-up, human handoff, tenant switch and revoked permissions. The
   focused UI preview starts no consumers; queued simulator work stays queued.
4. Browser production performance measurements with an appropriate approved
   profiling surface. Do not substitute tool round-trip or build times.
5. Cross-route unsaved-form warnings, richer custom-field choice catalogs and
   larger representative datasets remain refinements. Current failed-form and
   in-place locale recovery are implemented and tested, not universal draft saving.

## Safety and preview operation

Use the [isolated preview runbook](local-development.md#isolated-ui-review-phase-7).
`--production` serves existing `pnpm build` output without hot reload. The tool
forwards no provider secrets, sets all real-provider flags false and points control
API requests at an unavailable local endpoint. Voice/system health correctly show
unavailable in this focused web-only preview. No developer control API or queues
are used. The ordinary configured platform retains its working API connections.

The developer `.env`, login and queues were not modified. No WhatsApp message,
telephone call, webhook/resource mutation, provisioning or Terraform action was
performed. All three upstreams remain clean at their locked commits. No upstream
source was copied for this redesign.

Forced process termination can bypass preview cleanup. New temporary login files
also record their exact owned database and login-role names for operator recovery.
Never delete databases/roles using prefix globs: identify the stopped run first.
An interrupted earlier preview database was removed only after matching its
fictional credential and verifying no sessions; an unrelated older preview was
preserved. Legacy orphan login roles were not guessed or removed.
