# Frontend excellence pass — September 2026

Historical record: the subsequent application-only request removes the landing
page and adopts the or-on.io visual direction. The stale CRM build blocker below
was resolved after the normal worker was stopped. Current implementation and
verification: [application UI rebuild](application-ui-rebuild-2026-09-08.md).

## Scope and decisions

The newest user request authorizes a complete frontend redesign, superseding the
earlier landing-only restriction. Work is local to `OrOn-Platform` on the existing
`codex/phase-7-ui-polish` branch. Its pre-existing dirty worktree is preserved.
The referenced workspace `BOOST.md` could not be found; root/scoped `AGENTS.md`
and `MASTER_PROMPT.md` apply.

The Next.js application is the single public/product frontend. Server routes and
BFF handlers use the existing authentication, permissions, tenant transactions,
CRM PostgreSQL repositories and Python voice API. Durable messaging workers and
provider adapters remain separate processes. No backend rewrite, migration,
provider operation, environment change, dependency upgrade or deployment belongs
to this pass. OpenLive remains deferred.

Critical paths: public navigation → login → organization-scoped overview;
customer search/detail/edit; conversation selection/filter/reply; deal stage
movement; campaign/automation inspection; agent/flow inspection; voice and system
unavailability; settings and logout. Real delivery stays explicitly labeled,
flag-gated and confirmed. No decorative statistics may replace actual metrics.

Design: neutral black/charcoal, restrained steel-blue accents, self-hosted
Geist/Noto Sans Hebrew, content-led layouts, compact navigation, readable data
rows, intentional empty states, English/LTR and Hebrew/RTL. The public Gateway
Flow visual is retained as an approved asset; surrounding composition is new.
Animation explains transitions and honors reduced motion. No invented customer
logos, testimonials, business outcomes or integration availability.

## Scorecard

These are acceptance criteria, not subjective numerical scores. Final evidence
is recorded below; an unexecuted gate is not a pass.

| Category | Baseline / risk | Target and planned change | Verification | Final result / remaining risk |
| --- | --- | --- | --- | --- |
| Product correctness | Working mutations with dense, inconsistent surfaces | Preserve routes, CSRF, confirmations, drafts, filters, keyboard moves; simplify presentation | Web/component suites and isolated browser journeys | 98 web tests pass; fictional contact creation, reply queue and persisted stage change exercised. Overview runtime gate pending shared rebuild. |
| Security, privacy, integrity | Real messaging can be enabled in developer environment | Use only fictional isolated preview; retain simulator default and explicit approval | Provider-control tests, auth/CRM regression tests, secret/architecture guards | Auth 20, config 10, CRM 38 pass; one CRM live test skipped. No real provider operation. |
| Backend/API | Existing feature BFF + PostgreSQL + Python voice boundary | Preserve public payloads, endpoint semantics, permissions and tenancy | Existing API tests; no backend changes | No API/schema changes. Stale existing CRM dist must be rebuilt before overview browser acceptance. |
| Frontend UX | Layered design passes; repeated cards, engineering copy | New public story, new shell/overview/login, consistent feature surfaces and bilingual copy | Desktop/mobile/RTL direct observation | Public, inbox, contacts, pipeline, settings inspected; final overview and post-fix compact inbox inspection pending. |
| Accessibility | Very small supporting text; native summary test mismatch | Readable control labels, focus/keyboard/RTL preserved, semantic progress, reduced motion | Component regressions, keyboard/viewport inspection | 11 UI tests pass including dark/light semantic-color contrast. Keyboard menu, command search and settings tabs exercised; not certification. |
| Reliability/observability | Existing error boundaries and safe diagnostics | Preserve errors and unavailable states; remove misleading technical copy | Failure-state tests and isolated unavailable voice preview | Four new health tests cover malformed responses/retry/degraded readiness. Unavailable services remain unavailable, never fabricated healthy. |
| Performance/resources | No comparable before/after trace captured | No new dependencies; fewer overlapping marketing rules; bounded animations | Production build and direct browser observation | No speedup claim; formal CWV benchmarking deferred |
| Architecture/maintainability | Shared tokens plus domain-owned styles | Consolidate public styles, reuse controls, preserve public feature APIs | Lint/typecheck/build, diff review | Scoped ESLint, strict types and production build pass. No dependencies added in this pass. |
| Repository organization | Monorepo already has coherent domain ownership | Keep files within owning feature; no cosmetic package moves | Changed-file review | No repository-wide rearrangement needed |
| QA/regression | Web baseline: 84 passing, 3 failing tests plus one failed import suite; UI 7 passing | Fix font mock, native summary queries, missing translation; add meaningful primitive tests | Web/UI suites | Final web 98/98 and UI 11/11. Existing failures fixed; safety assertions retained. |
| DX/CI/documentation | Seven focused lint errors; host Node 25.9.0 outside configured Node 24 range | Fix scoped lint errors without weakening rules; record reproducible checks | Format/lint/typecheck/build and this record | Scoped checks pass. Secret scanner now handles tracked worktree deletions without skipping remaining files; 4 Python tests pass. Node warning remains. |

## Baseline evidence

- `pnpm --filter @or-on/web test`: 84 passed, 3 failed; public-layout suite
  could not import `Geist` because its font module mock was incomplete.
- CRM workspace failures queried native `summary` as a button in jsdom; the
  native disclosure and keyboard stage select are implemented.
- Voice test failed because `voice.eligibleAudience` was absent.
- `pnpm --filter @or-on/ui test`: 7 passed.
- `pnpm exec eslint apps/web packages/ts/ui --max-warnings 0`: 7 errors,
  including unused icons, optional/numeric interpolation, array style, button
  boolean handling, and the UI Vitest config missing from its TS project.
