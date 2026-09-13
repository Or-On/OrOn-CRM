# Or-On product experience rebuild — 10 September 2026

Status: implementation and scoped acceptance verification complete; uncommitted.
This execution brief supersedes the earlier Studio Admin pixel-clone direction.
The exact evidence, tested scope and remaining environment limits are below.

## Baseline and authority

- Target: `OrOn-Platform`, branch `codex/phase-7-ui-polish`, HEAD
  `7afa8534fc89259cd679da7ff58ec7546bd01b14`. Substantial pre-existing dirty
  work spans frontend/backend/tests/docs; preserve it and do not commit or deploy.
- Read root/scoped instructions, MASTER_PROMPT and the three existing UI plans/ADR.
  The integration wrapper refers to BOOST.md, which is absent; no invented instructions.
- New user brief requires full presentation recomposition, not backend replacement.
- Siblings remain read-only. Providers remain disabled. Only task-owned fictional
  PostgreSQL preview resources may be created/cleaned up.

Baseline completed before product edits:

| Gate                     | Exact command (relative working directory)                                                                              | Outcome                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| UI tests                 | `node ../../../node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism` (`packages/ts/ui`)              | 18 passed / 3 files                                                                |
| Web tests                | `node ../../node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism` (`apps/web`)                       | 133 passed / 32 files                                                              |
| UI types                 | `node ../../../node_modules/typescript/bin/tsc --noEmit` (`packages/ts/ui`)                                             | pass                                                                               |
| Web types                | `node node_modules/next/dist/bin/next typegen`, then `node ../../node_modules/typescript/bin/tsc --noEmit` (`apps/web`) | pass                                                                               |
| Lint                     | `node node_modules/eslint/bin/eslint.js apps/web packages/ts/ui --max-warnings 0`                                       | pass                                                                               |
| Formatting               | `node node_modules/prettier/bin/prettier.cjs --check apps/web packages/ts/ui --ignore-unknown`                          | pass                                                                               |
| UI build                 | `node ../../../node_modules/typescript/bin/tsc -p tsconfig.build.json` (`packages/ts/ui`)                               | pass                                                                               |
| Web and dependency build | `pnpm --filter @or-on/web... build`                                                                                     | pass, Next16.3.3                                                                   |
| Isolated DB              | `uv run --no-sync python scripts/preview_ui.py --check-db`                                                              | 38 passed, 1 skipped; non-superuser platform_web membership; owned DB/role removed |

Node25.9.0 is outside the repository's supported Node24 range. Web tests emit an
existing localstorage-file warning. Neither is silently treated as a clean supported-host gate.

## Verified brand extraction

