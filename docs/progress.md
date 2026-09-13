# Or-On Platform progress

Last updated: 2026-09-12 (Asia/Jerusalem)

## Active readiness checkpoint — supersedes historical checkpoint below

### Voice AI quality — locally verified implementation checkpoint, 2026-09-12

- Fully read `docs/audit/voice-ai-quality-master-prompt.md`; preserved the dirty
  baseline and all working provider defaults. No real provider request or `.env`
  edit; no application/worker restart, commit, push or upstream mutation.
- Implemented approved tenant knowledge/versioned quality controls, full-turn
  evidence rendering, final STT acceptance, Hebrew semantic/address repairs,
  speech-only pronunciation, stale-generation cancellation and WhatsApp
  trigger/ownership/evidence rechecks. Added explicit paid TTS preview and
  read-only typed LLM evaluation; UI remains in the existing inspector.
- Durable AI pause/resume includes current operator authorization, epoch-bound
  commands, worker acknowledgement and stale STT/LLM/audio cancellation. It does
  not claim a human media connection. Independent cancellation regressions pass.
- New migrations `17f57105f1a9` → `eb626a89c3a8` first passed isolated
  PostgreSQL verification. The user then authorized the guarded local rollout:
  private backup/restore rehearsal passed, all 77 pre-existing business-table
  fingerprints and role settings stayed unchanged, and the application database
  now has one head `eb626a89c3a8`. No worker/provider was started.
- Final gates: 1,095 Python passed / 118 skipped; 117 fresh PostgreSQL tests
  passed; 745 TypeScript passed / 64 skipped. Additional scoped CRM and worker
  PostgreSQL passes overlap those suites as detailed in the evidence report.
  Lint, formatting, strict typing, production build, deterministic contracts/SQL,
  repository/secret-pattern/docs/peer guards passed. Browser RTL/light/dark and
  narrow-layout checks passed without submitting paid actions.
- Baseline HEAD/branch unchanged; 555 existing changed paths preserved, final
  644 changed tracked/nonignored paths. No commit or push. Upstreams clean/locked.
- Evidence: `docs/readiness/voice-ai/results.md`, `feature-matrix.md` and
  `evaluation-runbook.md`. Real-provider/audio/native-listening acceptance,
  broader authorized business tools and documented recording/evaluation gaps
  remain open. This does not clear independent GCP/security release blockers.
- Next exact task: restart the matching local services under user control, then
  separately authorize one fictional-scenario real call and perform the written
  native-Hebrew listening comparison. Do not start unrelated queues or claim
  end-to-end speech quality from repository/database tests.

### Local database schema aligned — 2026-09-12

- User explicitly authorized applying the reviewed migrations before further
  implementation. Verified exact local Compose database and stopped writers.
- Private custom-format backup restored and the four upgrades rehearsed in a
  network-disabled PostgreSQL container before touching the source database.
- Applied `eb2660eb37ec` → `2b2b64433c98` → `6d9561f45598` → `74e4f347dbbd`
  → `bfb741c767fd`. Alembic current/check-heads passed on `or_on_platform_dev`.
- All 75 original business-table row counts/content fingerprints unchanged;
  19 catalog/invariant checks passed. Runtime role settings unchanged; no
  password rotation, seed, replay, provider action, commit or app/worker restart.
- Temporary restore container/data removed; verified private backup retained.
  Evidence: `docs/readiness/local-schema-alignment.md`.
- This supersedes the pending-local-migration warnings in the historical
  verification/merge checkpoints below. The current schema prerequisite is met;
  GCP security, bootstrap, voice packaging and operational gates remain open.

### GCP DEV verification-only follow-up — 2026-09-12

- User requested verification before supplying GCP metadata. No new application
  or infrastructure implementation, migration, worker start, cloud operation or
  provider action. Existing source changes and `.env` preserved.
- Fresh production build, TS/Python typing, lint/format, repository guards,
  Compose/Caddy configuration and Terraform validation pass; 4 Terraform mock
  tests pass. Fresh tests: 639 TypeScript passed / 48 skipped; 911 Python and
  infrastructure passed / 108 skipped. The 77 focused infra tests overlap that
  total. Security gate remains failed; no exception renewed.
- All 89 applied source hashes still match; all upstreams remain clean/locked.
  Read-only local DB check: `eb2660eb37ec`, still four migrations behind the
  reviewed source. Backup/migrate/check remains required before local restart.
- GCP DEV remains NOT READY: first-admin bootstrap, full voice packaging/routing,
  authenticated release checks, host disk/restart preparation, dependency/image
  security and operational recovery/alerts remain gaps. Project/domain inputs
  are deliberately deferred until local preparation is ready.
- Evidence and next implementation sequence: `docs/readiness/gcp-dev-verification.md`.

### Reviewed application merge — 2026-09-12

- User confirmed the runner was stopped and explicitly requested application.
  Reinspection found zero matching platform host processes; existing Docker
  infrastructure was left alone.
- All 89 reviewed paths passed both original/candidate preflight hashes, with
  zero conflicts. Applied 64 updates and 25 additions using scoped patches.
  Every resulting file matches the reviewed candidate SHA-256 exactly; all 64
  original source backups also match their pre-application SHA-256 exactly.
- Preserved `.env`, root configuration, independent infrastructure changes and
  unrelated edits. No commit/push, customer-data operation or provider action.
- Merged-tree verification passed: 619 TypeScript tests; 911 Python/infrastructure
  tests; 107 PostgreSQL tests; 88 CRM persistence tests; 11 worker persistence
  tests; 1 OAuth concurrency test. Formatting/lint/strict typing, production
  build, deterministic contracts/SQL, migration graph and repository guards pass.
  Skips remain explicit. The expired NLTK security gate still fails; not bypassed.
- Tests used a sanitized environment and a guard against reading the real `.env`;
  PostgreSQL used only the task-owned container on loopback 55439. Application
  database revisions are **not yet applied to the user's database**. Do not
  restart workers before migration. Evidence: `docs/readiness/application-merge.md`.
- Exact next task: explicitly select the local application database, create and
  verify a private backup, apply/check the reviewed successor migrations, then
  permit user-controlled restart. No real-provider operation is authorized here.
- Final source recheck: 89/89 reviewed hashes exact; no development workers
  restarted. Task-owned test PostgreSQL stopped; evidence retained. Git remains
  uncommitted on the same branch/HEAD (553 changed paths); upstreams clean/locked.
- The prior candidate-only checkpoint below is historical evidence; this newer
  section supersedes its pending-source-merge status.

### Prior isolated audit checkpoint (before the approved merge)

- Task: execute `docs/audit/production-staging-master-prompt.md`; audit + candidate
  hardening + isolated verification + guarded GCP staging artifacts.
- Baseline branch `codex/phase-7-ui-polish`, HEAD
  `7afa8534fc89259cd679da7ff58ec7546bd01b14`;442 existing changed paths preserved.
- Application entrypoint inventory:25 pages,69API handlers plus workers/services;
  see `docs/readiness/feature-matrix.md` and subordinate inventories.
- Original target graph observed53 revisions, head`eb2660eb37ec`; the older
  `b74f6e2a9c31` statement below is historical, not a current database inspection.
- Candidate: `.artifacts/readiness/candidate`; four generated successor revisions
  `2b2b64433c98` → `6d9561f45598` → `74e4f347dbbd` → `bfb741c767fd`;
  57 total, 22 preserved Or-on revisions, one root/head. No migration applied to
  the user's database. Reviewed delta: 64 changed + 25 added source/test files;
  see `docs/readiness/candidate-changes.md` for conflict-safe hashes.
- Implemented candidate repairs: tenant/API-key/OAuth binding; billing-event and
  idempotency checks; invitation cookie handling; CSV savepoints; retained User
  image model; worker claim/lease/eligibility/ambiguous outcomes/drain; staging
  simulator refusal; Settings/Overview responsive defects.
- Final consolidated run: formatting/lint/strict typing, 619 TypeScript tests,
  834 Python tests, contracts, migrations, production build and peers passed;
  the run then FAILED at the expired NLTK security exception. Skips: 48 TS and
  108 Python, not passes. Separately, 107 real PostgreSQL tests passed in 66.67 s.
  Browser: 25 route/action checks and 2 optional-voice outage checks passed.
- Four final images built and started on the disposable stack at the new head.
  Database outage/readiness recovery and schema-compatible web rollback/forward
  HTTP smoke passed. Final new-database restore: 8.840 s, 482,997 bytes, fictional
  contact/schema/count/RLS checks; no restored worker replay or media recovery.
- Core Python audit clean; full voice audit and image vulnerability gates BLOCKED.
  Do not renew the expired NLTK exception or declare complete security.
- Terraform validated locally, no apply. Staging Compose/images/Caddy/release,
  private secret retrieval, backup timer, and protected manual build/scan/publish/
  VM-deploy pipeline prepared. Real IAM, TLS, authenticated release smoke, alerts,
  media/key recovery and remaining workflow acceptance are still pending.
- Safety: user development runner remains active; stop requested. Runtime fixes
  remain candidate-only until it is stopped. Preserve unrelated edits when applying
  the reviewed candidate delta. No commit, push, data cleanup or provider action.
- Prior next action: user stops the development runner with Ctrl+C (leave Docker
  running), then confirms it is stopped. Recheck processes and original/candidate
  hashes, apply only the reviewed candidate delta, and rerun affected gates.
  Resolve dependency/image blockers and remaining acceptance before any separately
  authorized cloud/provider action. Full details: `docs/readiness/release-decision.md`.
- Release decisions currently **NOT READY for controlled GCP staging** and
  **NOT READY for customer-facing production**; see readiness findings/evidence.