- Docker Engine 29.7.2 responds. The safe preview helper successfully created
  and cleaned up its own fictional database; initial dev preview could not start
  while another Next dev instance owns `apps/web/.next/dev/lock`. The user process
  was left untouched. Use the production preview after the build.

## Verification evidence

| Command / gate | Final observed result |
| --- | --- |
| `pnpm --filter @or-on/web --filter @or-on/ui test` | PASS: web 98 tests / 23 suites, UI 11 tests / 2 suites |
| `pnpm exec eslint apps/web packages/ts/ui --max-warnings 0` | PASS |
| `pnpm --filter @or-on/ui --filter @or-on/web typecheck` | PASS |
| `pnpm exec prettier --check apps/web packages/ts/ui --ignore-unknown` | PASS |
| `pnpm --filter @or-on/web build` | PASS: Next.js 16.3.3 production compilation, typing and route generation; does not rebuild transitive workspace dist |
| `pnpm --filter @or-on/ui build` | PASS |
| `pnpm --filter @or-on/auth --filter @or-on/config test` | PASS: 20 auth + 10 config tests |
| `uv run --no-sync python scripts/preview_ui.py --check-db` | PASS: 38 CRM tests; 1 explicitly skipped live case requiring a separate database test variable; owned database removed |
| `uv run --no-sync pytest scripts/tests/test_secret_scan.py -q -p no:cacheprovider` | PASS: 4 tests |
| Ruff check/format of changed scanner and its tests | PASS |
| `scripts/check_repository.py`, `scripts/check_secrets.py`, `scripts/check_docs.py` | PASS before final documentation update; documentation rechecked below |
| `pnpm audit --audit-level high` | PASS: no known vulnerabilities reported at execution time |
| `git diff --check` | PASS |
| Upstream status/SHAs | All three clean at locked SHAs; no edits |
| Browser preview | Partial acceptance, detailed below |

The production preview uses `scripts/preview_ui.py --production`, its own
PostgreSQL database and fictional account, and no worker. It was stopped after
inspection; the helper removed its own database, login and temporary credential
artifact. No customer data or developer queues were changed. No message was sent
externally: one simulated reply was queued only in the disposable database.

Observed browser journeys:

- Public English desktop (1440px), Hebrew compact (390px override / 375px content)
  and no horizontal overflow in the compact public layout.
- Mobile navigation opens/closes; Hebrew sign-in reaches authenticated shell.
- Hebrew mobile conversation opens with simulator selected and real delivery
  disabled; a simulated reply queues successfully through the existing endpoint.
- Language switch preserves navigation; English customer validation rejects a
  missing required phone, then creates a fictional contact successfully.
- A fictional deal moves through the accessible select and remains in the new
  stage after reload. Dark and light pipeline layouts inspected.
- Settings tabs respond to arrow keys. Command search and keyboard selection
  navigate to Contacts. Voice/core-service failures render unavailable states.

Browser review identified and corrected a compact inbox heading/composer space
issue, a middle-width three-column clipping risk, tiny metadata contrast and a
spurious vertical scrollbar on tabs. Those final CSS fixes compile and are source
reviewed; their final browser recheck is still pending, not claimed passed.

### Remaining acceptance blocker

The overview fails in the isolated production preview because the existing
`packages/ts/crm/dist/analytics.js` predates the source `openPipelineValues` field.
CRM exports types from `src` but runtime code from `dist`, so a web-only build
does not fix stale dependency output. The source implementation and component
tests already cover the multi-currency model; do not substitute fake values or
remove it to hide the stale build.

The normal `scripts/dev.py dev` runner and `tsx watch` messaging worker were
observed running. An asynchronous user request was sent to stop that runner while
leaving Docker running. The shared CRM rebuild is deliberately paused to avoid
reloading a real-message worker. No normal process was terminated by this pass.

After the user confirms it is stopped:

1. Verify the normal worker is stopped.
2. Run `pnpm --filter @or-on/web... build` to rebuild dependencies and web in order.
3. Start `uv run --no-sync python scripts/preview_ui.py --production`.
4. Recheck overview with actual fictional PostgreSQL metrics, compact inbox,
   1200px inbox, empty campaigns/agents and login. Re-run changed-scope tests.
5. Stop the owned preview, verify cleanup, and update this acceptance record.

This is an implemented frontend redesign with a pending final runtime gate, not
Phase 7 completion or a production certification.

## Changed-file map

- `apps/web/src/features/marketing/` and `app/marketing.css`: new public layout,
  interactive product examples and concise bilingual story.
- `features/shell/`, `features/overview/`, `app/workspace.css`, `app/auth.css`,
  login/start routes: navigation, overview and sign-in composition.
- Feature stylesheets plus inbox/operations/orchestration components: readable
  operational surfaces, compact conversation behavior and useful empty states.
- `i18n/messages/en.json` and `he.json`: customer-facing language; real/simulator
  and consent disclosures retained.
- `packages/ts/ui`: colors, typography, controls, semantic progress, contrast and
  busy-button tests. Vitest config included in typecheck but excluded from build.
- `features/system-health/` and its test: validate health payloads before render;
  retry malformed/error responses without inventing readiness.
- `scripts/check_secrets.py` and its tests: tolerate deleted tracked files while
  scanning every remaining file; tracked local environment files still fail.
- Existing prior dirty changes remain uncommitted. This pass did not push,
  deploy, change environment credentials or modify upstream repositories.

## Deferred work

1. Full owned simulator voice-to-follow-up rehearsals remain a separate Phase 7
   acceptance item; the web-only preview intentionally has no voice worker.
2. Formal assistive-technology and cross-browser certification; recorded desktop,
   mobile and RTL checks are representative only.
3. Comparable production CWV and API latency samples; no performance improvement
   is claimed without those measurements.