Inspected the live [Or-On website](https://or-on.io/) visually and read computed
DOM styles on 10 September2026. Actual CSS variables:

| Website variable | Value                   | Product translation                     |
| ---------------- | ----------------------- | --------------------------------------- |
| midnight         | `#06152E`               | dark canvas; restrained branded shell   |
| deep             | `#0A2348`               | elevated navy reference, not every card |
| text / ice       | `#EAF4FF`               | dark primary text                       |
| muted            | `#8FB0D8`               | readable dark secondary metadata        |
| royal            | `#155CFF`               | high-value action fill                  |
| electric         | `#2D8CFF`               | interaction/diagram accent              |
| sky              | `#7FC6FF`               | dark active text/focus/highlights       |
| line             | `rgba(45,140,255,.20)`  | subtle brand-aware separators           |
| line-2           | `rgba(127,198,255,.42)` | stronger control boundaries             |

Observed CTA: 100deg royal→electric gradient, white text, pill radius, selective
blue shadow. Product primary buttons use a contrast-safe solid royal fill and
controlled hover; decoration does not compete with status colors. Website body:
Inter with Heebo; headings/CTA: Poppins. Prefer these verified brand fonts over
the brief's fallback Manrope: Inter variable for dense UI, Poppins600 for headings,
Heebo variable for Hebrew, all self-hosted through next/font. The live heading is
86px/600, but application page titles are deliberately compact, not marketing scale.
Grid/architecture cues are reserved for entry surfaces and genuine flow/data visuals.

## Route and component redesign inventory

All rows preserve existing server reads, validation, CSRF, permissions, provider
admission, error recovery and drafts. New presentations use semantic shared tokens;
no competing CSS override layer. Every row must receive before/after evidence.

| Route / owner                                                   | User task; authoritative data                                                             | Actions and state contract                                                                                                          | Current → new composition                                                                                                                                   | Data presentation; motion/interactions                                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Shell                                                           | all authenticated users; public session, typed navigation                                 | tenant switch/logout, command search, locale/theme, rail preference; RBAC                                                           | rail + duplicated mobile/top headers → brand/workspace header, permission-aware quick create, singular responsive command/navigation shell, account popover | active nav indicator; drawer/palette enter/exit; keyboard and focus restoration                                                   |
| `/` Overview                                                    | operator; dashboardMetrics, overviewMetrics, conversations via tenant SQL                 | Inbox/filter/conversation, handoff and pipeline deep links                                                                          | four equal metrics + large activity card → asymmetric command overview, workload, attention queue, relationship/pipeline snapshot and activity              | real current-state counts and grouped observations; no unsupported historical deltas; restrained bar reveals                      |
| `/inbox` InboxWorkspace / ConversationThread                    | operator; listConversations≤100, message pages, quick replies, members                    | conversation/search/filter intents; reply/media/template/reaction/ownership, idempotency, drafts and explicit real-send review      | two generic cards → unified queue rail, dominant thread, stable composer, contextual contact drawer                                                         | loaded queue counts, row assignment, sender/day grouping; selection and single-pane mobile transition                             |
| `/contacts` ContactManager                                      | operator; listContacts≤100, already query-filtered                                        | q/create; lifecycle/channel filters; create/import partial errors                                                                   | eight-column table + side editor → directory masthead, scoped consent/channel strip, integrated toolbar, identity-first table, focused creation             | loaded-record distributions, exact counts; dialog and row feedback                                                                |
| `/contacts/[id]` ContactDetailPanel                             | operator; detail + activity≤100, authorized voice flows                                   | profile/consent/notes/custom fields, simulation and two-stage real call confirmation                                                | giant edit rail + cards → relationship identity, channel/consent facts, dominant activity timeline, contextual editors                                      | real activity grouping and facts; no invented owner/links; edit dialog feedback                                                   |
| `/pipelines` PipelineBoard                                      | operator; listPipelineBoards                                                              | local selection; drag/drop and explicit stage select; optimistic stageOverrides and rollback                                        | generic summary + board → pipeline-specific toolbar, open-value by currency, compact occupancy strip, refined cards/columns                                 | exact decimal currency totals; explicitly scoped open/won/lost counts; stage movement feedback                                    |
| `/operations` campaigns                                         | operator; listBroadcasts                                                                  | create=campaign; create name/body, deliver/run receipt; drafts remain mounted                                                       | disclosure + low-information index + run rail → campaign outcomes header, dated performance index and focused create dialog                                 | status and delivered/failed/pending distributions from actual recipient counts; no fake read/scheduled data                       |
| `/operations` automations                                       | operator; listAutomations + latest50 runs                                                 | local tabs; draft/publish/run permissions; canonical flows route to orchestration                                                   | generic rows → version-aware library and named, timestamped execution journal, focused create                                                               | latest50 outcome distribution; definitionId mapping; tab motion; retained failed drafts                                           |
| `/voice` VoiceOverview                                          | operator; control API latest50 sessions, numbers, flows, reconciliation                   | existing2s refresh, voice:operate simulated number setup; ACL and flow guard                                                        | equal KPIs + table → operational masthead, observed provider state, outcome strip, primary recent-call index; separate numbers inventory                    | loaded-call outcomes; duration only finite nonnegative usage.call_seconds, not wall span; visible stale refresh state             |
| `/voice/campaigns` VoiceCampaignPanel                           | operator; control API campaigns                                                           | create + simulator run; durable receipt and idempotency                                                                             | metric rail + inline creation → campaign distribution/index, policy metadata, focused creation                                                              | campaign-state distribution; recorded completed calls and current eligible audience shown separately, never as a completion ratio |
| `/voice/calls/[id]` call detail                                 | operator; session events, usage/cost, authenticated assets                                | recording read, ongoing summary refresh                                                                                             | metrics/assets/timeline → call investigation with media/transcript, chronology and diagnostics inspector                                                    | only validated actual transcript event text; USD estimates and unpriced components remain explicit                                |
| `/flows` VoiceFlowPanel                                         | authorized flow operator; spec/components and published summaries                         | JSON source validate/publish, retained invalid source                                                                               | metrics/table/source → card library and catalog header with focused validation/source dialog                                                                | actual publish/version/validation only; no invented persisted drafts                                                              |
| `/orchestration?tab=agents`                                     | flow manager; agent summaries                                                             | create draft/publish                                                                                                                | plain rows/disclosure → capability/version library with focused creation                                                                                    | actual channels/version/validation; no unavailable locale/prompt fields                                                           |
| `/orchestration?tab=flows`                                      | flow manager; canonical definitions/versions                                              | selection, publish/simulate with published flow+conversation                                                                        | list + canvas → navigator, canvas toolbar, metadata and contextual node inspector                                                                           | deterministic read-only XYFlow; list alternative and pan/zoom                                                                     |
| `/orchestration?tab=activity&contact=…`                         | operator; tenant usage + contact events≤100, chooser≤50                                   | preserve tab/contact scope; simulator idempotency                                                                                   | repeated KPIs/timeline → contact journal with clearly separate tenant usage summary                                                                         | scoped source distribution, tenant input/output tokens; no fake priced totals                                                     |
| `/orchestration?tab=handoffs`                                   | operator; latest100 handoffs                                                              | request/accept/resolve under messaging:operate                                                                                      | mixed list + form → pending/accepted attention queue, resolved history, request dialog                                                                      | real status/channel/reason/time; no invented assignee names                                                                       |
| `/system/health` HealthPanel                                    | admin/operator; current liveness/readiness/postgres observation                           | manual retry; malformed/unreachable distinction                                                                                     | signal + rows → observed diagnostic masthead, three-check matrix and scope footer                                                                           | no latency/history/provider health beyond endpoint contract                                                                       |
| `/settings` all six views                                       | account/admin; authorized account, members/invites, keys, tenant, notifications and flags | local tabs (no prior query contract); password-guarded edits, last-owner protections, one-time tokens/invites, removal confirmation | cramped tab strip + card pairs → desktop local navigation, focused content/workspace sections; compact selector                                             | current configuration only; invitation/create dialogs; unsaved/busy/error feedback                                                |
| `/login`, `/invite?token`                                       | unauthenticated/invited user; current session/invitation inspection                       | actual login/accept endpoints and redirects, recoverable values/errors                                                              | centered card → branded quiet editorial side panel and focused form; single pane compact                                                                    | static architecture motif, form enter/error feedback; no new auth capabilities                                                    |
| `/start`                                                        | signed-in user; session/permissions                                                       | only actual onboarding route links                                                                                                  | simple list → permission-aware numbered launch checklist                                                                                                    | no fabricated completion percentage                                                                                               |
| `/[locale]`, loading/error/not-found/access denied/global error | all users; locale/session/error contracts                                                 | en/he redirect and recovery actions preserved                                                                                       | generic repeated cards → coherent route-state compositions with logical h1 and relevant skeleton                                                            | branded reduced-motion safe state transitions, self-contained global error fallback                                               |

## Shared, responsive, RTL and acceptance contracts

Every row uses: accessible named controls, new Select/combobox/popover/menu contract,
44px compact targets, logical properties, EN/HE messages, Intl values and bdi/dir=auto
for user data. Dialogs retain drafts, fit dynamic viewport, trap focus, close on
Escape and restore trigger focus. Tabs retain real state and use direction-aware
arrows. No row-level motion wrapper on large tables. Time/data meaning never reverses
in RTL. Tables/boards/canvas scroll inside their containers, not at page level.

All routes:1440×900 EN/light +390×844 HE/dark. Shell/Overview/Inbox/Contacts/Pipeline/
Messaging/Voice/Settings: full locale×theme at desktop+compact. High-risk surfaces:
768/1024 representative pairings and360. Include keyboard, dropdown collision,
200% text zoom, reduced motion, empty/error/partial/permission-limited, failed draft,
optimistic rollback, provider-disabled, long label and mixed currency evidence.

Focused regression suites: inbox-interaction, crm-workspaces, form-recovery,
delivery-failure, operational-empty-states, operational-layout, voice,
voice-live-pricing, voice-recording-route, real-call-route, orchestration,
flow-canvas, system-health, settings-access, shell-commands, shell-drawer,
bilingual and shared UI contracts. Final gates must rerun after visual fixes.

## Evidence ledger

Baseline emitted static assets (raw bytes, not gzip/network transfer): JS1,207,674;
CSS190,728; WOFF2 fonts122,056. RSC client-reference manifests' unique referenced
JavaScript chunks: Overview/start/localized/not-found294,472; Inbox323,426;
Contacts index/detail341,959; Pipeline301,982; Messaging303,767;
Voice/campaigns/call detail/voice flows320,300; Orchestration492,797;
Settings312,875; Health299,475; Login296,436; Invite296,607;
global-error99,536. Counts include shared chunks and exclude the framework bootstrap;
compare with the same method after final build, not as a total page-download claim.

### Completed integrated gates

- Production dependency + Next build: pass after final route fixes (all45 generated
  pages; dynamic authenticated routes retained). No dependency changes or deployment.
- Web:157 tests /39 files pass. Shared UI:32 tests /4 files pass.
- UI strict TypeScript and production builds pass; web build's TypeScript pass.
- ESLint web/UI + root browser scripts: pass. Prettier web/UI: pass.
- `git diff --check -- apps/web packages/ts/ui packages/ts/crm/src/analytics.ts`: pass.
- Isolated PostgreSQL CRM gate:39 passed,1 skipped (the separate canonical adapter
  suite requires `CRM_TEST_DATABASE_URL`, not this gate's `UI_TEST_DATABASE_URL`).
  The new14-day query's boundary
  and tenant-isolation test ran successfully as a `platform_web` member.
- Preview fixture/auth/voice safety tests:27 pass; Ruff pass (preview-owner audit).
- Primary browser checks:25/25, five widths360/390/768/1024/1440, EN/HE and both
  themes represented. Inbox per-thread drafts, filters, create/import/profile/consent
  dialogs, failed campaign recovery, actual fictional pipeline stage change + restore.
- Voice browser checks:50/50 at the same five widths, no diagnostic CSS injected.
  Dialog drafts/failures, query/contact scope, searchable contact selectors, graph
  keyboard inspector, actual call transcript/cost display and Health observations.
- Workspace browser checks:25/25. Overview exact daily keyboard inspection/data
  table, Settings account draft across sections, invitation/key dialog failed action
  feedback, focus return and retained values. All mutations intercepted as503.
- Shared composed controls:10/10 scenarios,1440/390 EN/HE light/dark +720×450 at2×
  device density for equivalent200% reflow. Popover collision, mobile drawer focus,
  menu keyboard, native picker first-Escape isolation, nested Combobox FormData and
  dismissal, reduced motion. Separate native picker contract:12/12 scenarios.
- Shared Tabs additionally reveal an offscreen active item horizontally without
  moving page scroll; LTR/RTL unit cases pass and direct-link mobile captures show
  the selected tab. Native picker Escape leaves its parent account popover open.
- Browser interaction runs reported zero uncaught runtime errors. Expected mocked
  failure responses test recovery; no provider calls/messages were made.

### Evidence locations and verification limits

- `.artifacts/brand-rebuild/baseline/`:25 authenticated route/view captures at1440
  EN/light and390 HE/dark, plus login/invite captures. Earlier invalid bootstrap-
  tenant images were replaced after fixing only the fictional preview account.
- `.artifacts/brand-rebuild/final/`:540 unique route/view captures,27 surfaces ×
  five widths × EN/HE × light/dark. Zero page-level overflow, missing/duplicate
  visible primary headings, recorded console errors or5xx responses in the final
  matrix. Main-heading font observations confirm Poppins/Heebo for each locale.
- Full matrix build:`oa4hgKB29tTvDWWR70G6p`. Final CSS-only fixes wrap the Settings
  index actions and stack call-timeline labels/times. All140 affected captures
  (six Settings views + call detail ×20 scenarios) were repeated against
  `KOkGGXMNedifq8ofD8Sfv`;400 unaffected captures retained. Each observation records
  its build ID. The fresh360px EN/light and HE/dark fixes were visually inspected.
- `.artifacts/brand-rebuild/UI-REVIEW.md`: clickable before/after pairs for all27
  surfaces plus the full540-image index. The540 counts are unique final images,
  not a claim that every permutation of every form/error state was screenshotted.
- `.artifacts/brand-rebuild/interaction-primary.json`, `interaction-voice.json`,
  `interaction-workspace.json`: guarded interaction evidence.
- `.artifacts/brand-rebuild/composed-controls/observations.json` and40 screenshots;
  `.artifacts/brand-rebuild/control-contracts/`: native picker12-scenario evidence.
- Test browser is the existing bundled Chromium1234; no runtime/dependency install.
  WebKit/Firefox and native-device pickers were not independently certified.
  200% evidence is equivalent layout reflow, not a manual browser zoom-settings run.
- Browser invitation captures show the unavailable-token state; valid acceptance,
  loading/error boundaries and permission-limited states also have component/server
  regression coverage, not a claim of a browser screenshot for every state.
- One earlier capture encountered an intermittent Inbox503. Its retry presentation
  retained messages and disabled sending. Source review did not establish its cause;
  no speculative API change was made. The subsequent full540 capture returned no
  console errors or5xx responses; both results are distinguished from certification.
- Node25 host remains outside the repo's supported Node24 range. Existing Next
  preview `start`/standalone and Node localstorage warnings remain documented.
- Placeholder test data exists only in owned preview PostgreSQL resources, visibly
  fictional. Product components do not manufacture chart observations. Missing
  voice history, pricing, transcript text or provider health stays explicitly absent.

### Implementation decisions and safety

The original signal mark stays code-native. Brand fonts are Inter, Poppins600 and
Heebo, self-hosted by next/font; the unused Poppins700 request was removed. Shared
semantic tokens replace the historical clone override file; old conflicting select
and dead route CSS was removed in its owning stylesheets, not hidden under another
global override file. Base anchor/button resets now use the base cascade layer so
they cannot override shared primary-button contrast.

The root error boundary now imports only six self-contained bilingual strings;
two tests keep those copies synchronized with the authoritative locale messages.
Its visible content, styles and retry behavior are unchanged. The bundle review
records both before/after dependency sets and total emitted assets rather than
confusing route chunk references with actual network transfer.

Native SelectInput retains platform form validation/reset/disabled-fieldset/typeahead
and uses the customizable top-layer picker where supported; large contact sets use
Combobox. No extra component/chart dependency was introduced. CSS bars/meters use
actual returned counts; exact currency values remain separate per currency.

Overview aggregates are the only added product data read:14 UTC calendar days of
retained tenant messages (today partial), plus current conversation states. Voice
duration uses finite nonnegative `usage.call_seconds`, not upload-inclusive session
lifetime. Campaign eligibility is current audience, not the original call cohort.

Two real-call confirmations, consent, feature flags, permission checks, caller
address-form and flow selection checks remain enforced. Successful fictional stage
mutations in QA were restored; all other browser mutation probes were intercepted.
Temporary prior preview DBs/logins were dropped by the owned launcher only. No
developer database, `.env`, sibling repository, provider, branch history, commit,
push, or deployment was changed by this redesign.