- Final original-checkout guards: repository policy, secret patterns, documentation
  links, scoped diff whitespace and 77 infrastructure tests passed. Final Git
  status is dirty: 507 tracked/nonignored changed paths (including preserved
  baseline edits and this task's additions); HEAD and branch unchanged.
- Final upstream integrity: all three worktrees clean at locked SHAs:
  Or-on `cece174f4d590a1b8a283d539dd66e08cc689aa9`,
  WACRM `98b5bd26e8feacacfd4b74ff58411acb8154d212`,
  OpenLive `849173cd1c8c17a95d600b17b428c301722bf5df`.

## Current checkpoint

- Phase: Phase 7 — tenant operational UI/UX redesign (implemented and locally verified; checkpoint uncommitted)
- Branch: `codex/phase-7-ui-polish`
- Phase 0 baseline: `93eb808e65f8edb1754c1940afe1949e7e18223a`
- Phase 1 baseline: `20b46159078ec533a9891e6768d47595e35b7a7c`
- Phase 2A status: **OFFLINE IMPLEMENTATION COMPLETE**
- Live status: **PHASE 2B LIVE POSTGRESQL VALIDATION COMPLETE**
- Phase 3 status: **COMPLETE**
- Phase 4 status: **COMPLETE**
- Phase 5 status: **COMPLETE — SIMULATOR-FIRST ACCEPTANCE PASSED**
- Phase 6 status: **COMPLETE — ACCEPTED SIX-NODE SIMULATOR SCOPE; OPENLIVE DEFERRED**
- Active task: Tenant application operational-route availability and navigation
  responsiveness follow-up; implementation and integrated visual acceptance are
  complete. Current plan: `docs/plans/tenant-saas-redesign-2026-09-10.md`.
  Prior Or-On brand evidence is preserved separately. No commit or deployment.
- Current working-tree and development-database Alembic head: `b74f6e2a9c31`;
  the schema contract passes.
- Bilingual brief exact clean baseline: `0408d5274af3c181aef32ec79352abfba1ed14be`
- Phase 7 exact baseline commit: `305eb6258435545033343106c19d6479b0cbf97e`
- Phase 2B clean baseline commit: `830a8371836ea7922fca5c320624bf3bd32ec229`
- Phase 3 exact baseline commit: `9ca3a022c2fb18a5d416b39aa7d1404f7910ae1b`
- Phase 4 exact baseline commit: `fdaabedfe0c6dd3586261a338f2fd82f904023d8`
- Phase 5 exact baseline commit: `e6d2e303c07a3a0df35e39d30baf1f5584564464`
- Phase 6 exact baseline commit: `946b08a1c418567f56df87cbe17a97b143596a01`
- Provider safety: no real telephone call, WhatsApp message, webhook mutation, or provider provisioning performed

## Phase 7 implementation state

### Stripe payment-source requirement — 2026-09-11

- Removed simulator top-ups from the application and database contract. The
  cleanup migration subtracts only successful simulator contributions from each
  wallet, deletes their ledger/top-up records, and preserves real Stripe funds.
- Added tenant-scoped Stripe payment profiles. Funding now requires a reusable
  card collected by Stripe Checkout setup mode; card numbers never reach Or-On.
- Added signed-webhook completion for card setup and kept wallet crediting gated
  by a verified paid Checkout event. Without deployment Stripe credentials, the
  Finance page shows the integration as unavailable and disables both actions.

### Invitation privacy and revocation — 2026-09-11

- `/invite` now always renders through the public access composition, even when
  the browser already has an authenticated administrator session. Workspace
  navigation and account controls are never exposed before invitation
  acceptance.
- Authorized owners and administrators can revoke pending invitations from
  Users or Settings after a destructive-action confirmation. Migration
  `b74f6e2a9c31` implements tenant-scoped, audited revocation; deleting the
  pending record immediately invalidates its hashed bearer token.

### Tenant operational UI/UX redesign — 2026-09-10

Implemented the latest nine-area tenant brief after auditing the actual UI,
APIs, data projections and PostgreSQL grants. The dashboard replaces its
conversation feed with scoped operational metrics and outcome charts. Inbox
is full-width with compact messages, real-only outbound intent and explicit
review; Contacts gains a responsive directory and focused activity details.
Messaging, Voice, Agents and Flows use scoped registers, inspectors and actual
execution history. Settings has eight purposeful categories, and Health exposes
only three observed checks with timeouts, stale-result handling and bounded
session history. Tenant delivery-mode/consent controls are removed; existing
opt-outs and provider admissions remain intact. New-contact grants are
prospective and cannot shadow existing phone/WhatsApp/email recipients.

Verification: 337 workspace JavaScript tests passed, 28 environment-gated tests
skipped; isolated PostgreSQL CRM tests passed 54 with one legacy adapter skipped,
including seven new contact-policy tests under the existing web role. Four
isolated messaging diagnostics and 25 preview fixture tests passed. Lint,
formatting, strict typing, build, repository boundaries, schema contract and
secret scan pass. The final production build `BED4XwmqyKXHDmBUyOceZ` has 620
responsive EN/HE light/dark captures with zero recorded geometry/runtime/5xx
exceptions; domain interaction checks and manual screenshot reviews verified
keyboard behavior, recovery, readable narrow-screen headers and mobile latest-
message positioning. The review index is `.artifacts/tenant-saas-rebuild/UI-REVIEW.md`.
Prior brand captures and unrelated working-tree changes are preserved. No
provider call/message, development-database migration, commit or deployment was
performed. Node 25.9.0 is outside the declared Node 24 range; environment and
verification limits are recorded in the plan.

### Voice quality and recording playback follow-up — 2026-09-10

The latest four retained call transcripts and their canonical session metadata
were reviewed after a degraded Hebrew call. The repair makes published persona
gender structured and backward-compatible through the immutable flow source,
removes contradictory retained-persona text when a canonical published agent
is attached, blocks spoken placeholders and AI/LLM self-identification, and
adds a platform-name pronunciation override for scripted greetings. The idle
policy now tracks active caller speech and defaults to ten seconds. Soniox word
timestamps are restored for interruption-accurate assistant context while
timestamp text is de-pointed before it reaches the LLM. Completed transcripts
are finalized chronologically, and the local config no longer claims model-backed
niqqud without a pinned model. Verification: 486 Python voice/flow/Hebrew/
dispatcher tests passed with one credential-gated LLM evaluation skipped;
Ruff, targeted Pyrefly, TypeScript workspace typecheck, deterministic contract
generation, and the Next.js production build passed. No provider call was
placed. A fresh operator-listening call remains required after restart.

The current working tree now uses the supported Soniox `tts-rt-v2` baseline and
a current conversational fallback voice, while preserving valid per-flow and
per-call choices. Voice personas explicitly avoid AI/LLM self-identification,
respond to unsupported requests in customer-service language, and keep turns to
one or two sentences with one question. A live follow-up showed that even
two-pass high-confidence acoustic gender was not calibrated reliably enough for
telephone audio, so it is now default-off and the agent stays naturally neutral.
Controlled opt-in evaluation retains the two-pass 0.90 threshold.

The default caller pause window is now 0.7 seconds after VAD stop, avoiding the
previous roughly half-second mid-sentence endpoint. A TTS-boundary regression
guard removes only terminal full stops after a recorded call proved that no
literal "period" existed in its transcript. No customer content was emitted by
the diagnostic.

Explicit caller self-identification is now promoted from the final STT text to
authoritative per-call context before the same turn reaches the LLM. It locks
Hebrew address morphology and the TTS gender hint against later acoustic
overrides while conservative matching ignores third-party gender references.
The prompt and spoken boundary both reject `סליחה רבה` in favor of the natural
`סליחה, טעיתי`. Focused gender/pipeline/filter tests pass; no call was placed.

Completed session pages now include authenticated playback of the full stereo
call recording. The control API performs tenant-scoped lookup and reads the
canonical artifact URI server-side; the web BFF streams it with private,
no-store caching. Focused Python and web tests are implemented. No real call was
placed for this follow-up; an operator-listening check remains the appropriate
final quality gate after the development runner restarts.

### Platform management and connected-flow follow-up — 2026-09-09

Status: implemented and verified in the current uncommitted Phase 7 working tree.

| Area                                          | Current implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Boundary / remaining gate                                                                                                                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant and platform-administrator access      | Migration `c567208f57bc` adds account display names and least-privilege database functions for tenant naming, profile/password changes, invitations, and member-role/removal actions. Canonical sessions now expose `displayName` and `isSuperuser`; a platform administrator can select an active tenant and receives the effective owner role for that tenant. Successors `5725968b8ae1` and `e139bf3fde7e` fix normal-session resolution, revoke direct invitation-table CRUD from the web role, expose an authorized listing function, and fail closed for invalid tenant-name contexts. Owner-management and last-owner protections remain enforced. | This is authenticated application administration, not a separate unrestricted database-superuser console. No tenant create/delete surface is claimed. Invitation delivery remains a manually shared bearer link; email delivery and verified-email onboarding are not implemented. |
| Account, workspace, member, and invitation UI | Settings now separates account, workspace, team, notifications, API access, and integrations. Profile email changes require the current password; password changes use the existing Argon2id path and revoke other sessions. Authorized operators can rename the active tenant, change eligible member roles, remove eligible members after confirmation, create seven-day hashed invitations for `admin`, `agent`, or `viewer`, and accept them through `/invite` for an existing or new account.                                                                                                                                                        | Invitation creation returns a link for manual copy. No email sender, delivery, resend, or delivery-status workflow is implemented or claimed.                                                                                                                                      |
| Inbox contact context                         | The selected conversation exposes contact identity, assignment, consent, service-window context, and the canonical contact link in a centered, viewport-bounded modal dialog with localized close behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                               | The dialog is contextual UI only; opening it performs no provider action. Desktop and compact browser inspection passed.                                                                                                                                                           |
| Persisted connected flows                     | The orchestration workspace reads each latest canonical flow definition from PostgreSQL and projects its persisted nodes and edges into a deterministic top-down `@xyflow/react` canvas with fit, pan, zoom, smooth edges, typed labels, and a screen-reader list. New cross-channel drafts persist an explicit connected six-node graph before the existing publish/simulate paths are offered. Malformed nodes and dangling edges are omitted rather than fabricated.                                                                                                                                                                                   | The canvas is currently a read-only projection, not a claim of full drag/connect editing parity. Positions are derived in the browser and are not authoritative persisted state. Simulation/provider safeguards remain unchanged.                                                  |
| Development fixture retirement                | `db/seeds/seed_development.py` now bootstraps only the development tenant, platform-administrator identity, membership, and credentials; it no longer re-seeds the former CRM/Inbox/pipeline demo records or secondary demo tenant. Runtime voice flow lookup is tenant-owned and fails closed instead of falling back to packaged fictional flows. `scripts/clean_development_demo_data.py` accepts only loopback PostgreSQL database `or_on_platform_dev` and refuses unknown tenant rows or non-fixture references.                                                                                                                                    | The guarded cleanup was applied after its exact dry-run was reviewed. A second dry-run reported zero remaining deterministic simulator/test fixtures. Real Meta records and provider configuration were preserved.                                                                 |
| Premium application/system presentation       | Shared tokens, motion and accessible UI patterns now support the compact/expandable shell, route-backed command actions/search, account and tenant controls, the redesigned sign-in/invitation/start/error/loading states, denser operational workspaces, and a validated system-health console that reports only observed control-API/PostgreSQL state.                                                                                                                                                                                                                                                                                                  | English LTR and Hebrew RTL desktop/compact browser inspection passed without page-level horizontal overflow. This remains a development platform checkpoint, not an accessibility certification or production-readiness claim.                                                     |

The cleanup inventory command is
`uv run --no-sync python scripts/clean_development_demo_data.py`. The separately
guarded `--apply` run removed only the reviewed deterministic fixture set; its
final reviewed pass removed one completed simulator voice job, its audit record,
the deterministic `Fictional welcome` flow, and its publication audit. The
immediate follow-up dry-run reported zero rows in every cleanup category. The
database retains two real Meta channels and no queued/retry/running work.

The administration schema is introduced by `c567208f57bc`; successor revision
`5725968b8ae1` qualifies `membership.role` inside the session resolver and
`e139bf3fde7e` hardens invitation and tenant-administration access. The schema
manifest names `e139bf3fde7e` as the sole working-tree head. The owned local
development database is at that head; no remote or deployed database was changed.

No invitation email, WhatsApp message, telephone call, provider mutation, or
deployment was performed by this checkpoint. The flow-canvas provenance is recorded in
[`docs/audit/source-map.md`](audit/source-map.md#phase-7-connected-flow-canvas--2026-09-09).
Final evidence: 680 default Python tests passed (66 correctly separated live or
provider-dependent skips), all 65 PostgreSQL tests passed against PostgreSQL
18.6, 121 web tests and all package/service TypeScript tests passed, and Ruff,
targeted Pyrefly, Prettier, ESLint, strict TypeScript, contracts, repository and
secret guards, migrations, dependency audit, and the Next.js 16.3.3 production
build passed. Browser inspection covered English LTR and Hebrew RTL at desktop
and compact widths. Node 25.9.0 still produces the expected warning because the
supported repository baseline is Node 24 LTS.

### Application-only rebuild and alignment — 2026-09-08 (intermediate evidence)

The latest request retires the public landing page. Guest entry now reaches the
redesigned login; signed-in entry reaches the real overview. Existing onboarding,
authentication, contacts, inbox, pipeline, operations, orchestration, voice and
settings routes retain their APIs, tenancy and safety controls. There was no
existing self-registration implementation to preserve; no simulated signup was
added.

New midnight/blue shared tokens, original auth composition, compact navigation,
context strip, actual-metric overview, two-pane inbox and domain-owned operational
layouts replace the prior presentation. Follow-up alignment work fixes independent
customer record columns, duplicate form padding, small-icon centering/sizing,
responsive wrapping, composer clearance and account-menu dismissal.

- At this intermediate slice, 104 web tests and 11 shared-UI tests passed with
  scoped lint, format, strict typing, and the Next.js production build. The final
  combined Phase 7 evidence is the larger 117-web-test gate recorded above.
- Repository and secret guards pass. Documentation and browser production
  checks are recorded in the current acceptance document.
- The earlier stale CRM runtime blocker is resolved after rebuilding workspace
  dependencies with the normal worker stopped. Real fixture-backed overview
  metrics rendered successfully in isolated PostgreSQL preview.
- At this intermediate slice, no normal database/queue, `.env`, provider,
  upstream, commit, or remote changes were made. One fictional simulator reply
  queued only in the disposable preview database. The later reviewed local
  migration and cleanup work is recorded in the current section above.
- This is retained as intermediate evidence, not the current completion status
  or a production-certification claim.

Current record: [application UI rebuild](plans/application-ui-rebuild-2026-09-08.md).
The older full-frontend entry below is historical; its landing direction and
stale-runtime blocker have been superseded by this entry.

### Complete frontend redesign — 2026-09-08

The latest request re-authorized the full frontend scope. Public landing,
workspace navigation, overview and sign-in were recomposed; shared typography,
black/charcoal colors, operational surfaces and English/Hebrew copy were aligned.
Customer/contact, inbox, pipeline, campaign, automation, agent and settings
workflows retain their server contracts, permissions and provider safeguards.
New empty states open existing forms rather than inventing new workflows.

- Web tests: 98 passed. Shared UI tests: 11 passed, including semantic-color
  contrast, busy-button safety and bounded accessible progress.
- Scoped ESLint, strict types, formatting and Next production build pass.
- Isolated CRM PostgreSQL suite: 38 passed, one separate live case skipped.
  Auth/config suites: 30 passed. Secret-scanner regressions: 4 passed.
- Repository, secret and documentation guards pass; pnpm audit reports no known
  vulnerabilities. Upstreams remain clean at locked SHAs.
- Browser checks exercised public desktop/Hebrew mobile, sign-in, conversation
  selection, simulated reply queueing, fictional contact creation, persisted
  keyboard deal movement, light/dark mode, language switching, settings tabs,
  command navigation and unavailable service feedback.
- **Final runtime acceptance paused:** the overview needs a dependency rebuild
  because existing CRM `dist` predates the source multi-currency metric. The
  normal real-capable messaging worker is running; the user was asked to stop
  `scripts/dev.py dev` before rebuilding shared packages. Do not reload it or
  bypass the build with fake metrics.
- Exact next step after stop confirmation: `pnpm --filter @or-on/web... build`,
  then the isolated production preview and final overview/compact-inbox checks.
  The inspected preview has been stopped and its owned fictional DB/login
  removed; no developer DB or real queue was altered.

Full scorecard and evidence: [frontend excellence](plans/frontend-excellence-2026-09.md).
This is not a claim that every Phase 7 acceptance item is complete. No deployment,
provider call, external WhatsApp message, credential change or upstream edit was
performed. Node 25.9.0 remains outside the documented Node 24 support range.

### Gateway Flow correction — 2026-09-06

Replaced the inaccurate SVG approximation with the supplied Meng To / ThreeUI
canvas effect: 80 symmetric center-converging dotted curves, independent 3px
particles, original speed/color defaults, and click shockwaves. Removed the
invented blue hub, animated dash pattern, mask and attenuated callsite settings.
The hero canvas now bleeds to the viewport edges instead of inheriting the
landing content's 100rem cap, removing the pasted-panel/cutout appearance.
React lifecycle, container resizing, reduced-motion/offscreen pausing and theme
handling surround the original geometry. No new runtime dependency or external
script; authenticated screens, provider settings and backend work are untouched.
Verification: six canvas tests pass (geometry, particles, click displacement,
reduced motion, theme/resizing, cleanup). Scoped ESLint, strict web typecheck and
Next.js production build pass; browser screenshots confirm the centered canvas
and changing particle positions against the 21st.dev reference. Full web suite:
88 passed, 3 failed in untouched voice/pipeline tests (missing
`voice.eligibleAudience` translation; two `Move stage` button queries). These are
outside this landing-only correction. The host uses Node 25.9.0, outside the
pinned >=24.20.0 <25 range; no toolchain change was made. Existing uncommitted
redesign work remains preserved; no checkpoint commit or Phase 7 completion claim.

### Customer Operations redesign — 2026-09-06

The approved redesign treats the existing frontend as a functional prototype and
preserves routes, domain behavior, RBAC, data, and provider safety while replacing
weak information architecture and presentation. The implementation plan is tracked
in [`docs/plans/phase-7-customer-operations-redesign.md`](plans/phase-7-customer-operations-redesign.md).

| Task   | State                                         | Evidence                                                                                                                                                              | Remaining boundary                                                  |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P7-R01 | implemented and verified                      | Premium token/primitives system, restrained motion, compact/expandable bilingual shell, command actions, keyboard/focus tests, strict typecheck, and production build | Not an accessibility or performance certification                   |
| P7-R02 | implemented and verified                      | Overview, centered-dialog Inbox, Contacts, and Pipeline retain their workflows; English LTR and Hebrew RTL desktop/compact browser inspection passed                  | No fabricated metrics or provider outcomes                          |
| P7-R03 | implemented and verified                      | Messaging, Voice, persisted connected flows, Handoffs, Health, and account/tenant/team Settings are covered by feature and authorization tests                        | OpenLive and real-provider actions remain deferred                  |
| P7-R04 | implemented and verified                      | Public landing removed; guest entry, login/invitation/start/error/loading states, responsive shell, reduced motion, dark/light, LTR, and RTL behavior covered         | Browser evidence is not certification                               |
| P7-R05 | verification complete; checkpoint uncommitted | 121 web tests; 680 Python passed with 66 skips; 65 live PostgreSQL passed; lint, format, typing, builds, contracts, guards, migrations, and dependency checks passed  | Review and create coherent commits; do not claim a final commit yet |

The later management follow-on introduced the locally applied migration chain
through `e139bf3fde7e` and the guarded, reviewed development-fixture cleanup.
Those operations were confined to the owned local development database. No
external provider operation, deployment, upstream change, or production
certification is part of the redesign.

### Brand-system refinement — 2026-09-06

The user approved [or-on.io](https://or-on.io/) as a visual reference. The target
uses an original signal/core mark, navy/ice surfaces, electric-blue interaction
color and conversation-path artwork; no reference asset, layout, copy, customer
proof, performance figure or commercial claim was copied. Exact clean baseline:
`fde2f4b51913fa9f6312b9e8201d9b5b5a6136d5`.

| Task   | State                           | Evidence                                                                                                                                                                                                                                        | Next exact task                                                                                               |
| ------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| P7-V01 | implemented; acceptance partial | Shared semantic tokens/motion, original brand lockup, bilingual public hero and implemented-safeguard strip, accessible mobile product menu/drawer, branded app rail, action-oriented Overview treatment, safer Input/Surface/Dialog primitives | Run the remaining full viewport, assistive-technology and fictional workflow matrix before Phase 7 completion |
| P7-V02 | complete                        | Exact `/en` and `/he` public roots no longer resolve a database session; forged/nested markers remain application paths; focused and full web tests pass                                                                                        | Keep authenticated/database boundaries unchanged                                                              |

Pinned Node 24.20.0 and pnpm 11.24.0 verification passed: format, ESLint,
workspace strict typechecking, 172 default TypeScript tests (20 explicitly
separated live tests), all package/service builds and the Next.js 16.3.3
production build. English dark, English light and Hebrew RTL desktop marketing
were browser-inspected; a decorative-path horizontal overflow found during that
inspection was removed. This is not a claim that the full responsive,
screen-reader, zoom, contrast or clean-session rehearsal matrix has passed.

No dependency, schema, provider setting or environment credential changed. No
message, telephone call, webhook/provider mutation, provisioning or Terraform
action occurred.

### Local webhook edge — 2026-09-03

| Task    | State                                   | Commit / evidence                                                                                                                                                                                                                                                                                                 | Next exact task                                                                             |
| ------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| P7-WH01 | setup complete; Meta acceptance pending | This checkpoint, baseline `486eeaf`: user-authorized, dedicated pinned Caddy/cloudflared Compose stack; no worker restarts/provider credentials in edge. Public verification 200, wrong token 403, unsigned/tampered POST 401, signed empty envelope 200/zero events, oversized body 413, other paths/methods 404 | User configures Meta callback/messages/WABA subscription and sends a fresh personal inbound |

No outbound message/call, Meta resource/subscription mutation, `.env` change,
application queue modification or Terraform action was performed. The temporary
Cloudflare edge was started with user authorization; real Meta inbound acceptance
is not claimed. Only Next.js webhook request logging changed in application code
to keep verification query tokens out of development logs; the worker was not
restarted. Start/stop/URL discovery and template limitations are documented in
`docs/runbooks/whatsapp-webhook-local.md`.

Verification passed: Caddy configuration and container health, Compose validation,
49 web unit tests (including webhook logging exclusion), affected ESLint/Prettier,
strict web TypeScript and Next.js production build, repository/docs/secret guards.
The public HTTP probes used no customer payload and no Meta Graph mutation/send;
the signed empty envelope generated zero durable events. All upstream worktrees
remained clean at locked SHAs. Image vulnerability scanning was not performed;
image versions/digests were verified against official releases and registry pulls.
The first gateway port (8787) was occupied; the committed configuration uses
loopback 18787/18788 without stopping or modifying the existing listener.

### WhatsApp diagnostic checkpoint — 2026-09-03

User-authorized follow-up to an uninformative `meta_100` send failure. Exact clean
baseline: `54affdc30fb14ad2b7e02bb8865bddf40cff304f`. The user stopped the hot-reload
development runner before worker edits, preventing incidental real-queue execution.

| Task    | State    | Commit / evidence                                                                                                                                                                                                                                                                    | Next exact task                                                                                                                    |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| P7-MD01 | complete | This diagnostic checkpoint: bounded Meta numeric codes/subcodes, fixed reason classifications, transactional JSONB persistence, redacted structured logging, tenant-scoped message projection, bilingual Inbox disclosure, backward-compatible historical-code display; no migration | User may restart after reviewing queued real work and inspect a future explicitly confirmed send; no resend performed by the agent |

Four new tests passed against a newly migrated, owned PostgreSQL database with
`platform_messaging` writes and `platform_web` reads: safe failure persistence and
cross-/missing-tenant isolation, bounded retry exhaustion, successful retry
cleanup, and disabled-provider refusal. All HTTP was mocked. The regression
caught and corrected JSON-null serialization so non-HTTP failure metadata does
not erase unrelated message payload keys. The CRM isolated regression also
passed (38 tests, one unrelated cross-channel fixture skip). Both owned databases
and generated login roles were removed. The developer database and `.env` were
not mutated and no real message, worker restart, webhook or provider mutation
was performed during implementation/testing.

Raw Meta error strings and trace strings are intentionally not retained. Only
recognized explanations are available, and historic failures cannot be enriched
retroactively. No delivery guarantee or root cause for the prior send is claimed.

Final local verification: all 155 default TypeScript tests passed (48 web,
28 messaging worker, 37 CRM, 42 other workspace tests; 20 database tests remain
explicitly separated from the default run). The four new live diagnostics tests
and the 38-test focused CRM/PostgreSQL gate passed separately. All 32 Python
script tests plus two migration-graph tests passed; Ruff and Pyrefly passed for
the touched Python runner. Workspace Prettier, ESLint, strict TypeScript, all
package builds, the Next.js production build, generated HTTP/event freshness,
repository boundaries, documentation and secret guards passed. The CI database
job now includes the isolated diagnostics gate; remote CI was not executed here.
No dependency versions, schema revisions or provider settings changed. Broader
voice rehearsals/accessibility acceptance remain the existing Phase 7 follow-up,
not prerequisites newly claimed passed by this diagnostic checkpoint.

### Expanded bilingual brief — 2026-09-03

The user requested a complete public/product bilingual implementation, extending
the first UI checkpoint. [Scope and sitemap](plans/phase-7-bilingual-redesign.md)
and [architecture](architecture/bilingual-experience.md) record the decisions.
Existing accounts and engines remain authoritative; commercial offers, new auth
providers and OpenLive are not invented to fill a design template.

| Task   | State                                  | Commit / evidence                                                                                                                                       | Next exact task                                                                 |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| P7-B01 | implemented                            | Additive webpack 5.110.3 declaration dependency; stable next-intl request configuration, locale cookie/proxy, EN/HE ICU parity, real document direction | Complete expanded browser matrix                                                |
| P7-B02 | implemented                            | `/en`, `/he`, illustrated workflow, honest capabilities/security/FAQ and localized metadata; development and production browser checks                  | Legal/operator details are required before any public launch                    |
| P7-B03 | implemented for existing-account scope | Bilingual login, access help, authenticated `/start`; production fictional login succeeds                                                               | No signup/recovery/SSO/MFA service was invented                                 |
| P7-B04 | implemented                            | Compact/mobile shell, palette focus/search/Escape, translated Overview/Inbox, draft/confirmation preservation and native validation                     | Expanded keyboard and assistive-technology matrix                               |
| P7-B05 | implemented                            | Failed note/campaign retention, typed fields, partial CSV feedback, multi-board selection and exact currency-specific totals                            | Verify larger representative operator datasets                                  |
| P7-B06 | implemented for retained routes        | Localized operation/voice/settings/detail surfaces, actual provider flags, flow-executor-aware actions, activity context                                | Full isolated voice-to-follow-up rehearsals still needed                        |
| P7-B07 | core checks passed; acceptance partial | 42 web tests; default workspace typing/tests, Python suite, production build, real focused PostgreSQL regression, contracts and guards                  | Finish outstanding checks in acceptance record; do not declare Phase 7 complete |

The dependency commit is intentionally separate from the presentation changes.
Created commits: `7755114` supplies the verified development type dependency;
`1d3e90a` adds typed public-origin configuration, executor-aware CRM projections
and shared dialog/presentation primitives. The following bilingual experience
checkpoint contains the working route changes, tests and acceptance documentation.
Detailed commands, results and unexecuted gates are tracked in the
[bilingual UI acceptance record](runbooks/bilingual-ui-acceptance.md).

Approved plan: [`phase-7-ui-polish.md`](plans/phase-7-ui-polish.md).
All three upstreams were verified clean at their locked SHAs before branching.
The referenced workspace `BOOST.md` is absent; root/scoped instructions and the
complete master prompt govern this work. Developer `.env`, login and queues must
remain untouched; use a separate fictional database for interactive acceptance.

| Task          | Status                          | Commit / evidence                                                                                                                                                                                                        | Next exact task                                           |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| P7-001        | complete                        | `7041417` plan/tooling + UI checkpoint; owned PostgreSQL preview, six isolation-tool tests, upstream locks verified                                                                                                      | Preserve isolation during remaining browser acceptance    |
| P7-002        | implemented; partial acceptance | UI checkpoint: compact tokens, labelled/grouped navigation, mobile disclosure, command search, light/dark desktop inspection                                                                                             | Mobile/keyboard/zoom matrix in P7-008/P7-009              |
| P7-003        | complete for Overview scope     | UI checkpoint: full tenant-scoped counts, recent conversations, actionable links, truthful provider mode; PostgreSQL query and production build pass                                                                     | Integrate remaining demo context without fake metrics     |
| P7-004        | implemented; core checks passed | UI checkpoint: race-safe threads, scoped drafts, queue/result routing, microsecond-safe keyset history, sender/template detail and two-stage real confirmation; nine DOM interaction tests + live 303-message regression | Broader viewport/accessibility and rehearsal gates remain |
| P7-005–P7-008 | planned                         | Contacts/pipeline, operation capabilities, voice context, Hebrew/a11y                                                                                                                                                    | Follow core screen verification                           |
| P7-009–P7-010 | planned                         | Browser regressions, performance and rehearsal                                                                                                                                                                           | Final Phase 7 acceptance; not yet passed                  |

### First Phase 7 UI checkpoint evidence

- Pinned Node 24.20.0/pnpm 11.24.0 used; installed host PATH versions were older,
  so existing ignored local toolchains were prepended without changing the baseline.
- Workspace ESLint, strict TypeScript, Prettier, build (including Next.js 16.3.3),
  and all 104 default TypeScript tests passed; 16 explicitly live tests skipped.
- `uv run --no-sync python scripts/preview_ui.py --check-db`: 25 CRM tests passed
  (24 units plus the new live test); the existing cross-channel test needs its
  separate voice-outcome fixtures and remains skipped in this focused runner.
  An initial attempt exposed that fixture requirement; it was not reported passed.
- The live pagination regression found driver timestamp serialization lost
  microseconds. Binding cursor text before PostgreSQL casts fixes the real issue;
  303 rows including identical timestamps now traverse with no gaps/duplicates.
  Runtime-role, missing-tenant and cross-tenant reads also pass.
- All 32 Python script tests passed; targeted Ruff lint/format passed. No claim
  that the entire retained Python/voice suite was rerun for this UI checkpoint.
- OpenAPI/generated-client freshness, repository/secret/docs guards, one-head
  migration graph and deterministic offline SQL passed (39 revisions, head
  `50a6befe7903`). No new migration was added. Preview databases actually migrated.
- `pnpm audit --audit-level=critical`: no known vulnerabilities found.
- Browser skill used for real desktop Overview/Inbox visual inspection in both
  themes, authenticated with the user-approved temporary fictional account.
  Complete responsive, keyboard, Hebrew and performance acceptance is still pending.
- No real provider request, worker start, `.env` edit, developer login change,
  developer queue mutation, upstream change or cloud operation. Test databases
  and generated login roles are removed on runner shutdown. The optional review
  preview is separate from normal port 3000 and contains fictional data only.

See [Inbox implementation notes](architecture/phase-7-inbox.md) and
[isolated preview runbook](runbooks/local-development.md#isolated-ui-review-phase-7).

## Phase 6 implementation state

Phase 6 starts from clean Phase 5 head
`946b08a1c418567f56df87cbe17a97b143596a01`. By explicit product decision,
OpenLive, Live Lab, browser-local voice/vision, WebGPU, ACP, and the desktop
wrapper are deferred to the final integration phase. Phase 6 now owns the
formerly planned cross-channel work and may implement only canonical voice and
messaging agent/flow adapters. The authoritative scope is
[`phase-6-cross-channel.md`](plans/phase-6-cross-channel.md).

| ID            | Task                                                                                     | Status                                          | Commit                                      | Verification evidence                                                                                                                                                                                                                                  | Next exact task                                                    |
| ------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| P6-001        | Baseline, instruction, upstream-integrity, and scope verification                        | complete                                        | preparation checkpoint                      | Clean Phase 5 baseline `946b08a`; all locked upstreams clean; roadmap reordered by explicit user direction                                                                                                                                             | Inventory retained voice and messaging profile/flow semantics.     |
| P6-002        | Canonical agent/profile and flow source-parity inventory                                 | complete                                        | `7fb1b74`                                   | Retained Or-on voice and WACRM messaging semantics mapped to one versioned contract; OpenLive excluded                                                                                                                                                 | Complete.                                                          |
| P6-003–P6-006 | Canonical agent/flow schema, validation, publishing, immutability, RBAC, RLS, and audit  | complete                                        | `a6aa0c1`, `7fb1b74`                        | Two generated Alembic revisions; one head; live PostgreSQL catalog/RLS/immutability tests pass                                                                                                                                                         | Complete.                                                          |
| P6-007–P6-009 | Retained voice/messaging adapters and cross-channel coordinator                          | complete for accepted six-node simulator subset | `0b1e26c`                                   | Frozen Or-on FlowSpec/native Pipecat binder parity; WACRM interpolation/template ordering; twelve isolated worker tests prove ordered actions, durable wait/resume, replay, actor revocation, deadline and child failures                              | Complete.                                                          |
| P6-010        | Call-outcome-to-WhatsApp simulator workflow                                              | complete                                        | successor to `34a14ac`                      | Worker now consumes the job atomically; four isolated PostgreSQL tests cover runtime-role RLS, concurrency/replay, consent/opt-out, malformed mode and foreign-tenant contact; workspace tests/typecheck/build pass                                    | P6-011 voice-job consumer.                                         |
| P6-011        | WhatsApp-to-CRM-to-call simulator workflow                                               | complete                                        | `7f6881a`, `0b1e26c`                        | Ten isolated PostgreSQL consumer tests and cross-language inbound→CRM→call→follow-up test pass; simulator sessions/events/outbox and completion share one transaction; replay also binds frozen flow identity/version                                  | Complete.                                                          |
| P6-012–P6-014 | Handoff, activity, usage, latency, and cost                                              | complete                                        | `7fb1b74`, `0b1e26c`                        | Domain/API/tenant-isolation tests and both simulator paths verify handoff/activity; cost intentionally unpriced                                                                                                                                        | Complete.                                                          |
| P6-015–P6-017 | Control API contracts and accessible responsive operator surfaces                        | complete                                        | `7fb1b74`, `10ae55f`                        | Generated OpenAPI/client, strict typecheck, UI tests, and Next.js 16.3.3 production build pass                                                                                                                                                         | Complete.                                                          |
| P6-018–P6-021 | Database/end-to-end verification, architecture, provenance, and clean checkpoint         | complete                                        | `7f6881a`, `0b1e26c`, final docs checkpoint | 58 PostgreSQL/retained-RLS tests; 14 isolated TS worker tests; 639 Python tests; workspace tests/typing/lint/builds, containers, contracts and guards pass. Both consumers now exercised, correcting the earlier overbroad completion claim            | Phase 7 scope review.                                              |
| P6-022        | Real Meta adapter, durable admission, consent/window/idempotency, and dual kill switches | complete                                        | `956cf75`                                   | Mocked 400/401/403/429/5xx/timeout/success tests; no network call; worker persists provider IDs outside request transactions                                                                                                                           | Complete.                                                          |
| P6-023        | GET verification, exact-raw-body POST signature, status ingestion, and deduplication     | complete                                        | `956cf75`                                   | API/parser tests and live durable worker test prove signed duplicate delivery updates once                                                                                                                                                             | Complete.                                                          |
| P6-024        | Real-delivery UI, explicit confirmation, protected smoke command, and runbook            | complete                                        | `10ae55f`, Phase 6 docs checkpoint          | Simulator remains default; REAL path is unmistakable and double-confirmed; smoke command is manual-only. User subsequently reported successful real delivery                                                                                           | No additional send authorized or performed in this completion run. |
| P6-025        | Repair Inbox team-directory and assignment privileges                                    | complete                                        | successor to `f75e492`                      | Narrow tenant/member-checked SQL function replaces forbidden direct identity reads; isolated and actual localhost Inbox queries pass as `platform_web`; migration `9d3038bec65e` applied locally; 47 database and 5 isolated TS integration tests pass | Resume P6-011.                                                     |

### Inbox permission repair — 2026-09-02

The configured web role correctly lacked direct SELECT on `memberships` and
`users`, but `listTeamMembers` and `assignConversation` incorrectly queried
those private tables. This was an application/privilege-boundary mismatch, not
missing Meta credentials. A successor Alembic function now exposes only the
active tenant's team to an active member, without granting table access.
The new head is `9d3038bec65e`. No identity data, credentials, `.env`, provider
configuration, or historical migration was changed. No provider action was
performed. New source is platform-owned, with no upstream artifact copied.

Verification: all 47 PostgreSQL tests passed, including successor
downgrade/reupgrade and three new directory-security cases. All five isolated
Inbox/cross-channel TypeScript integration tests passed, including team listing,
assignment/unassignment and rejection of a non-member. The actual localhost
Inbox query chain also passed with the `.env` runtime role `platform_web`.
Workspace TypeScript tests/typechecking, ESLint, Prettier, Ruff, production
workspace/Next.js build, offline SQL/graph/contract validation, and repository
guards passed. Schema-manifest head/function inventory updated; existing
Or-on migrations and dependency versions unchanged. Phase 6 as a whole remains
in progress; this repair does not close P6-011 or adapter-parity work.

### Phase 6 continuation audit — 2026-09-02

Clean continuation baseline: `34a14ac08b8b570d2ab890648c9b9261399cdd27`.
The prior P6-010 command queued work that the messaging worker rejected as
unsupported. This checkpoint adds a literal simulator-only consumer, consent
checks at admission and execution, owned-lease locking, atomic message/receipt/job
completion, and payload-aware idempotency. It does not enable real follow-ups.
No historical failed jobs are silently replayed; authorize a fresh simulation
after checking consent. The seed-idempotency test now uses an isolated database
because its fixture password hash must never overwrite the developer login.

All new live worker fixtures create and drop their own UUID-named localhost
database, execute under `platform_web` / `platform_messaging` roles, and use
provider spies that reject any send. The CI database job now runs this suite.
Local checkpoint verification:

- New payload unit tests: 4 passed; isolated live worker tests: 4 passed.
- Existing CRM live transaction test: passed; PostgreSQL suite: 44 passed.
- TypeScript workspace: 79 passed, 7 opt-in tests skipped; the new worker tests
  and CRM live test were also executed explicitly as recorded above.
- Python: 637 passed, 45 skipped (live suites/provider eval opt-ins); all 44
  database tests also executed explicitly. The first unisolated defaults-test
  run failed after retained code loaded the operator's enabled flag; the test
  now removes environment overrides before testing defaults. Tests rerun with
  real-provider flags disabled without modifying `.env`.
- Strict TypeScript checks, ESLint, Prettier, Ruff, production workspace/Next.js
  build, generated contract freshness, offline DB graph/contracts, repository
  boundaries, documentation links, and secret checks passed.
- PostgreSQL is healthy; one unchanged Alembic head `a1a71d1f7a03`.
- Full Python typing check passed (existing suppressions retained). JavaScript
  dependency audit is clear; Python audit passes with the pre-existing
  `PYSEC-2026-3740` exception through 2026-09-09, not an unconditional clean bill.
- CI is configured, not claimed to have run remotely. No upstream artifact was
  copied. All three upstreams remain clean at their locked SHAs.

### Phase 6 voice consumer completion

Continuation baseline: clean `7a9657f92678b4b225221736b8a30d0f7003bf78`.
All three upstream repositories verified clean at locked SHAs. New revision
`3f6133842389` adds a voice-job-only claim function and restrictive role policy.
The control API owns the simulator poller lifecycle, with cancellation before
database disposal. A narrow eligibility function locks current consent,
contact/conversation ownership, membership and account status; no messaging or
identity table access is granted to the voice role. Historical jobs lacking
actor attribution fail closed rather than impersonating an operator.

Claim, retained simulator session/events, audit/outbox and job completion commit
atomically. Failed effects roll back to a savepoint; bounded exponential retry
with jitter persists only fixed safe error codes. Nine isolated PostgreSQL tests
cover concurrency/replay, revoked consent, blocked contact, wrong tenant,
disabled actor, malformed mode/missing actor, rollback/retry exhaustion and
expired final-lease recovery. Six TypeScript worker integration tests include a
real PostgreSQL cross-language inbound→CRM→Python call→WhatsApp follow-up chain.
No external provider called; developer `.env`, credentials and queues untouched.
Offline graph/SQL/security checks pass with one head and 22 preserved revisions.

That checkpoint's next task (adapter configuration/parity) is closed below.

### Final Phase 6 acceptance — 2026-09-02

Continuation baseline: clean `7a9657f92678b4b225221736b8a30d0f7003bf78`.
Implementation commits: `7f6881a` (atomic voice consumer) and
`0b1e26c771b28135cccd226f7d6623f6aa0de8e0` (configured canonical execution).
This documentation checkpoint records acceptance, not a new feature phase.

| Check                       | Final evidence                                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python suite                | `uv run --no-sync pytest -q -p no:cacheprovider`: 639 passed, 58 skipped. Live PostgreSQL cases were separately executed below; the external LLM evaluation remains intentionally unrun. Native retained Pipecat binder test passed with the installed optional voice group. |
| PostgreSQL and retained RLS | Fresh UUID-named PostgreSQL 18.6 database, full upgrade, `pytest db/tests/postgres packages/py/oron-db/tests/test_rls.py`: 58 passed; includes downgrade/reupgrade, catalog, grants, RLS, concurrency, replay, seed isolation and importer tests.                            |
| Cross-channel integration   | `call-followup.live.test.ts`: 12 passed in a separately migrated/seeded disposable database, using actual web/messaging/voice role privileges. Both complete simulator paths, template ordering, actor revocation, expiry, bad mode and failed child behavior verified.      |
| Messaging regressions       | `database.live.test.ts`: 2 passed in another disposable database; simulator campaign and signed/deduplicated delivery-status processing, no real Meta traffic.                                                                                                               |
| TypeScript workspace        | `pnpm test`, `pnpm typecheck`, `pnpm build`: passed; Next.js 16.3.3 production build includes the new simulate route. New API/UI cases verify mutation guard, RBAC, disabled OpenLive and labeled simulator controls.                                                        |
| Formatting / typing         | Prettier, ESLint, Ruff check/format, Pyrefly configured target paths: passed. Existing retained typing suppressions/deprecation warnings remain; no new suppressions introduced.                                                                                             |
| Contracts / architecture    | `pnpm contracts:check`, `scripts/db_verify.py offline`, repository/document/secret guards and `pnpm peers check`: passed. No generated HTTP contract drift.                                                                                                                  |
| Migration graph             | One head `50a6befe7903`, root `0001`, 39 revisions including all 22 preserved Or-on revisions; historical branch merges unchanged. Deterministic SQL: 150800 bytes, SHA256 `62c401c51eb0999384dbe4c0316c1b2c666092d965842de9eaa9ba2cbe24abb6`.                               |
| Containers                  | Production control-api and web Docker builds passed without sibling repositories; control API + new adapters import in the built image with `--network none`. No dev application container restarted.                                                                        |
| Security scans              | pnpm audit: no known vulnerabilities. pip-audit: no unexcepted vulnerabilities; existing `PYSEC-2026-3740` exception expires 2026-09-09. Local workspace packages are not registry-auditable. Tracked-file secret scan passed after staging new files.                       |
| Existing localhost database | Only successor migrations `3f6133842389` and `50a6befe7903` applied from `9d3038bec65e`; `alembic current --check-heads` passes. PostgreSQL container healthy. No dev seeding, login reset or queue replay.                                                                  |
| Scope / integrity           | All three upstreams clean at locked SHAs; no upstream modifications, new dependencies, real sends/calls, webhook/provider mutations, cloud actions or Terraform apply. `.env` and development login untouched.                                                               |

The existing `make verify` runner requires default-off provider configuration;
its underlying checks were run directly with process-local disabled flags instead
of editing the user's enabled `.env`. No claim is made that remote GitHub CI ran.
Tests create/drop only their UUID-named databases, never customer/development data.

Acceptance is **simulator-first**, for the six explicitly supported canonical
actions. It is not full WACRM advanced-automation parity, real voice execution,
production pricing, production readiness, or OpenLive integration. Native voice
binding is verified without carrier/LLM/audio traffic. Known warnings and the
time-limited security exception remain documented rather than suppressed.

Local follow-up: restart the host development runner to load the new consumer
and web/worker build (`uv run python scripts/dev.py dev`). Migrations are already
applied. Review outstanding real WhatsApp jobs before restarting an enabled
worker, since it may resume previously approved sends. Do not bootstrap/seed to
refresh code. Phase 7 UI/UX polish is the next agreed phase, not begun here.

## Phase 5 implementation state

Phase 5 was prepared from the clean Phase 4 head
`e6d2e303c07a3a0df35e39d30baf1f5584564464` on
`codex/phase-5-telephony`. The target and all three upstream worktrees were clean;
Or-on, WACRM, and OpenLive matched their locked commits. The master scope,
completed Phase 0–4 evidence, Or-on instructions/README, package manifests,
routes/models/tests, LiveKit/SIP deployment documentation, preserved target
migrations, target Python service rules, and existing architecture decisions were
reviewed. No application code, dependency, migration, provider configuration, or
runtime state changed during preparation.

The first implementation checkpoint `f2c966e` completed the compatibility and
license gate and imported `oron-common`, `oron-db`, and `oron-flows` under their
original package identities. The selected Python 3.14 dependency set imports,
the isolated voice dependency set and target environment have no known audited
vulnerabilities, and 115 low-level tests pass with only the live-DSN and external
LLM cases skipped in the ordinary run. The RLS helper test separately passes
against local PostgreSQL. No model, provider, LiveKit, SIP, or real-call path was
activated.

Checkpoint `5fc6391` imported and adapted `oron-secrets`, `oron-tenancy`, and
`oron-sessions` while preserving their package identities and dependency
direction. Provider identities now bind through
`platform.identity_bindings`, roles match the canonical membership model, and
the retained API-key model matches the Phase 4 table. Sensitive configuration
uses redacted types, all real-telephony construction is denied unless the
explicit flag is true, and the packages remain unmounted until the canonical
Phase 5 API/auth boundary is ready. Verification passed with 249 offline Python
tests, strict production-source type checking, all TypeScript tests/contracts,
the Next.js production build, clean dependency/security guards, and 35 live
PostgreSQL 18.6 tests at the sole Alembic head `b56eb0a0aca1`.

Checkpoint `0b16ccb` completed the target-owned voice bridge at generated
Alembic revision `e24340ce81c8`. The preserved `sessions` table remains the only
call record and now has nullable, tenant-consistent links to canonical contacts,
campaigns, actors, and object metadata plus scoped provider/request idempotency.
Retained voice campaigns and audience rows link to their canonical parent and
CRM contact without fabricating relationships for historical rows. Ordered,
append-only `session_events` add lifecycle detail under fail-closed RLS while
`ops.outbox_events` remains the delivery authority. Deterministic offline SQL,
fresh upgrade and supported downgrade/re-upgrade, 38 live PostgreSQL tests, 251
offline Python tests, the consolidated verification/build, and both dependency
audits pass.

Checkpoint `8d903a6` completed P5-007. The first canonical voice endpoint lists
retained call sessions through the least-privilege `platform_voice` role after
the web BFF resolves a Phase 3 session, applies RBAC, and issues a short-lived,
audience-bound assertion. FastAPI OpenAPI remains authoritative and the
generated TypeScript client is freshness-checked. Both production containers
build and become healthy, and a fictional local login reaches the same-origin
voice BFF with `200` while returning no calls. The full gate passes with 255
offline Python tests, 38 live PostgreSQL tests, all TypeScript suites, strict
typing, production builds, repository/secret guards, and clean dependency
audits. No provider operation occurred.

Checkpoint `7a56c78` completed P5-008. An authenticated, CSRF-protected,
development-only BFF command now invokes the generated control API client with
`voice:write`; the Python boundary accepts only literal simulator mode. One
least-privilege PostgreSQL transaction creates the retained terminal session,
six ordered lifecycle records, six durable outbox records, and one immutable
safe audit record. Replaying the same tenant/idempotency key returns the same
session with no duplicate writes, while rebinding it to another contact fails.
The real-provider authorization primitive separately requires both the trusted
feature flag and per-action approval, and no provider adapter is reachable.
Container E2E returned `created=true` then `created=false`, and the call appeared
once in the authenticated list. The full gate passes with 257 offline Python
tests and 39 live PostgreSQL tests plus all TypeScript, contract, typing, build,
and security checks.

Checkpoint `49c1d6d` completed P5-009. The retained `oron-dispatcher` package
preserves one-agent-per-room orchestration, signed LiveKit webhook verification,
fail-closed DID admission, browser-room lifecycle, and LiveKit SIP request
semantics behind canonical ports. Firebase/admin coupling is absent; internal
dial commands require a short-lived `dispatcher` audience assertion and
`voice:dial` capability. Verified deliveries are claimed in PostgreSQL before
handling and deduplicate durably. Persistence must succeed before launch or
dial, outbound identifiers are deterministic, and the lowest SIP boundary
independently enforces the feature flag, per-action approval, and configured
trunk. Alembic head `315710614ae5` grants `platform_voice` only the needed
webhook-ledger privileges. Focused tests passed 24/24, the full Python suite
passed 274 with 42 intentional skips, and the live PostgreSQL 18.6 suite passed
41/41. The consolidated JavaScript gate could not start because this shell has
Node 24.19.0/pnpm 11.19.0 while the recorded baseline requires Node
24.20+/pnpm 11.24+; requirements were not weakened and no TypeScript source was
changed in this checkpoint.

Checkpoint `34a62e2` completed P5-010 by importing the retained `oron-hebrew` and
`oron-agent` packages, preserves their Pipecat/LiveKit/media/flow behavior, and
injects a task-owned launcher into dispatcher composition. Voice providers and
model loading remain independently default-off. Renikud and ECAPA accept only
checksum-verified local assets and have no download fallback. Heavy/native
packages are isolated in the opt-in uv `voice` group; ordinary workspace sync
and dispatcher imports stay lightweight. The focused retained suite passes 349
tests with three P5-011 deployment-wiring skips; Ruff, strict Pyrefly,
repository-policy, and secret checks pass. No provider or model network action
occurred.

Checkpoint `5eef886` completed P5-011 with a digest-pinned, opt-in Compose voice
profile: Redis 8.10.1, LiveKit Server v1.13.6, and LiveKit SIP v1.13.0. All
containers become healthy; a read-only SDK probe successfully lists inbound
trunks, outbound trunks, and dispatch rules, with a verified empty initial
state. Redis and SIP publish no host ports, while LiveKit binds only to
`127.0.0.1`. The three P5-010 deployment skips are now executable target config
assertions. The full gate passes 632 Python tests with 42 intentional
live/external skips, all TypeScript tests/strict checks, and the Next.js
production build. No trunk, rule, DID, participant, call, webhook, or provider
state was created or modified.

The authoritative implementation scope and acceptance gate is
[`phase-5-telephony.md`](plans/phase-5-telephony.md). It preserves the Or-on
engine and package identities, makes the existing `sessions` table the canonical
call record, replaces Firebase/admin-console coupling with canonical identity and
service authentication, and requires simulator-first end-to-end evidence.

## Phase 5 tasks

Status values: `pending`, `active`, `complete`, `blocked`.

| ID     | Task                                                                | Status   | Commit                                 | Verification evidence                                                                                                                                                                                                                                                                                                              | Next exact task                                                                                       |
| ------ | ------------------------------------------------------------------- | -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| P5-001 | Baseline, instructions, locked-source inventory, and Phase 5 scope  | complete | preparation checkpoint                 | Clean Phase 4 baseline `e6d2e303`; locked clean upstreams; actual Or-on packages/routes/models/tests/deployment inspected; authoritative scope recorded                                                                                                                                                                            | Begin the compatibility/license gate without importing source yet.                                    |
| P5-002 | Or-on dependency/version/license compatibility gate                 | complete | `f2c966e`                              | Current registry/official-source discovery; Python 3.14 isolated imports for Pipecat/LiveKit/native stack; isolated and target `pip-audit` clean; model-license download boundary documented                                                                                                                                       | Keep model assets blocked until immutable revision/hash/license records exist.                        |
| P5-003 | Import `oron-common`, `oron-db`, and `oron-flows`                   | complete | `f2c966e`                              | Original package identities retained; 115 passed/2 intentional skips; Ruff, Pyrefly, imports, repository guard, and real-PostgreSQL RLS helper test pass                                                                                                                                                                           | Preserve these dependency-direction anchors while integrating higher layers.                          |
| P5-004 | Import/adapt tenancy, secrets, and sessions packages                | complete | `5fc6391`                              | Package identities/direction preserved; provider-neutral identity binding, redacted secrets, default-off telephony, 249 offline Python tests, and dependency audit pass                                                                                                                                                            | Mount only through the later canonical API/service-auth boundary.                                     |
| P5-005 | Reconcile imported models with canonical identity/RLS/schema        | complete | `5fc6391`                              | Retained identity, role, and API-key models match canonical tables; repository boundary guard passes; 35 live PostgreSQL tests pass at sole head `b56eb0a0aca1`                                                                                                                                                                    | Add new behavior only through an Alembic successor.                                                   |
| P5-006 | Canonical call/contact/campaign/object/event bridge migration       | complete | `0b16ccb`                              | Generated successor `e24340ce81c8`; deterministic one-head SQL; tenant-consistent contact/campaign/object/session FKs; scoped idempotency; append-only RLS events; 38 live PostgreSQL tests                                                                                                                                        | Keep `sessions` authoritative and emit transport events through the outbox.                           |
| P5-007 | Control API voice routes and generated TypeScript client            | complete | `8d903a6`                              | Authenticated `GET /api/v1/voice/sessions`; canonical RBAC and tenant assertion; `platform_voice` RLS query; deterministic OpenAPI/client; container and same-origin login/BFF proof; full verification clean                                                                                                                      | Preserve this read-only contract while adding mutations through the simulator-first command boundary. |
| P5-008 | Telephony simulator and real-provider denial boundary               | complete | `7a56c78`                              | CSRF/RBAC/service-auth command; deterministic PostgreSQL lifecycle/outbox/audit; replay idempotency and contact-conflict test; 39-test live gate; production-container E2E; both real-action gates tested                                                                                                                          | Keep the simulator as the default adapter and never add a fallback to real transport.                 |
| P5-009 | Import/adapt dispatcher and LiveKit webhook contracts               | complete | `49c1d6d`                              | Signed fixture/tamper/replay tests; canonical assertion/capability tests; DID/persistence/trunk/default-off tests; sole head `315710614ae5`; 41 live PostgreSQL tests; no provider call                                                                                                                                            | Keep runtime not-ready until the retained P5-010 agent launcher is injected.                          |
| P5-010 | Import/adapt Hebrew and Pipecat voice-agent packages                | complete | `34a62e2`                              | 349 passed/3 explicit P5-011 skips; full Python suite 622 passed/45 intentional skips; Ruff and strict Pyrefly pass; model path/hash, secret redaction, default-off provider gate, launcher injection, base/voice dependency isolation, repository and secret guards verified                                                      | Keep all real provider execution denied while building the opt-in control-plane profile.              |
| P5-011 | LiveKit/SIP/Redis opt-in Compose voice profile                      | complete | `5eef886`                              | Digest pins verified; Redis/LiveKit/SIP healthy; read-only SIP lists returned 0 inbound, 0 outbound, 0 rules; Redis/SIP have no host bindings; 63 focused and 632 full Python tests pass; TypeScript strict/test/build gate passes                                                                                                 | Keep this profile mutation-free while adding canonical DID admission APIs.                            |
| P5-012 | Phone-number/DID admission and reconciliation                       | complete | `a246bf3`, `7b45140`                   | Authenticated simulator admission requires a published flow and restricted non-empty ACL; catch-all denial and read-only provider-disabled reconciliation pass; no provider mutation                                                                                                                                               | Keep real DID/trunk changes behind a separate approved action.                                        |
| P5-013 | Voice flow catalog, validation, publishing, and adapter UI          | complete | `a246bf3`, `7b45140`                   | Retained component catalog, typed validation, immutable PostgreSQL versions, generated client, and unified authoring surface pass                                                                                                                                                                                                  | Phase 6 owns the cross-channel compiler.                                                              |
| P5-014 | Canonical voice campaigns and CRM audience integration              | complete | `a246bf3`, `7b45140`                   | Explicit voice consent, usable E.164 identity, IANA calling window, DB concurrency/attempt bounds, and per-campaign/contact idempotency pass on PostgreSQL 18.6                                                                                                                                                                    | Real dialing remains disabled.                                                                        |
| P5-015 | Calls overview/detail and contact call action                       | complete | `a246bf3`, `7b45140`                   | Authenticated calls/detail routes and consent-gated contact simulator action render through same-origin BFF contracts                                                                                                                                                                                                              | No carrier fallback exists.                                                                           |
| P5-016 | Transcript, outcome, artifacts, usage, latency, and analytics       | complete | `a246bf3`, `7b45140`                   | Ordered lifecycle includes transcript/outcome/usage/latency; deterministic object metadata and overview/detail metrics persist under tenant RLS                                                                                                                                                                                    | Binary recording/media remains object-storage work, never PostgreSQL bytes.                           |
| P5-017 | Observability, audit, provider diagnostics, and security controls   | complete | `a246bf3`, `7b45140`                   | Correlated control API, safe audit metadata, read-only provider diagnostics, bounded policy values, scenario/idempotency conflicts, and default-off provider gates pass                                                                                                                                                            | Full production telemetry export is a later deployment concern.                                       |
| P5-018 | Unit, contract, PostgreSQL, RLS, simulator, and concurrency tests   | complete | `a246bf3`, `7b45140`                   | 41 live PostgreSQL tests plus control contract and web render suites pass; retained runner/dispatcher/concurrency suites remain in the full gate                                                                                                                                                                                   | Run consolidated P5-021 verification.                                                                 |
| P5-019 | UI accessibility, responsive, keyboard, English/Hebrew/RTL checks   | complete | `7b45140`                              | Semantic labels, status text, keyboard-native controls, responsive grids, reduced-motion inherited tokens, direction strategy, and explicit LTR phone rendering are covered                                                                                                                                                        | Broader WCAG certification remains out of scope.                                                      |
| P5-020 | Provenance, parity, architecture, runbook, and threat-model updates | complete | `7f1164c`                              | Source map, parity matrix, telephony architecture/package boundaries, threat model, README, and runbook distinguish simulator proof from deferred carrier activation                                                                                                                                                               | Re-review before any real-provider approval.                                                          |
| P5-021 | Full Phase 5 verification and clean checkpoint                      | complete | `73b4553`, `413ba21`, final checkpoint | Doctor/bootstrap/migrate, deterministic offline database gate, 41-test live PostgreSQL 18.6 gate, 634 Python tests, all TypeScript suites, strict lint/type checks, generated contracts, Next production build, production images/core health, read-only LiveKit/SIP smoke, dependency audits, guards, and upstream integrity pass | Prepare Phase 6 scope without enabling a provider.                                                    |

## Phase 5 final verification snapshot

- Host/runtime: Git, Docker Engine 29.7.2, Compose 5.5.0, Node 24.20.0,
  pnpm 11.24.0, Python 3.14.7, uv 0.12.7, and GNU Make 4.4.1 pass
  `make doctor`. `make bootstrap`, `make migrate`, and
  `make migration-check` pass idempotently.
- Database: PostgreSQL 18.6 is healthy. The canonical Alembic graph has 34
  revisions, root `0001`, branch point `8eda5976c920`, and sole head
  `7beb64e1ff33`. Deterministic offline SQL is 128,470 bytes with SHA-256
  `581c17f523fb48e99e8e917113d8df5bf62068003db2c5b55c5ace9eab14b9c5`;
  18 offline database tests and all 41 isolated live PostgreSQL tests pass.
- Application: the consolidated `make verify` passes Prettier, ESLint, Ruff,
  strict TypeScript, Pyrefly, 634 Python tests with 42 intentional live/external
  skips, every TypeScript suite, deterministic OpenAPI/client freshness, all
  workspace builds, and the Next.js 16.3.3 production build with 33 routes.
- Containers: final control API and web production images build successfully;
  PostgreSQL, control API, and web are healthy on loopback-only host bindings.
- Voice profile: `make voice-up` generated ignored localhost-only credentials,
  brought Redis/LiveKit/LiveKit SIP healthy, and the read-only SDK probe reported
  zero inbound trunks, zero outbound trunks, and zero dispatch rules.
  `make voice-check` repeated the result and `make voice-down` stopped only the
  optional voice containers. No create/update/delete/dial/transfer API ran.
- Supply chain and boundaries: pnpm and pip audits report no known
  vulnerabilities; repository, secret, documentation, PostgreSQL-only,
  Alembic-only, generated-contract, package-boundary, and sibling-independence
  checks pass.
- Safety: all real-provider flags remained false. No telephone call, WhatsApp
  message, provider webhook mutation, carrier/DID/trunk/rule provisioning,
  external model download, or `terraform apply` occurred.

## Phase 3 starting state

Phase 3 branched from the current clean Phase 2B HEAD
`9ca3a022c2fb18a5d416b39aa7d1404f7910ae1b`. The target was clean, its sole
Alembic head was `f5e8b540dfeb`, and all three upstream worktrees were clean at
their locked commits before branching. Docker/PostgreSQL 18.6 is available;
GNU Make remains the only missing host command-surface tool, so the canonical
cross-platform runner remains the equivalent verification surface.

## Phase 4 starting state

Phase 4 branched from the clean Phase 3 head
`fdaabedfe0c6dd3586261a338f2fd82f904023d8` onto
`codex/phase-4-crm-whatsapp`. The target and all three locked upstreams were
clean. PostgreSQL 18.6, the canonical identity boundary, one Alembic head, and
the production core Compose stack were validated before Phase 4. The recovered
authoritative scope is recorded in
[`phase-4-crm-whatsapp.md`](plans/phase-4-crm-whatsapp.md).

## Phase 4 tasks

Status values: `pending`, `active`, `complete`, `blocked`.

| ID     | Task                                                       | Status   | Commit                          | Verification evidence                                                                                                                                           | Next exact task                                                                         |
| ------ | ---------------------------------------------------------- | -------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| P4-001 | Baseline, instructions, and Phase 4 reconstruction         | complete | `ab9100f`                       | Clean Phase 3 baseline; locked clean upstreams; master Phase 4 scope recovered; scoped rules and WACRM instructions read                                        | Complete code-level behavior inventory.                                                 |
| P4-002 | Locked WACRM behavior inventory and provenance plan        | complete | `ab9100f`                       | Contacts, inbox, provider, webhook, pipeline, broadcast, automation, and public API behavior inspected; provenance recorded without wholesale copying           | Keep mappings aligned as later slices land.                                             |
| P4-003 | Canonical CRM/messaging repository package                 | complete | `5d0ccea`                       | Strict `@or-on/crm`; tenant-transaction contacts, inbox, simulator, pipelines, metrics, unit and live tests                                                     | Extend through bounded domain modules only.                                             |
| P4-004 | Contacts, tags, notes, custom fields, and import           | complete | `3c5e335`                       | CRUD/archive, E.164 dedupe, tags, notes, custom values, deterministic CSV import, detail UI, live rollback tests                                                | Field-definition administration is incremental product work.                            |
| P4-005 | Shared inbox and conversation operations                   | complete | `ed7acb2`                       | Tenant-safe reads, unread/status, member-validated assignment, same-origin refresh, seeded inbox, responsive UI, authenticated routes                           | Replace polling only when a durable delivery transport is justified.                    |
| P4-006 | WhatsApp webhook and provider simulator                    | complete | `36c1674`, `e19b6dd`            | Simulator auth/CSRF/dedupe; disabled real route verifies exact raw bytes and persists unique inbound work before acknowledgement                                | Real Meta activation remains explicitly deferred.                                       |
| P4-007 | Human reply, delivery status, reactions, and quick replies | complete | `e19b6dd`, `ed7acb2`            | Idempotent simulator reply, canonical delivery history, status, reactions, quick replies; no provider traffic                                                   | Provider-specific manual retry waits for provider activation.                           |
| P4-008 | Pipelines, stages, and deals                               | complete | `5d0ccea`                       | Canonical board and persisted same-pipeline stage movement API/UI pass strict/live builds                                                                       | Rich deal editing is incremental product work.                                          |
| P4-009 | Templates, broadcasts, campaigns, and durable delivery     | complete | `e19b6dd`                       | Stable audience, idempotent jobs, claims/retry/leases, aggregates, live worker execution                                                                        | Meta delivery adapter remains deferred and disabled.                                    |
| P4-010 | Automation persistence and execution adapter               | complete | `ed7acb2`                       | Draft/publish and manual empty-graph adapter produce persisted succeeded traces without replacing mature engines                                                | Channel runtime adapters belong to their owning phases.                                 |
| P4-011 | Teams, settings, analytics, and notifications              | complete | `ed7acb2`                       | Metrics, canonical roster, workspace settings, notifications, safety UI                                                                                         | Invitations/role editing remain identity enhancements.                                  |
| P4-012 | Scoped public API and API keys                             | complete | `d664781`, `e19b6dd`, `ed7acb2` | One-time issue, keyed-HMAC storage, RLS, resolver, revocation, scoped contacts REST; live/E2E checks                                                            | Expand resources only with versioned contracts.                                         |
| P4-013 | MCP-compatible CRM tool surface                            | complete | `e19b6dd`                       | Three typed tool contracts expose safe reads and require explicit write confirmation                                                                            | Bind them to the unified MCP transport later.                                           |
| P4-014 | Messaging worker and PostgreSQL durable work               | complete | `d664781`, `e19b6dd`            | Narrow cross-tenant claims, `SKIP LOCKED`, leases, bounded retries, inbound completion, simulator delivery, live tests                                          | Add production metrics before provider activation.                                      |
| P4-015 | CRM/WhatsApp UI integration and accessibility              | complete | `ed7acb2`                       | Production render/build, semantic controls, authenticated HTTP pages, 390px visual check with zero horizontal overflow, explicit Hebrew direction unit strategy | Authenticated visual regression automation can be added without browser-held passwords. |
| P4-016 | Security, E2E, parity, provenance, and documentation       | complete | final checkpoint                | Architecture/runbook/provenance current; auth/CSRF, signature, HMAC API key, live RLS/claim tests and simulator/API E2E pass                                    | Re-review before real provider activation.                                              |
| P4-017 | Full Phase 4 verification                                  | complete | final checkpoint                | Live PostgreSQL, consolidated verify, production image/core health, simulator campaign, scoped API, audits, upstream integrity pass                             | Await explicit next-phase scope.                                                        |

## Phase 4 final verification snapshot

- Alembic: 31 revisions, sole root `0001`, sole head `b56eb0a0aca1`;
  deterministic offline PostgreSQL SQL is 120,763 bytes with SHA-256
  `ad6fdadccb189f9651016c60939a4a4ab5c7ba003a34ca2c34e13d336079f63b`.
- PostgreSQL 18.6: all 32 live tests pass, including RLS/roles, webhook
  idempotency, lease-safe claims, cross-tenant jobs, and scoped API-key
  resolution. The actual TypeScript worker delivered a three-recipient simulator
  campaign once and the fixture was removed.
- TypeScript: strict typechecks, ESLint/Prettier, 48 regular tests, production
  builds for every package/service and Next.js 16.3.3 pass. The two opt-in live
  TypeScript tests also pass when their database variables are supplied.
- Python: Ruff, Pyrefly, 35 offline tests, contract freshness, repository,
  secret, and documentation guards pass; live tests are separated into the
  explicit 32-test PostgreSQL gate.
- Production Compose: PostgreSQL, control API, and rebuilt web image are healthy.
  Authenticated HTTP acceptance passed settings, API-key issue/use/revoke,
  contact creation/archive, revoked-key denial, inbound dedupe, reply delivery
  history, durable campaign processing, and aggregate delivery.
- Responsive browser: the semantic login surface at 390×844 has labels and no
  horizontal overflow. Hebrew `rtl` and English `ltr` direction behavior remains
  covered by the application unit contract; no password was entered into browser
  automation.
- Supply chain: pnpm and pip audits report no known vulnerabilities. Provider
  flags remained false; no real WhatsApp message, call, webhook mutation,
  provider provisioning, or `terraform apply` occurred.

## Phase 3 tasks

Status values: `pending`, `active`, `complete`, `blocked`.

| ID     | Task                                            | Status   | Commit                          | Verification evidence                                                                                                                                                                                     | Next exact task                                               |
| ------ | ----------------------------------------------- | -------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P3-001 | Baseline and upstream verification              | complete | `523c8a2`                       | Clean target at `9ca3a02`; Or-on/WACRM/OpenLive clean at locked SHAs; instructions, architecture, ADRs, threat model, migrations, Next 16 bundled auth/security docs, and upstream identity code reviewed | Reverify before every later phase.                            |
| P3-002 | Current authentication technology discovery     | complete | `523c8a2`                       | Official docs/registries reviewed for Better Auth 1.7.2, Auth.js, Lucia, Keycloak, Argon2, jose, postgres, and Next.js 16                                                                                 | Re-evaluate only on a material requirements/framework change. |
| P3-003 | Authentication selection ADR                    | complete | `523c8a2`                       | ADR 0016 selects a narrow canonical PostgreSQL adapter and records candidate rejection rationale                                                                                                          | Keep Alembic and canonical membership authority.              |
| P3-004 | Identity threat-model refinement                | complete | final docs checkpoint           | Implemented and deferred identity controls separated in the living threat model                                                                                                                           | Re-review before public signup, OAuth, or MFA.                |
| P3-005 | Authentication database schema                  | complete | `0283226`                       | Generated revisions `c30e1edd7c7f` and live-found hardening successor `3efa5431c380`; one head                                                                                                            | Keep successor-only history.                                  |
| P3-006 | Password and token primitives                   | complete | `7de75c5`                       | Argon2id, 256-bit random tokens, HMAC-SHA-256 digests, constant-time comparison tests                                                                                                                     | Rotate policy only through compatibility review.              |
| P3-007 | Session lifecycle implementation                | complete | `7de75c5`                       | Login/resolve/idle+absolute expiry/rotate/revoke/status enforcement implemented and live-tested                                                                                                           | Add administrative session listing later.                     |
| P3-008 | Cookie and CSRF controls                        | complete | `7de75c5`, `e578b91`            | HttpOnly SameSite session cookie, session-bound CSRF token, external-origin/Fetch Metadata checks                                                                                                         | Apply shared guard to every future mutation.                  |
| P3-009 | BFF authentication endpoints                    | complete | `7de75c5`, `e578b91`            | Login/session/logout/tenant/live-grant same-origin routes pass host and production-container smoke tests                                                                                                  | No public signup/recovery claimed.                            |
| P3-010 | Tenant switching                                | complete | `7de75c5`                       | Membership revalidation, atomic digest rotation, old-token invalidation, audit                                                                                                                            | Extend UI only with real tenant management.                   |
| P3-011 | RBAC permission model                           | complete | `7de75c5`                       | Canonical owner/admin/agent/viewer matrix and deny tests                                                                                                                                                  | Domain object checks remain feature-owned.                    |
| P3-012 | PostgreSQL RLS context propagation              | complete | `7de75c5`                       | Transaction helper sets transaction-local tenant/user/role from server identity; existing live leakage/RLS suite passes                                                                                   | Use helper in each new TS repository.                         |
| P3-013 | Service-to-service authentication proof         | complete | `7de75c5`                       | Short-lived signed issuer/audience assertions with tamper/audience tests                                                                                                                                  | Replace shared secret with workload identity in GCP phase.    |
| P3-014 | WebSocket authentication contract               | complete | `7de75c5`                       | Capability-bound live-session grant and live-agent validation proof                                                                                                                                       | Bind to real OpenLive session during protocol port.           |
| P3-015 | Unified login and authenticated shell           | complete | `7de75c5`                       | Accessible login, server-enforced page redirects, identity/tenant shell; desktop and 390px browser QA passed                                                                                              | Extend only with real product modules.                        |
| P3-016 | Permission-aware navigation and command palette | complete | `7de75c5`                       | Shell is session-aware; unavailable modules remain visibly disabled and expose no fake actions                                                                                                            | Filter real future actions by typed permissions.              |
| P3-017 | Development seeds and simulators                | complete | `7de75c5`, `e578b91`            | Idempotent ignored auth material and deterministic two-tenant fictional operator seed; Compose-safe Argon2 literals                                                                                       | Never print or commit generated password.                     |
| P3-018 | Audit and observability integration             | complete | `7de75c5`                       | Login, tenant switch, and revocation write safe immutable audit events; route errors omit credentials                                                                                                     | Add metrics without identity cardinality leaks.               |
| P3-019 | Authentication security tests                   | complete | `0283226`, `7de75c5`, `e578b91` | 19 auth unit tests plus four live PostgreSQL identity tests within the 29-test database gate                                                                                                              | Expand with every new identity capability.                    |
| P3-020 | CI and dependency guards                        | complete | `e578b91`                       | Consolidated frozen install, formatting, lint, typing, tests, migration/live DB, audits, build, and repository guards pass                                                                                | Keep auth package/container build ordering explicit.          |
| P3-021 | Documentation consolidation                     | complete | final docs checkpoint           | ADR, architecture, threat model, README, auth runbook, runtime topology updated and link-checked                                                                                                          | Keep implemented/planned claims distinct.                     |
| P3-022 | Full Phase 3 verification                       | complete | final docs checkpoint           | Consolidated verify, offline/live database gates, production container auth smoke, responsive browser QA, audits, and final integrity all pass                                                            | Obtain an explicit Phase 4 specification before branching.    |

## Phase 3 final verification snapshot

- Canonical migrations: sole head `3efa5431c380`, 29 revisions, deterministic
  offline PostgreSQL SQL (111,106 bytes; SHA-256
  `a4621691353be602eea25877f65eff4ead691f7711cd44c94c978e2d5c4f9cc3`).
- Live PostgreSQL 18.6: upgrade/current and all 29 database tests passed,
  including four authentication lifecycle, grant, and last-owner tests.
- TypeScript: Prettier, ESLint, strict typechecks, 39 tests, every package/service
  build, and the Next.js 16.3.3 production build passed. Python: Ruff, Pyrefly,
  35 offline tests, contract freshness, and repository/security/docs guards passed.
- Production Compose: PostgreSQL, control API, and rebuilt web image are healthy.
  A real local BFF login/session/logout smoke test passed with two fictional tenant
  memberships; Argon2 hashes arrive intact through Compose configuration.
- Browser QA: semantic labels, keyboard-capable controls, centered desktop layout,
  and a 390×844 responsive viewport without horizontal overflow passed. No secret
  was entered into the browser automation surface.
- Supply chain: pnpm and pip audits reported no known vulnerabilities; private
  workspace Python distributions were correctly excluded from PyPI lookup.
- Safety: provider flags remained false; no telephone call, WhatsApp message,
  webhook mutation, provider provisioning, customer-data access, or
  `terraform apply` occurred.
- Host caveat: Docker/Compose are available and healthy; GNU Make remains absent.
  The exact cross-platform runner behind every Make target passed.

## Baseline verification

The Phase 1 branch was created from the then-current clean HEAD of
`codex/phase-0-audit`, not from a remembered Phase 0 commit.

| Repository      | Expected commit                            | Verified branch       | Result                                                                                        |
| --------------- | ------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------- |
| Target baseline | `93eb808e65f8edb1754c1940afe1949e7e18223a` | `codex/phase-0-audit` | Clean before branching; `AGENTS.md`, `MASTER_PROMPT.md`, and Phase 0 audit documents tracked. |
| Or-on           | `cece174f4d590a1b8a283d539dd66e08cc689aa9` | `master`              | Commit matched; worktree clean.                                                               |
| WACRM           | `98b5bd26e8feacacfd4b74ff58411acb8154d212` | `main`                | Commit matched; worktree clean.                                                               |
| OpenLive        | `849173cd1c8c17a95d600b17b428c301722bf5df` | `main`                | Commit matched; worktree clean.                                                               |

Phase 0 conclusions were rechecked against instructions, manifests, lockfiles,
Docker/deployment configuration, migration documentation, CI, and current code at
the locked commits. The verified conflicts remain: Firebase console identity in
Or-on, Supabase runtime coupling in WACRM, and SQLite/JSON business persistence in
OpenLive. These are required target adaptations; the surrounding working engines
remain preservation candidates.

## Phase 1 tasks

Status values: `pending`, `active`, `complete`, `blocked`.

| ID     | Task                                 | Status   | Commit    | Verification                                                                                                                                                                                  | Notes / next exact task                                                                                                        |
| ------ | ------------------------------------ | -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| P1-001 | Baseline verification                | complete | `b859efb` | Clean target baseline; exact upstream SHAs and clean worktrees verified                                                                                                                       | Baseline recorded above.                                                                                                       |
| P1-002 | Technology baseline discovery        | complete | `b859efb` | Official registries/docs; Node/pnpm, Python core, and Python voice/native compatibility gates                                                                                                 | Baseline selects Node 24 LTS, pnpm 11, Python 3.14, PostgreSQL 18, patched Next/React, and a documented TypeScript 6 fallback. |
| P1-003 | Architecture and ADR framework       | complete | `b859efb` | Required architecture documents and ADRs 0001–0015 reviewed; relative-link and sequence checks passed                                                                                         | Accepted decisions distinguish implemented controls from deferred direction.                                                   |
| P1-004 | Repository hierarchy                 | complete | `d380bf8` | Intended roots contain real code/config or a concise ownership README; no empty enterprise scaffold was created                                                                               | Future directories require real ownership and content.                                                                         |
| P1-005 | pnpm/TypeScript workspace            | complete | `a788acd` | Node 24.20, pnpm 11.24 frozen workspace; strict typecheck, 15 tests, all package builds, and Next production build pass                                                                       | Keep pnpm as the sole target JS package manager.                                                                               |
| P1-006 | uv/Python workspace                  | complete | `30635b9` | uv 0.12.7 sync, all four packages imported/built; Ruff, Pyrefly, and 8 pytest tests passed on Python 3.14.7                                                                                   | Preserve this runtime boundary when Or-on packages are imported later.                                                         |
| P1-007 | Typed configuration                  | complete | `e616fac` | TypeScript/Python validation, PostgreSQL-only URL checks, redaction, and default-off provider tests passed                                                                                    | Entrypoints inject these settings rather than reading environment variables in business code.                                  |
| P1-008 | PostgreSQL local infrastructure      | complete | `009357e` | PostgreSQL 18.6 named volume, loopback mapping, role bootstrap, health check, control API, and web Compose chain are healthy                                                                  | Preserve the named development volume; use separate disposable databases for integration tests.                                |
| P1-009 | Alembic foundation                   | complete | `4d99516` | Fresh PostgreSQL upgrade of all 27 revisions, `current --check-heads`, supported target-successor downgrade/re-upgrade, and non-empty historical backfill pass                                | Historical `0004` data downgrade is intentionally backup-based.                                                                |
| P1-010 | Contract architecture/proof          | complete | `a788acd` | Deterministic FastAPI OpenAPI, generated TypeScript client, versioned JSON Schema event contract, validation tests, and freshness workflow pass                                               | Expand only through versioned language-neutral contracts.                                                                      |
| P1-011 | Unified web shell                    | complete | `a788acd` | Next 16.3 production build, render tests, and live browser QA passed; readiness UI reports PostgreSQL outage honestly                                                                         | Product modules remain clearly marked planned.                                                                                 |
| P1-012 | Python service foundations           | complete | `30635b9` | Control API lifecycle/liveness/readiness tests pass; dispatcher and voice entrypoints import with dependency-safe/default-off lifecycle                                                       | Later phases integrate retained Or-on packages into these boundaries.                                                          |
| P1-013 | TypeScript service foundations       | complete | `a788acd` | Live-agent HTTP health/readiness and messaging-worker equivalent health lifecycle build, typecheck, and tests pass                                                                            | No OpenLive/WACRM business behavior has been ported.                                                                           |
| P1-014 | Design-system foundation             | complete | `a788acd` | Tokens, two themes, focus/reduced-motion rules, eight primitives, and render tests pass                                                                                                       | Extend incrementally when real source screens are integrated.                                                                  |
| P1-015 | Makefile developer workflow          | complete | `009357e` | All targets route through one provider-safe runner; bootstrap, migration, live DB, verify, Compose, and container paths pass through the underlying runner                                    | GNU Make remains absent, so literal `make ...` spelling is the only outstanding command-surface check.                         |
| P1-016 | Observability foundation             | complete | `a788acd` | Shared structured JSON logging, recursive secret redaction, service/environment fields, and safe health logging conventions pass tests                                                        | OpenTelemetry transport/export remains deferred.                                                                               |
| P1-017 | Security foundation                  | complete | `d380bf8` | Threat model explicitly separates implemented and planned controls; provider, config-redaction, secret-scan, DB-role, and dependency controls have tests/checks                               | Re-review before each deferred public/provider/auth capability ships.                                                          |
| P1-018 | CI foundation                        | complete | `5885b98` | Target-only jobs cover frozen TS/Python installs, database migration, contracts, architecture/security, audits, production build, and containers                                              | CI requires no sibling repository or provider/GCP credential.                                                                  |
| P1-019 | Dependency/prohibited-runtime guards | complete | `5885b98` | 15 Python tests plus repository, secret, and documentation scans pass; package cycles/directions, runtime imports, database images, migration authorities, and sibling references are checked | Audit docs and future one-time importers are deliberately excluded from runtime-import rejection.                              |
| P1-020 | GCP development architecture         | complete | `d380bf8` | One-VM resource contract, Terraform/core-provider constraints, Caddy edge direction, identity/secrets/backup design; no credentials or apply                                                  | Resource implementation and cost-bearing actions remain deferred.                                                              |
| P1-021 | Documentation consolidation          | complete | `d380bf8` | Required documents, relative links, README/runbooks, ADR index, threat model, and Phase 2 entry plan pass automated validation                                                                | Keep status claims aligned with implemented controls.                                                                          |
| P1-022 | Full verification                    | blocked  | `009357e` | Runtime/database/container gates and consolidated verification pass; doctor passes Docker/daemon and accepts Compose 5 after a compatibility fix                                              | Install GNU Make and run the literal `make ...` sequence; selected Node/pnpm remain repository-local.                          |

## Phase 1 runtime verification snapshot

- Passed on the ignored selected toolchain: Node 24.20.0, pnpm 11.24.0,
  TypeScript strict checks, 15 TypeScript tests, package/service builds, Next.js
  16.3.3 production build, peer check, and zero known pnpm vulnerabilities.
- Passed on uv/Python 3.14.7: Ruff format/lint, Pyrefly, 15 pytest tests,
  deterministic offline migration graph/SQL, and zero known audited Python
  vulnerabilities (local workspace distributions correctly skipped by PyPI audit).
- Passed: contract generation/freshness, browser shell/theme/command/health QA,
  repository/prohibited-dependency scan, secret scan, documentation/link scan, and
  sibling-independence check.
- Passed with Docker Desktop 4.89.0 / Engine 29.7.2 / Compose 5.5.0:
  PostgreSQL 18.6 health, live Alembic upgrade/current, idempotent seed,
  control-api readiness, both production Dockerfiles, and the full Compose core
  health chain including web-to-control-api calls.
- With the ignored compatibility toolchain on `PATH`, `doctor` passed Git 2.54,
  Docker/daemon, Node 24.20.0, pnpm 11.24.0, uv 0.12.7, and Python 3.14.7.
  Compose 5 is accepted as compatible with the v2-or-newer command surface.
  It correctly fails only for absent GNU Make. The ordinary global
  Node 25.9.0/pnpm 11.19.0 pair remains outside the selected baseline.

## Known blockers and risks

- Or-on repository licensing/ownership is not recorded in a repository license;
  the target remains private and no Or-on source is imported in Phase 1.
- Several speech/model assets have unresolved redistribution conditions; none are
  downloaded or bundled in Phase 1.
- GNU Make is unavailable on this host. Docker Engine/Compose are healthy.
  Global Node 25.9.0 and pnpm 11.19.0 are outside the selected Node 24.20/pnpm
  11.24 baseline; repository-local compatibility runs use ignored pinned
  toolchains.
- Real provider operations remain prohibited and default-off.

## Phase 1 handoff completed by Phase 2A

Mechanically inspect the target and complete locked Or-on Alembic graphs, prove
that the Phase 1 bootstrap revision was never live-applied, and reconcile them
into one canonical lineage before adding any WACRM- or OpenLive-derived schema.

## Phase 2A starting state

Phase 2A began from the current clean Phase 1 HEAD, not from a remembered short
SHA. Docker Engine, Docker Compose, GNU Make, and a live PostgreSQL 18.6 server
remain unavailable. Repository-controlled checks will run offline; all execution
claims that require PostgreSQL remain **PENDING LIVE POSTGRESQL VALIDATION — PHASE
2B**.

| Repository      | Expected commit                            | Verified branch            | Result                                                                  |
| --------------- | ------------------------------------------ | -------------------------- | ----------------------------------------------------------------------- |
| Target baseline | `20b46159078ec533a9891e6768d47595e35b7a7c` | `codex/phase-1-foundation` | Clean before branching; Phase 2A branch created from this exact commit. |
| Or-on           | `cece174f4d590a1b8a283d539dd66e08cc689aa9` | `master`                   | Commit matched; worktree clean.                                         |
| WACRM           | `98b5bd26e8feacacfd4b74ff58411acb8154d212` | `main`                     | Commit matched; worktree clean.                                         |
| OpenLive        | `849173cd1c8c17a95d600b17b428c301722bf5df` | `main`                     | Commit matched; worktree clean.                                         |

## Phase 2A tasks

Status values: `pending`, `active`, `complete`, `blocked`.

| ID      | Task                                               | Status   | Commit    | Evidence                                                                                                                                                                         | Pending live validation / next exact task                                                       |
| ------- | -------------------------------------------------- | -------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| P2A-001 | Baseline and upstream verification                 | complete | `109bf9e` | Mandatory target, audit, architecture, ADR, target migration, Or-on lineage, WACRM SQL/runtime, and OpenLive persistence sources read; exact clean SHAs verified                 | No live validation needed; baseline is fixed at Phase 1 `20b4615`.                              |
| P2A-002 | Inspect target + Or-on Alembic graphs              | complete | `4d9a219` | Mechanical metadata: 22 revisions, root `0001`, branch `8eda5976c920`, merge `8aa960fd77ec`, head `a41d2f6c2925`                                                                 | Continue successors from the preserved head.                                                    |
| P2A-003 | Reconcile Phase 1 bootstrap migration              | complete | `d67f8f7` | Phase 1 progress proves live upgrade/current were blocked; old revision retained outside active versions and content recreated at generated successor `34376836baf5`             | Live upgrade remains pending Phase 2B.                                                          |
| P2A-004 | Import/preserve complete Or-on Alembic lineage     | complete | `4d9a219` | All 22 revisions imported; IDs/parents/branch/merge/order preserved; three import paths and one offline-only guard documented                                                    | Live historical backfill remains pending Phase 2B.                                              |
| P2A-005 | Verify one canonical offline Alembic graph/head    | complete | `363189f` | 27 revisions; sole root `0001`, branch point `8eda5976c920`, sole head `f5e8b540dfeb`; deterministic SQL/static contract pass                                                    | Fresh live upgrade/current **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**.                   |
| P2A-006 | Canonical tenant/identity mapping                  | complete | `d67f8f7` | Or-on tenant/user/membership preserved; provider-neutral identity bindings and tenant invitations created                                                                        | RLS/membership execution pending Phase 2B.                                                      |
| P2A-007 | Database schema/ownership architecture             | complete | `109bf9e` | Historical Or-on tables stay in place; bounded new schemas and owners documented                                                                                                 | Catalog execution pending Phase 2B.                                                             |
| P2A-008 | WACRM migration inventory                          | complete | `109bf9e` | All 39 source SQL migrations have explicit disposition; zero unexplained                                                                                                         | Keep mapping aligned with generated revisions.                                                  |
| P2A-009 | Translate WACRM identity/account semantics         | complete | `d67f8f7` | Account→tenant, profile→user, member→membership, provider-neutral bindings/invitations                                                                                           | Membership/RLS execution pending Phase 2B.                                                      |
| P2A-010 | Translate WACRM CRM schema                         | complete | `69004e9` | Generated `a929e3f55c7a`: contacts/identities/tags/fields/notes/pipelines/stages/deals with composite tenant FKs                                                                 | Constraints/indexes/RLS pending Phase 2B.                                                       |
| P2A-011 | Translate WACRM messaging schema                   | complete | `69004e9` | Generated `2ef8ecd10c3d`: channels/conversations/messages/delivery/reactions/templates/quick replies/broadcasts                                                                  | Triggers/idempotency/RLS pending Phase 2B.                                                      |
| P2A-012 | Translate WACRM pipeline/campaign schema           | complete | `69004e9` | Canonical campaign parent coexists with preserved Or-on voice campaigns; messaging broadcast projection references parent                                                        | Live claim/aggregate behavior pending Phase 2B.                                                 |
| P2A-013 | Translate WACRM automation/flow schema             | complete | `42c21ad` | Generated `cebe5f87cf18`: definitions, immutable published versions, runs, step runs, validation and retry/error metadata                                                        | Trigger and RLS execution pending Phase 2B.                                                     |
| P2A-014 | Translate WACRM AI/knowledge/database semantics    | complete | `42c21ad` | Generated `cebe5f87cf18`: model metadata, sources/documents/chunks, PostgreSQL FTS GIN, usage records; pgvector is not required                                                  | FTS generation/query behavior pending Phase 2B.                                                 |
| P2A-015 | Supabase Auth/Realtime/Storage/RPC removal mapping | complete | `109bf9e` | Auth/context, Realtime, Storage, service-role, and every RPC classified                                                                                                          | Application adapters remain later-phase work.                                                   |
| P2A-016 | OpenLive persistence inventory                     | complete | `75aa1a2` | Actual SQLite schema/query code, legacy conversation migration, encrypted JSON stores, settings APIs, voice-profile files, browser-local keys, and ACP session references mapped | Keep map aligned with importer coverage.                                                        |
| P2A-017 | OpenLive PostgreSQL target schema                  | complete | `75aa1a2` | Generated `f5e8b540dfeb`: tenant/user-scoped chats, ordered messages, preferences, credential-referenced providers, object-backed voice profiles, and sessions                   | Constraints/RLS/grants pending Phase 2B.                                                        |
| P2A-018 | OpenLive legacy importer foundation                | complete | `55bdd64` | Explicit SQLite/JSON sources; deterministic UUID mapping/checksums, duplicate/conflict handling, secret-safe dry-run, canonical PostgreSQL writer, six fixture/unit tests        | Importer writes/idempotency ledger execution **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-019 | Canonical RLS policies for new tenant data         | complete | `75aa1a2` | Static fail-closed FORCE RLS policies exist for identity, CRM, messaging, automation, agents, objects, ops, audit, and live tables                                               | **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**.                                              |
| P2A-020 | Unified runtime roles/grants successor migration   | complete | `d67f8f7` | Generated successor defines six roles without privileged attributes and preserves legacy Or-on roles                                                                             | **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**.                                              |
| P2A-021 | Inbox/outbox/idempotency foundation                | complete | `42c21ad` | Generated `cebe5f87cf18`: inbound/outbox events and scoped idempotency keys with explicit uniqueness and schedules                                                               | Atomicity/deduplication execution pending Phase 2B.                                             |
| P2A-022 | PostgreSQL durable-job foundation                  | complete | `363189f` | Generated `cebe5f87cf18`: tenant-bound SECURITY DEFINER claims, leases, bounded attempts, `SKIP LOCKED`, exponential backoff+jitter, terminal failure                            | Concurrency/stale lease/retry behavior pending Phase 2B.                                        |
| P2A-023 | Audit/object metadata foundation                   | complete | `42c21ad` | Generated `cebe5f87cf18`: metadata-only object records and append-oriented audit records without runtime update/delete grants                                                    | Privilege/immutability behavior pending Phase 2B.                                               |
| P2A-024 | Index/constraint/pagination review                 | complete | `363189f` | Manifest checks 14 critical indexes; migrations define composite tenant FKs, E.164/provider/idempotency uniqueness, explicit deletes, and chronological keyset indexes           | Constraint/index catalog and query-plan behavior pending Phase 2B.                              |
| P2A-025 | Type/contract generation updates                   | complete | `363189f` | `db/contracts/schema-manifest.json` is a checked consumer catalog at head `f5e8b540dfeb`; existing OpenAPI/event generation remains fresh; no TS migration authority added       | Generate DB types only when a real TS repository consumes them.                                 |
| P2A-026 | Offline migration/security guards                  | complete | `363189f` | Graph/parent/one-head, deterministic SQL, RLS/FORCE/policy, index, extension, definer search-path, Supabase/public/privileged-role guards                                        | Live catalog behavior pending Phase 2B.                                                         |
| P2A-027 | Prepare Phase 2B live PostgreSQL tests             | complete | `363189f` | 18 collected PostgreSQL tests cover version/head/catalog/roles/RLS/tenant CRUD/domain grants/DDL/idempotency/FK/outbox/flows/FTS/jobs/importer/seed                              | All 18 are **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**.                                   |
| P2A-028 | Database architecture/migration documentation      | complete | `a311371` | Required architecture, lineage, WACRM/OpenLive maps, schema ownership, extension inventory, notices, and Phase 2B runbook pass the documentation/link guard                      | Maintain claims as Phase 2B evidence arrives.                                                   |
| P2A-029 | Full offline verification                          | complete | `a311371` | Dedicated offline gate, all Python/TS checks/tests/build, contracts, repository/secret/docs guards, and final upstream integrity pass                                            | Live/database execution checks remain Phase 2B only.                                            |

## Phase 2A final offline verification snapshot

- Alembic: 27 active revisions, sole root `0001`, preserved Or-on branch point
  `8eda5976c920`, merge `8aa960fd77ec`, sole head `f5e8b540dfeb`.
- Deterministic PostgreSQL SQL: 93,287 UTF-8 bytes, SHA-256
  `3d20637313b3471050fe5818949f349a65e97297bc8f380a3a3ead2c22574778`.
- Dedicated `db-verify-offline`: 15/15 focused graph/importer/static-contract
  tests passed, repository dependency guard passed, wire contracts fresh.
- Full Python: Ruff format/lint passed; Pyrefly passed for current packages,
  services, importers, tests, Alembic environment/compatibility code, seeds, and
  scripts; 29 tests passed and 18 PostgreSQL tests were correctly skipped with
  the Phase 2B status.
- Full TypeScript: format/lint/strict typecheck passed; 15 tests passed; all
  packages/services and the Next.js 16.3.3 production application built.
- Security/architecture: tracked-file secret scan, prohibited runtime database
  scan, sibling-independence scan, documentation/link scan, and peer dependency
  check passed.
- Vulnerability registry refresh: npm and PyPI advisory endpoints were blocked by
  this sandbox. Phase 2A changed no dependency manifest or lock version; the last
  Phase 1 scans were clean. CI retains both scans, so no fresh clean result is
  claimed for this run.
- Provider/cloud safety: no WhatsApp message, telephone call, provider webhook
  mutation, provider provisioning, customer-data access, or `terraform apply`.
- Final upstream check: Or-on, WACRM, and OpenLive remained clean at their locked
  SHAs.

At the Phase 2A checkpoint every server-executed item in
[`docs/migration/phase-2b-live-validation.md`](migration/phase-2b-live-validation.md)
was pending. The Phase 2B evidence below supersedes that historical status.

## Phase 2B live validation

Phase 2B branched from the clean Phase 2A head
`830a8371836ea7922fca5c320624bf3bd32ec229`. Validation used Docker Desktop
4.89.0, Engine 29.7.2, Compose 5.5.0, and the pinned PostgreSQL 18.6 Bookworm
image. The development database remains on its named volume; integration runs
used separate disposable databases.

| ID      | Task                                 | Status   | Commit               | Evidence                                                                                                                                                                                                                                                                                                                                                                     | Remaining work                                                                             |
| ------- | ------------------------------------ | -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| P2B-001 | Docker/toolchain readiness           | complete | `009357e`            | Engine/daemon and ports passed; doctor now accepts the Compose v2-or-newer command surface, including installed Compose 5.5                                                                                                                                                                                                                                                  | Install GNU Make for literal `make ...` acceptance spelling.                               |
| P2B-002 | Fresh migration and catalog          | complete | `4d99516`            | Multiple empty PostgreSQL 18.6 databases upgraded through all 27 revisions to sole head `f5e8b540dfeb`; catalog/extensions/functions/indexes and target-successor downgrade/re-upgrade checked                                                                                                                                                                               | Historical `0004` downgrade remains intentionally data-irreversible and requires a backup. |
| P2B-003 | Seed and readiness                   | complete | `009357e`            | JSONB seed fixed and proven idempotent; least-privilege `platform_web` readiness succeeds                                                                                                                                                                                                                                                                                    | None for the implemented seed.                                                             |
| P2B-004 | Roles and RLS automated suite        | complete | `009357e`            | Runtime attributes, FORCE RLS, missing context, cross-tenant CRUD, membership, `SET LOCAL`, role separation, DDL denial, and audit immutability passed                                                                                                                                                                                                                       | Broaden policy fixtures as new domain operations arrive.                                   |
| P2B-005 | Integrity/concurrency/importer suite | complete | `bb5c40d`            | Provider/message/E.164 idempotency, all 91 unified-schema FK delete declarations, representative CASCADE/RESTRICT/SET NULL execution, check constraints, outbox rollback, immutable flows, message/audit keysets, FTS, concurrent jobs, seed, OpenLive JSON/SQLite imports, and WACRM export mapping passed                                                                  | Extend fixtures when later domain operations add constraints.                              |
| P2B-006 | Full core runtime                    | complete | `009357e`            | PostgreSQL, control API, and web containers are healthy; host API and web BFF both report PostgreSQL ready; all ports are loopback-bound                                                                                                                                                                                                                                     | GNU Make remains a host-tool gap only.                                                     |
| P2B-007 | Consolidated verification            | complete | `009357e`            | Initial format, lint, strict typing, tests, contracts, production builds, container builds, guards, peer check, pnpm audit, and pip-audit passed                                                                                                                                                                                                                             | Superseded by the final P2B-009 rerun.                                                     |
| P2B-008 | Extended database acceptance         | complete | `4d99516`, `bb5c40d` | Non-empty encrypted `0004` backfill, supported successor downgrade/re-upgrade, complete FK delete-action catalog/family behavior, keyset pagination, SQLite importer writes, and WACRM importer idempotency all pass on disposable PostgreSQL 18.6 databases                                                                                                                 | No remaining Phase 2B database item.                                                       |
| P2B-009 | Final verification/checkpoint        | complete | final checkpoint     | Fresh 25-test PostgreSQL gate; 35 offline Python tests with 25 correctly separated live skips; 15 TypeScript tests; Ruff/ESLint/Prettier/Pyrefly/strict TypeScript; contracts; one-head check; Next production build; both production images; healthy core Compose chain; peer checks; repository/secret/docs guards; and zero known pnpm/pip-audit vulnerabilities all pass | Remote CI evidence remains separate; GNU Make is still a host-tool spelling gap only.      |

Live validation exposed and fixed four real integration issues: the seed passed
an invalid JSONB literal, the legacy importer passed timestamp strings instead
of timezone-aware values, the control API bound only to container loopback, and
the local runner allowed an unrelated ambient `DATABASE_URL` to override the
repository `.env`. The unsafe ambient endpoint returned unavailable; no external
schema or data mutation was performed. The runner now gives the explicit local
file precedence and provider flags remain false.

## Next exact task

Review and create coherent Phase 7 checkpoint commits from the verified working
tree. Do not re-seed fictional product records merely to repeat interaction
rehearsals: those simulator workflows were already accepted in Phase 6 and the
current request explicitly requires a clean workspace. Phase 8 infrastructure
and Phase 9 OpenLive/Live Lab remain separate, unstarted scopes.

## Historical Phase 7 public landing refinement (superseded)

This entry records an earlier direction. The landing page was subsequently
retired; unauthenticated entry now uses the product login and authenticated entry
uses the workspace.

- The approved Gateway Flow hero now anchors one continuous black/charcoal
  landing canvas; the previous gray and bright-blue section changes were
  removed.
- The public story is ordered as platform proof, operating sequence, customer
  continuity, channel control, governance, readiness, security, questions, and
  the final workspace action.
- Geist and Noto Sans Hebrew are self-hosted through Next font handling. Scroll
  reveals, staggered operational rows, heading transitions, hover states, and a
  reduced-motion fallback are implemented without changing product behavior.
- Rounded-card and decorative-gradient treatments were reduced in favor of
  editorial rules, square operational panels, restrained blue status signals,
  and a subtle charcoal background shift below the hero.
- Browser inspection covered English desktop and English/Hebrew compact widths;
  the compact layout has no page-level horizontal overflow and its horizontal
  operation tabs hide the native scrollbar while remaining swipeable.
- Verification: 22 focused public-page tests passed; targeted ESLint, strict
  TypeScript, formatting, and the Next.js 16.3.3 production build passed. The
  host still warns that Node `25.9.0` is newer than the repository's supported
  Node `>=24.20.0 <25` range.

## Guarded real voice integration checkpoint

- The development runner starts the retained dispatcher only when
  `ENABLE_REAL_TELEPHONY` and `ENABLE_REAL_VOICE_PROVIDERS` are both `true`;
  mismatched flags fail closed. Missing localhost field-encryption keys are
  generated only into the ignored `.env` without printing their values.
- `/contacts/[id]` now keeps simulator and carrier actions separate. The real
  path requires `voice:operate`, an active tenant-owned contact, granted voice
  consent, a valid E.164 identity, a published retained flow, a checkbox, and a
  final browser confirmation.
- The BFF exchanges the authenticated session for a short-lived
  `dispatcher`/`voice:dial` assertion. The dispatcher persists the lifecycle
  before calling LiveKit SIP and repeats the explicit flag/approval gate at the
  provider boundary.
- The PostgreSQL runtime resolves the published agent profile linked by the
  latest published canonical voice flow and combines its system prompt with
  the immutable retained flow. Generated revision `c718f92a2b71` grants the
  `platform_voice` role only schema usage and read access to canonical flow
  versions; no write or DDL authority was added.
- Live, non-dial verification against local PostgreSQL passed: the retained flow
  loaded, its published agent prompt resolved, the dispatcher booted with the
  configured cloud LiveKit/SIP profile, and both `/health/live` and
  `/health/ready` returned ready with zero active calls. No telephone call or
  provider mutation was performed.
- Real-call admission initially failed before dispatcher persistence because
  `platform_web` could not validate the selected RLS-protected retained flow.
  Generated revision `ea600fafe463` adds read-only access to `public.flows`;
  fresh PostgreSQL integration validation confirms the role still has no write
  privileges. Carrier-call failures now use a call-specific UI message rather
  than the misleading contact-update fallback.

### Voice latency rollback — 2026-09-10

- The experimental model-backed niqqud and mixed Soniox endpoint strategy were
  removed after live listening showed degraded Hebrew speech. The ignored model
  artifact was deleted and the local profile is back to `TTS_NIQQUD=false`,
  `TURN_START=min_words`, and `TURN_END=vad`.
- Only the VAD caller-pause floor changed, from 0.7 to 0.5 seconds. Together
  with `VAD_STOP_SECS=0.2`, this targets about 0.7 seconds from actual speech end
  to turn completion without returning to the earlier 0.3-second cutoff.
- The earlier explicit caller correction safeguard (`אני גבר`, `אני אישה`, or
  an explicit address-form request) remains intact. Acoustic guessing remains
  disabled. No real telephone call or provider mutation was performed.

### Latest-call quality review — 2026-09-10

- Reviewed the complete 194.5-second stereo artifact and transcript for session
  `6ac07b9a-5881-51e1-886d-85b17c39cb7a`. Caller audio had negligible clipping,
  agent audio had none, and no material cross-channel overlap was detected; the
  dominant defects were turn boundaries and response behavior rather than a
  damaged recording.
- Replaced fixed-silence turn completion with Soniox v5 semantic STOP proposals
  while retaining the local minimum-word START gate. The conservative endpoint
  controls are intended to preserve dictated identifiers and dates; fixed VAD
  remains an explicit rollback mode. This is not the earlier niqqud experiment:
  `TTS_NIQQUD=false` remains unchanged.
- Added natural spoken-Hebrew normalization for clock values and prefixed dates,
  kept terminal full-stop suppression, and strengthened runtime grounding so a
  tool-less flow cannot fabricate account checks, eligibility, schedule
  availability, or completed bookings. Unsafe requests now receive one short
  refusal and a safe alternative.
- Published retained voice flow version 2 in the local development database as
  an immutable successor: its structured speaker gender is female and its
  scripted outbound opening now uses matching Hebrew self-reference. Version 1
  remains unchanged as the provenance for the reviewed call.
- Verification: 50 focused tests passed, Ruff passed, and Pyrefly reported zero
  errors. The broader impacted-package run passed 408 tests; two unrelated tests
  could not open the already-deleted `.env.example`. No real call or provider
  mutation was performed. One new controlled call remains necessary to validate
  endpoint behavior acoustically.

### MVP conversation-quality hardening — 2026-09-10

- Reviewed the latest 115-second stereo call, session
  `7c20a89a-5ccf-5e13-99a0-7838b9f1f691`. Audio was intact; repeated reply
  gaps were approximately 1.6-2.0 seconds, and the caller's barge-in remained
  audible for about 0.65 seconds before the agent stopped. The transcript also
  showed overlong answers and inconsistent Hebrew address morphology.
- Outbound real-call admission now requires a deterministic male/female Hebrew
  address form. The value is carried through the BFF and dispatcher into the
  retained call context before the first generated response. Explicit
  first-person caller language remains authoritative and can correct it during
  the call; acoustic guesses cannot override either source.
- Added responsive asymmetric turn start: VAD interrupts an actively speaking
  agent immediately, while an idle agent still waits for a transcribed word.
  Soniox semantic endpoint defaults are now level 2, sensitivity 0.15, and a
  1000 ms maximum delay. Runtime instructions also bound ordinary replies to
  one short sentence, with a second sentence only when necessary.
- Global/model-backed niqqud remains disabled. Retained flow version 3 is an
  immutable successor containing only a reviewed pronunciation lexicon for
  observed platform and financial-domain words; versions 1 and 2 remain
  unchanged.
- Verification: 91 focused Python tests and 18 focused web tests passed; Ruff,
  Pyrefly, strict web typechecking, and targeted formatting passed. No real call,
  provider request, or provider mutation was performed. Human acoustic
  acceptance remains pending one explicitly authorized controlled call after
  restarting the development runner.

### Latest-call gender and prosody regression — 2026-09-10

- Reviewed the complete 75-second recording and transcript for session
  `7decf306-c42b-5d76-9f9d-c1d9ff5e9901`. Both audio channels were intact with
  no measured overlap or meaningful clipping. Caller-to-agent gaps were about
  1.65, 1.75, 1.95, and 3.35 seconds. The defects were generated wording and
  prosody: the male caller was addressed as `תוכלי`, and statements were joined
  to trailing questions without sentence boundaries.
- Root cause: Pipecat applies the flow/node `role_message` as the primary
  provider system instruction after initial conversation context. The selected
  caller form had existed only in the latter and could lose precedence to the
  female agent persona. The selected form is now merged into the flow-wide role
  and every node-specific role before binding.
- Added a narrow TTS-boundary safety layer for unambiguous second-person forms.
  It keeps `אני מבינה` as correct female-agent self-reference and does not
  globally rewrite the ambiguous Hebrew object marker `את`. Added a deterministic
  sentence break before a trailing direct question when the model emits a
  punctuation-free answer/question run-on.
- The exact three malformed agent utterances from the recording are regression
  fixtures. Verification: 70 focused tests passed; Ruff and Pyrefly passed with
  zero errors. No real call, network provider request, or provider mutation was
  performed. A restarted controlled call remains the acoustic acceptance gate.

### Full-turn prosody and address-form audit — 2026-09-10

- Reviewed the complete 56.4-second stereo artifact for session
  `137b35dc-b56a-5d11-bf23-5a03771f3095`. The acknowledgement and question in
  `תודה שעדכנת אותי איך אוכל לעזור לך היום?` had no internal silence longer
  than about 90 ms. The final answer similarly ran into `תוכל לבדוק זאת?`;
  a correctly punctuated turn elsewhere in the same call produced an audible
  pause of about 650 ms.
- Root cause: Pipecat applies text normalization only after its TTS aggregator,
  and Soniox reuses one context for chunks in a turn. The opening-clause fast
  path could therefore send text before a later filter knew it contained an
  answer followed by a question, while the terminal-dot safeguard removed the
  punctuation from each individual chunk.
- Added a bounded full-turn planner between the LLM and TTS. It collects the
  already capped one-or-two-sentence response, repairs missing answer/question
  boundaries with the complete context, and sends one canonical utterance so
  the full stop remains internal when Soniox receives it. Exact fragments from
  the reviewed call are regression fixtures, including a missing-question-mark
  case and interruption cleanup.
- The reviewed transcript contains masculine direct address (`תוכל`) twice.
  `אני מבינה` is the female agent's self-reference and `איזו תקלה` agrees
  with the noun, not the caller. Because the previous session record discarded
  the UI choice, the selected value cannot be reconstructed for this past call.
  New calls persist `voice.call.configuration.v1` with only the safe selected
  address form, and the final browser confirmation repeats the chosen form.
  Generic `אני מבינה/אני מבין` filler is removed before a substantive answer.
- Outbound dispatcher calls now require a typed male/female address form rather
  than accepting a missing value. Verification: 59 affected Python tests and
  13 contact/UI tests passed; focused Ruff, formatting, ESLint, and strict
  TypeScript checks passed. No real call or provider mutation was performed.
  A restarted controlled call remains the acoustic acceptance gate.

### Studio Admin-informed UI redesign foundation — 2026-09-10

- Began the product-wide redesign from `UI_UX_REDESIGN_MASTER_PROMPT.md` with a
  gap-led foundation slice rather than replacing working Phase 7 behavior.
- Replaced the earlier navy-first palette with neutral near-white and charcoal
  semantic surfaces, retained restrained blue interaction signaling, tightened
  radii and shadows, and centralized compact sidebar/header proportions.
- The desktop shell now begins with its grouped navigation expanded unless the
  user has explicitly saved the collapsed preference. Existing keyboard,
  command-search, mobile-drawer, tenant, language, theme, and session behaviors
  remain intact.
- Overview now presents four compact route-backed operational metric cards for
  open conversations, unread messages, messages today, and pending handoffs.
  The oversized single-metric composition and its superseded CSS were removed.
- Compact login layouts put the authentication surface before the supporting
  product story, keeping the primary task reachable without scrolling past the
  hero.
- Verification: 18 shared UI tests and 128 web tests passed. Shared UI and web
  strict type checks, scoped ESLint, Prettier, and `git diff --check` passed.
  Bilingual automated checks and Hebrew light/dark login review at 1440×900 and
  390×844 found no new console warning, clipping, or horizontal-overflow issue.
  A production build was not run while the existing development preview owned
  `.next`.
- Next redesign slice: consolidate workspace/account controls in the shell and
  redesign Inbox's list/thread/detail composition against the new neutral
  system before proceeding to Contacts and Pipeline.

### Latest-call punctuation and spoken-address correction — 2026-09-10

- Reviewed session `44f7799e-fe5b-52e0-808e-3913f94fdc72`. Its durable
  `voice.call.configuration.v1` event proves that the operator selected
  `caller_address_form=male`. The written reply also used masculine direct
  forms (`אתה`, `תוכל`), but unpointed homographs such as `לך` and `ניסית`
  remained acoustically ambiguous to TTS.
- The punctuation normalizer was not idempotent. It searched behind an
  already-correct sentence boundary and changed `אצטרך כמה פרטים`
  into `אצטרך. כמה פרטים`, and `לראות איך אפשר לעזור` into
  `לראות איך. אפשר לעזור`. It now inspects only the final unpunctuated clause,
  so a correctly separated answer and question remain unchanged.
- Added narrow caller-form pointing for common second-person homographs even
  while global/model-backed niqqud remains disabled. A male call now sends
  forms such as `לְךָ`, `נִסִּיתָ`, and `שֶׁלְּךָ` to TTS; a female call sends
  the corresponding feminine forms. The assistant transcript and LLM context
  remain clean, unpointed Hebrew.
- Generic opening `אני מבינה/אני מבין` filler is removed before a substantive
  response, reducing both delay and confusion between the female agent's own
  grammar and the selected caller address form. Verification: 45 focused
  Hebrew/turn-planner tests and Ruff passed. No real call or provider mutation
  was performed; 142 affected Python tests passed in the broader verification
  suite. Acoustic validation requires one restarted controlled call.

### Studio Admin-informed UI redesign completion — 2026-09-10

- Completed the product-wide redesign contract in
  `UI_UX_REDESIGN_MASTER_PROMPT.md` without copying the reference dashboard or
  importing its demo-only modules. The existing product routes, permissions,
  live data, mutations, English/Hebrew behavior, and light/dark modes remain the
  source of truth.
- Reorganized the authenticated shell around a persistent grouped sidebar:
  workspace, tenant, account, language, theme, help, and logout controls now
  share a consolidated footer account surface. The compact top bar is reserved
  for current-page context, command search, and service health. Mobile uses a
  dedicated four-part header and accessible navigation drawer.
- Replaced the promotional two-column sign-in composition with a focused,
  centered access card. Authentication controls remain first in the reading
  order and fit at the 390-pixel mobile acceptance width without horizontal
  overflow.
- Applied the neutral design system across Overview, Inbox, Contacts, contact
  detail, Pipeline, Operations, Orchestration, Flows, Voice, voice campaigns,
  call detail, Settings, and System health through shared surface, table,
  field, metric, spacing, radius, shadow, and responsive contracts. Overview
  now exposes four real-data, route-backed operational metrics instead of the
  oversized single-metric hero.
- Verification: 133 web tests and 18 shared UI tests passed. Strict TypeScript,
  scoped ESLint, Prettier, `git diff --check`, and the Next.js 16 production
  build passed. Desktop and 390×844 light-theme browser review plus dark-theme
  token review found no console warnings or errors.

### Three-minute call language and grounding audit — 2026-09-10

- Reviewed the complete transcript and runtime configuration for session
  `e83f8035-8e5e-576c-9e79-39511367129f`. The operator-selected address form
  was durably recorded as male. The resulting spoken text used male forms, but
  exposed additional punctuation, identifier-reading, spelling, verbosity,
  and grounding defects.
- Fixed the remaining false question split that changed
  `תוך כמה זמן תרצה...` into `תוך כמה זמן. תרצה...`. An early question cue now
  marks the complete clause as interrogative instead of allowing a later verb
  to create a second boundary.
- Numeric hyphens are no longer presumed to be time ranges. Only explicit clock
  ranges or labelled hour ranges become `עד`; telephone/identity-length digit
  sequences are read digit by digit. This prevents `52-1234567` becoming
  `חמישים ושניים עד...`.
- Added narrow spoken corrections for the observed `מסבר` typo and Latin
  `HDMI`/`WhatsApp` tokens. Automatic transcript correction remains deliberately
  narrow because changing uncertain caller speech would be unsafe.
- The retained flow exposes only routing/exit functions, yet the model claimed
  it found a subscriber, opened a service request, scheduled a technician, and
  would send WhatsApp. Added a final spoken-boundary business-claim guard and a
  matching runtime rule. Until verified business tools are implemented, those
  claims and requests for a full identity number fail closed to a short human
  follow-up. Full sensitive identifiers must not be repeated aloud.
- Verification: focused suites and 159 broader Hebrew/voice/dispatcher tests
  passed; Ruff and formatting checks passed. No provider call, message, ticket,
  booking, or external mutation was performed. A restarted controlled call is
  still required for acoustic acceptance.

### Studio Admin full-product replica — 2026-09-11

- Replaced the rejected presentation layer with a complete Studio Admin-derived
  product shell and route system, pinned to reference commit
  `47e2d4384574d86f2b21d297ee6486da3f5cc01b`. The implementation uses the
  reference's 272-pixel sidebar, 48-pixel header, neutral OKLCH palette, Geist
  typography, compact controls, ten-pixel cards, grouped navigation, command
  search, and footer account surface.
- Applied route-specific Studio patterns across Overview, Inbox, Contacts,
  contact details, Pipeline, Messaging campaigns/automations/history, Voice
  calls/numbers/campaigns/flows, call details, Agents/flows/activity/handoffs,
  System health, all eight Settings categories, Login, Invite, Start, loading,
  empty, error, and not-found states. Or-On data, permissions, API boundaries,
  simulations, drafts, mutations, English/Hebrew direction, and light/dark
  behavior remain intact.
- Removed reference-only/demo material: Studio sample data, unrelated routes,
  GitHub/support promotion, and functions that Or-On does not provide. The
  complete route-to-reference mapping and exclusions are documented in
  `docs/plans/studio-admin-product-replica-2026-09-11.md`.
- Verification passed: 44 web test files and 199 tests; strict TypeScript and
  route generation; `git diff --check`; and a production build covering 45
  routes. A 62-screen production capture covered 1440px English/light and
  390px Hebrew/dark with zero console errors, failed responses, viewport
  overflows, or missing primary headings. Interaction audits also passed 30
  Inbox/Contacts checks, 75 Voice/Messaging/Orchestration checks, and 48
  Settings checks with no failures or runtime errors.

### Tenant operations and Studio Inbox completion — 2026-09-11

- Rebuilt Inbox around the Studio Chat composition: dedicated channel rail,
  queue, conversation, composer, responsive single-pane navigation, truthful
  channel labels, route-backed search, configured-timezone formatting, and
  keyboard-contained channel/contact drawers. The 64–70rem context-panel gap
  and compact focus-return paths are covered by regression tests.
- Added tenant Finance, Email, Calendar, Tasks, Profile, Users, and Roles
  routes to the shared shell. Finance, Tasks, and Calendar use tenant-scoped
  PostgreSQL repositories and API routes; expense and calendar pagination is
  explicit, multi-currency amounts are not mixed, cancelled records are
  retained, and Calendar converts and groups wall-clock values in the tenant's
  IANA timezone with DST-gap validation.
- Email exposes live configured channel state and honest Gmail/Outlook setup
  requirements. Provider connection stays disabled until OAuth registrations,
  encrypted token storage, and a sync worker are configured; no provider flow
  or fake successful connection was introduced.
- Added `finance.expenses`, `crm.tasks`, and `crm.calendar_events` through one
  Alembic head with forced tenant RLS, least-privilege grants, and tenant-safe
  membership foreign keys. Profile, member invitations, role assignment, and
  permissions reuse the existing authenticated backend paths.
- Acceptance passed: 47 web test files / 224 tests, 53 CRM tests with 10
  environment-gated skips, 21 auth tests, 31 migration/fixture contract tests,
  repository-wide ESLint, web/CRM strict type checks, Ruff, `git diff --check`,
  and the Next.js production build. A fresh isolated PostgreSQL preview
  captured the ten affected routes at 1440px English/light and 390px
  Hebrew/dark with zero runtime errors, failed responses, or final viewport
  overflows.

### Theme transition polish — 2026-09-11

- Inspected the pinned Studio Admin source and exercised its deployed header
  control in both dark and light modes. Or-On retains the reference's clean,
  transition-suppressed palette application and now adds the requested
  click-origin circular reveal through the browser View Transition API.
- The shared behavior is connected to both the authenticated header toggle and
  every Appearance theme selector. System remains a persisted preference; a
  System selection that resolves to the current palette does not perform a
  misleading visual wipe.
- Unsupported browsers, unavailable animation APIs, and transition snapshot
  failures fall back to one immediate theme mutation. `prefers-reduced-motion`
  bypasses the reveal entirely, while CSS snapshot isolation prevents browser
  cross-fading or color blending during the theme change.
- Acceptance passed: 48 web test files / 231 tests, web strict TypeScript,
  app-wide ESLint, focused Prettier, `git diff --check`, and a 55-route Next.js
  production build. A fresh isolated PostgreSQL preview was switched from dark
  to light through the real responsive account control and reached the correct
  persisted light state without a runtime error.

### Route availability and navigation responsiveness — 2026-09-11

- Removed the global animated page-opacity gate that kept destination content
  visually hidden after navigation. Motion is now loaded only by the animated
  Overview activity chart, while route content paints immediately and the
  selected navigation item exposes an accessible pending indicator.
- Replaced viewport-wide route prefetching with focused user-intent prefetch on
  hover, focus, and pointer-down. This avoids the previous burst of partial RSC
  requests while warming the route the user is actually about to open.
- Deduplicated authenticated session projection within each server render and
  made Finance load its optional voice estimate concurrently with authoritative
  expense data behind a short timeout. Provider failure still degrades to the
  existing honest unavailable state and no external traffic was enabled.
- Email's Gmail and Outlook actions now open and focus provider-specific setup
  guidance instead of presenting disabled controls. Roles now explains the
  enforced built-in access model and links directly to live member assignments
  in Users; it does not imply unsupported custom-role editing.
- Tenant timezone writes now reject invalid IANA identifiers, and Calendar
  safely falls back to UTC with an accessible warning for invalid legacy data
  instead of throwing during render.
- Acceptance passed: 48 web files / 234 tests, 5 shared UI files / 36 tests,
  54 CRM tests with 10 environment-gated skips, strict web/UI/CRM TypeScript,
  repository ESLint, focused Prettier, `git diff --check`, CRM build, and the
  55-route Next.js production build. Browser verification rendered Email,
  Calendar, Tasks, Finance, Profile, Users, Roles, and Inbox with HTTP 200;
  rapid navigation raised no console or stream errors. The real theme control
  visibly completed its 420 ms dark-to-light radial reveal.

### Tenant operations, AI ownership, OAuth, and campaign funds — 2026-09-11

- Tasks and Calendar now receive targeted eager route prefetch plus local loading
  and recoverable error boundaries; the production fixture rendered both routes
  and Calendar day/week/month navigation before these reliability guards landed.
- Inbox conversations persist AI or human ownership. Only a valid published
  WhatsApp agent can be selected, enabling AI is feature-gated, every generated
  reply re-checks ownership before queueing, and an AI escalation creates a
  tenant-scoped human handoff. Manual takeover assigns the current operator and
  records both a handoff and audit event.
- Gmail and Microsoft OAuth application credentials can be entered in the Email
  UI, are encrypted at the BFF boundary with AES-256-GCM, and use state plus PKCE.
  Provider refresh tokens remain encrypted and never return to the browser.
- Platform administrators can create a complete tenant with settings, optional
  existing owner, and a prepaid campaign wallet. Finance exposes the balance and
  explicit top-up flow. Development is simulated; real mode uses Stripe-hosted
  Checkout and a signature-verified, idempotent webhook credit.
- The contact call flow no longer asks for a redundant acceptance checkbox. It
  retains caller identity validation and the final irreversible-action review.

### Route recovery and administration polish — 2026-09-11

- Reproduced the Inbox, Calendar, and Tasks failures in the authenticated local
  application and traced them to an unapplied schema upgrade rather than client
  navigation. Applied the canonical Alembic revisions and verified each route
  and its primary creation dialog in the browser.
- Added an idempotent tenant-default backfill and development-seed coverage so
  tenants created before CRM settings existed remain visible in the platform
  administrator directory and always receive a campaign wallet.
- Reworked Settings into a full-width administration dashboard with live account,
  team, notification, and API-access summaries, a contained navigation rail, and
  responsive account context cards. Expanded Tenants with live overview totals,
  a clear empty state, and responsive administration cards.

### WhatsApp AI and automatic callbacks — 2026-09-11

- Connected signed, deduplicated inbound WhatsApp events to an explicitly assigned
  published agent through durable PostgreSQL jobs. Model calls occur only after
  inbound commit; generated text returns through the existing outbound request/job
  path with consent, opt-out, service-window, idempotency and Meta kill switches.
- Added strict structured model decisions, bounded output and timeout behavior,
  retryable/permanent safe error classification, no response retention, and fixed
  escalation reason codes. The worker revalidates the enabling operator's active
  tenant messaging authorization before and after the external model call.
- Consolidated WhatsApp and voice generation on the same `LLM_PROVIDER`,
  `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` configuration. The messaging
  adapter now uses the OpenAI-compatible chat-completions contract supported by
  the configured Gemini endpoint; the duplicate `AI_*` contract is retired.
- An explicit customer request to be called now can create one durable,
  tenant-idempotent `whatsapp.ai.call` job when the separate automatic-call gate
  and both real-voice gates are enabled. Simulator input remains ineligible for
  real calling. The messaging worker revalidates the
  actor, contact, non-revoked voice consent, WhatsApp E.164 destination and exact
  published retained flow, then invokes the signed dispatcher outside its database
  transaction. Disabled/refused/exhausted work becomes one safe human handoff.
- The dispatcher carries a bounded recent WhatsApp transcript into the retained
  voice agent as explicitly untrusted continuity context. It is absent from job
  payloads and logs and cannot override system/tool policy. Unit and disposable
  PostgreSQL tests use mocked provider boundaries and place no real call.
- Added a successor Alembic authorization helper with no PUBLIC access and a
  disposable PostgreSQL integration test proving webhook signature verification,
  duplicate suppression, AI reply, mocked Meta delivery, and the call-request
  boundary. Unit tests cover structured output, HTTP classes, timeout, and invalid
  output. No real model, Meta, telephony, or webhook mutation occurred.

### Inbox conversation deletion — 2026-09-11

- Added an operator-only permanent-delete action to Conversation controls with a
  destructive confirmation, bilingual copy, recoverable failure state, and
  automatic selection of the next available conversation.
- Deletion is tenant-scoped, preserves the canonical contact, voice history, and
  immutable audit evidence, and cascades only through dependent messaging data.
  It refuses while outbound delivery or AI work remains queued or in progress.
- Added a tenant-scoped **Remove contact** action to the contact profile. It uses
  the existing archival boundary, so the contact disappears from the active
  directory while conversations, calls, and audit history remain intact.
- Verification passed: 31 focused web/API tests, repository ESLint, CRM and web
  strict TypeScript, the Next.js production build, and 67 CRM tests against a
  disposable PostgreSQL database as the least-privilege `platform_web` role.
- Removed the redundant WhatsApp review modal and approval checkbox at the
  operator's request. The composer send button is now the single explicit send
  action; server-side consent, opt-out, service-window, provider, idempotency,
  and kill-switch enforcement remains unchanged.

### Durable notifications and default WhatsApp AI ownership — 2026-09-13

- Added a shell-level notification center with a persistent unread badge,
  application toast, optional sound, optional browser notification, per-item
  navigation, and mark-read actions. Signed, accepted inbound WhatsApp messages
  now create generic tenant-scoped PostgreSQL notifications without storing a
  phone number or message body in the notification payload.
- Added an explicit tenant default WhatsApp agent. The first eligible published
  profile becomes the default, existing `WhatsApp to Call Agent` profiles are
  renamed to `AI Agent`, and new inbound Meta conversations are atomically placed
  under that agent when AI and real WhatsApp are enabled. Human takeover remains
  sticky and ownership-epoch checks fence already queued AI work.
- Added rename and archival-delete operations for agent profiles and connected
  flows. Published versions, historical runs, and audit evidence are retained;
  archived definitions are excluded from all active selection, publication,
  simulation, quality-edit, audio-preview, and automatic-call paths. Active AI
  ownership must be transferred to a human before its agent can be archived.
- Applied Alembic revisions `c9f996d8be8e` and `143c59f3c8e2` to the local
  development PostgreSQL database and verified the latter is the single current
  head. The successor creates generic bell entries for already-unread Meta
  conversations without replaying AI work. Automated checks use mock
  model/provider boundaries; no Meta message, telephone call, or provider resource
  mutation was performed.

### Provider-neutral deployment candidate — 2026-09-13

- Renamed the active integration branch to `main` without changing its history or
  discarding the accumulated application work. No remote branch, release, or cloud
  resource was created.
- Replaced the abandoned hosting-specific draft with a portable OCI image and
  Docker Compose contract. HTTPS termination, immutable image references, private
  per-service configuration, persistent PostgreSQL/object storage, health checks,
  non-root containers, dropped capabilities, read-only filesystems, resource
  ceilings, and bounded logs are defined without selecting a hosting vendor.
- Added a production-safe first-owner bootstrap. It adopts only the exact empty
  migration seed workspace, reads the password from a private file, creates the
  superuser owner atomically, emits an audit record, and refuses every repeat or
  non-empty database invocation.
- Restored the public environment and third-party notice templates with all real
  provider gates disabled and no credentials. Optional product integrations remain
  provider adapters; the repository contains no hosting account, DNS, registry,
  provisioning, or secret-store configuration.
- Built the web, control API, messaging worker, dispatcher, and migrator release
  images. The dispatcher image keeps the acoustic gender classifier as a local
  development extra rather than shipping CUDA/PyTorch and is approximately 336 MB.
- Verification passed: repository/secret/document policy checks, Prettier, ESLint,
  Ruff, strict TypeScript, Pyrefly over 140 Python source files, 1,020 Python tests,
  all JavaScript/TypeScript package tests, 116 live PostgreSQL/RLS tests, one
  Alembic head, production builds, peer checks, and JavaScript/Python dependency
  audits. The NLTK advisory remains a time-bounded exception through 2026-10-13;
  NLTK and Torch are absent from the production dispatcher image.
