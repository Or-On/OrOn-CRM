# Or-On CRM — post-implementation audit, completion and release validation

Copy the prompt below into Codex in the current repository, or ask Codex to read and execute this file. This is an implementation prompt, not a completed audit or a claim that the current application passes these checks.

Prepared from a read-only review on 2026-09-14 of `OrOn-Platform`, HEAD `a7d18bc7bf937154af9d120fede61355a0a09271`, **including the substantial uncommitted implementation**. Rediscover the baseline when executing: neither that commit nor older readiness reports alone describe the current working tree or deployed release.

---

## 1. Mission and operating rules

Act as the senior engineer responsible for completing and validating the current Or-On CRM across product behavior, frontend, backend, database, security, accessibility, integrations, voice AI and deployment reliability.

Inspect, reproduce, implement, test and verify. Do not stop at an audit, recommendations, visual mockups or a list of TODOs. Fix confirmed defects and implement missing capabilities necessary to complete existing CRM workflows. Preserve working behavior, data, design direction and integration contracts. Do not replace the application with a new architecture or template.

“Everything works” means a traceable inventory of actual features, explicit acceptance criteria and fresh evidence for this revision. Do not promise zero possible bugs, complete security or unlimited product completeness. Unexecuted, skipped, unavailable or provider-blocked tests are not passes.

Start by reading applicable repository instructions, including any `AGENTS.md` and referenced `BOOST.md`. Respect scoped instructions and installed framework documentation. Work in the actual application repository, not the copied design-reference repository. Preserve existing uncommitted and untracked work; do not reset, clean, discard, commit, push or rewrite history. Coordinate with concurrent contributors and isolate overlapping edits.

Use small, reviewable implementation batches with regression tests. Reuse existing domain services, authorization, components and workers. Keep provider calls and privileged operations on the server. Do not fix tests by weakening assertions, removing failing scenarios, disabling authorization or fabricating successful responses.

Local code changes and safe isolated verification are in scope. Publishing images, pushing `main`, changing cloud/IAM/DNS/secrets, running shared-environment migrations or performing a deployment require explicit release authority. This repository currently deploys DEV automatically on a push to `main`; a push is not merely source housekeeping. Read-only deployed inspection is useful when access exists. Resolve only genuinely missing credentials, controlled recipients or release decisions; continue independent safe work while blocked.

## 2. Establish the real baseline

Record branch, HEAD, dirty/untracked file inventory, a safe source snapshot identifier, toolchain, dependency lockfiles, migration heads, runtime services and test commands. Do not include secrets or business records in the snapshot. Detect edits arriving during validation and rerun affected checks before claiming completion.

Read current implementations and relevant tests under:

- `apps/web/src/app`, `apps/web/src/features`, shared styles and `packages/ts/ui`.
- `packages/ts/auth`, `packages/ts/crm`, contracts, configuration and generated API clients.
- `services/ts/messaging-worker`, the voice/dispatcher services and Python control API.
- `db/alembic/versions`, PostgreSQL tests, runtime grants, RLS and migration scripts.
- `.github/workflows/ci.yml`, `infra/compose/deployment.yaml`, Caddy configuration, `scripts/deploy-dev.sh`, `scripts/backup-dev.sh` and `docs/deployment/dev-gcp.md`.
- `docs/architecture/deployment-target.md`, current runbooks, `docs/migration/brimag-field-service-map.md`, `docs/runbooks/field-service.md` and voice-AI readiness/evaluation documents.

Treat documentation as claims to reconcile with source and observed runtime, not proof. Some older staging documents reference removed workflows or Compose files. Earlier test counts and readiness decisions are historical. Do not repeat them as current results.

Current source describes a provider-neutral single-host Compose architecture with a concrete GCP DEV deployment at `https://dev.or-on.io` on `oron-dev`. Confirm the actual intended environment and deployed identity before testing. Do not infer that local code, uncommitted migrations or the latest Git commit are deployed. Compare served release identity, image digests and database schema; redact operational evidence appropriately.

Create `docs/readiness/post-implementation/` for the execution evidence. Maintain a feature matrix, findings, test results, UI evidence index and release assessment as work progresses.

## 3. Build an exhaustive, finite coverage map

Discover every page, nested route, API method, server action, modal, menu action, upload/download, background job, webhook, scheduled operation, database write and external integration. Include hidden/contextual routes and disabled modules, not only sidebar links.

At the reviewed baseline the page inventory includes:

`/`, `/[locale]`, `/start`, `/login`, `/invite`, `/inbox`, `/email`, `/calendar`, `/tasks`, `/contacts`, `/contacts/[id]`, `/pipelines`, `/operations`, `/voice`, `/voice/campaigns`, `/voice/calls/[id]`, `/flows`, `/orchestration`, `/finance`, `/profile`, `/users`, `/roles`, `/tenants`, `/settings`, `/system/health`, `/field-service`, `/field-service/cases/[id]`, `/field-service/reports/[id]`.

Re-enumerate this list and API routes; it is a starting point, not a permanent coverage limit.

For each capability record: user purpose; routes/actions; frontend-to-domain-to-database/provider path; supported roles; tenant and feature guards; success/denial/error states; lifecycle transitions; tests; evidence; remaining blockers. Use `PASS`, `FAIL`, `BLOCKED` or `NOT APPLICABLE WITH REASON`, distinguishing local, deployed, simulated-provider and real-provider evidence.

Exercise platform administrators separately from tenant owner, admin, agent, technician and viewer. Include anonymous, expired, revoked and multi-tenant sessions. A superuser test does not prove ordinary-user usability or isolation.

For every mutation cover applicable cases: empty/valid/invalid/max-length input; duplicate submission; stale edits; unauthorized direct requests; cross-tenant identifiers; deleted references; feature disablement; timeouts; dependency failure; interrupted navigation; retry; concurrent execution; partial success and persistence after reload. Exhaustively test authorization and state transitions; use documented risk-based combinations for the broader device/data matrix rather than claiming every possible permutation was tested.

Include one connected acceptance journey: new tenant → invited ordinary users/technician → first customer → configured channel/published agent → inbound WhatsApp → AI reply → human takeover → task/calendar follow-up → service case/appointment → visit/report → customer history and actual usage/expense visibility. Verify each applicable link without inventing unsupported automation. Repeat critical boundaries with a second tenant. Switch tenants while requests, uploads, forms and streams are pending: late responses must never populate the new tenant's UI. Customer identity changes, archive/delete and supported merge operations must preserve or safely block related messages, calls, tasks, appointments and finalized evidence.

## 4. Complete and test the core CRM

### Account, tenants and administration

- Sign-in/out, session refresh/expiry/revocation, password change, account recovery and email-change behavior. If a recovery workflow is advertised, finish its secure delivery, expiry, anti-enumeration and replay protection; do not invent a working email service or enable public registration implicitly.
- Assess privileged-account protection, active-session management and missing MFA/recovery controls as security gaps; complete supported controls and surface any necessary new authentication-policy decision rather than adding insecure shortcut recovery.
- Invitation creation, copy/delivery status, role selection, acceptance, expiry, revoke, replay, wrong account, existing member and concurrent acceptance/revoke. Anonymous invitation/login screens must never flash the authenticated sidebar or expose tenant data before authorization.
- Create a tenant through the application with all supported setup options, validation and truthful readiness summaries. Distinguish platform entitlement from tenant activation, provider configuration and role permissions. No previous tenant’s credentials, branding, contacts, balances or agent configuration may leak into a new tenant.
- Test fresh empty tenants, existing populated tenants, tenant switching, membership changes, last-owner protection, technician onboarding, deactivation and the supported archive/delete lifecycle. Destructive tests belong only to owned disposable QA data.
- Verify permissions at navigation, page, API, service and DB levels, with fresh authorization after revocation. Confirm API keys are scoped, masked, revocable and never reusable after revocation.
- Personal profile, organization settings, avatar/logo upload/remove/fallback, language, appearance and notifications. Personal avatars and organization branding must not overwrite each other. Image and initials must never render on top of each other.

### Contacts, customer dossiers and sales

- Contact create/read/update, validation, normalized phone/email search, notes, custom fields, classifications, customer locations, documents and linked history. Keep leading zeros in identifiers. Test Unicode/Hebrew, long names, duplicate identities and unrelated people with similar names.
- Imports: encoding, malformed rows, duplicates, oversized files, partial success, truthful row counts and repeat imports. Test export permissions, completeness and spreadsheet-formula injection. Keep test fixtures; remove fake production records only through a separately reviewed, precisely scoped data operation.
- Make supported lifecycle operations reachable: correcting or archiving an incorrect location, document or technician must not require database access. Preserve historical references and retention requirements. Provide explicit authorized national-ID clearing if the backend supports it.
- Pipelines/deals: create/edit, stage transitions, amounts/currencies, ownership, history, filters, concurrency and lost-update prevention. Totals must match authoritative records and disclose forecast assumptions.
- Search, filtering and pagination must find records beyond the first loaded page. Test large datasets, stable ordering and counts matching filter scope. Do not label the length of a truncated client array “Total”.

### Inbox, messaging, campaigns and automations

- Conversation lists, channel/status filters, assignment, unread/read state, pagination, ordering, search, replies, templates, reactions, supported attachments, internal notes if present and contact context. Test simultaneous operators, tenant switches, reload/reconnect and deleted or inaccessible conversations.
- Trace WhatsApp inbound admission through conversation persistence, AI ownership, outbound jobs and delivery receipts. Verify signed webhooks, duplicate/out-of-order events, unsupported payloads, media failures and poison-job isolation.
- Human takeover must suppress queued and in-flight stale AI replies. Test takeover during generation, during provider delay and immediately before send; explicit resume must restore AI only under current authorization and ownership.
- Check service windows, template eligibility, opt-out/consent, retry policy, rate limits and uncertain delivery. Provider acceptance is not delivery; a timeout is not proof of failure. Reconcile ambiguous outcomes before risking duplicate sends.
- Campaigns and automations: audience preview, exclusions, eligibility, scheduling, limits, cancellation, pause/resume if supported, idempotency, failure reporting and cost visibility. Never test by delivering an existing campaign or activating unrelated pending jobs.
- Flow/orchestration editing: save/validate/publish/simulate, node/edge configuration, missing destinations, unreachable nodes, unintended loops, execution bounds, invalid tool arguments, version pinning and stale publish races. Published flows and queued runs must retain the correct tenant, agent and version; simulation must not trigger real tools or providers unexpectedly.

### Tasks, calendar, email and finance

- Tasks: create/edit/assign/complete/reopen, due dates, filtering, contact linkage, unauthorized reassignment, stale updates, overdue behavior and reachable error recovery. Reminders, if implemented, need durable dedupe and truthful preferences.
- Calendar: create/edit/reschedule/cancel, day/week/month navigation where offered, all-day events, overlapping events, locale, IANA timezones and daylight-saving boundaries. Test dates around midnight, nonexistent/ambiguous local times and cross-device consistency.
- OAuth for Gmail/Outlook: authorized UI configuration without filesystem access; encrypted server-only client credentials; redirect validation; state/PKCE as applicable; callback replay; cancellation; consent denial; expired/revoked tokens; refresh races; disconnect. Show connection versus actual mailbox sync/send capability honestly. Do not imply that OAuth connection alone implements an email client.
- Finance: real expense lifecycle, currency/minor-unit correctness, tenant permissions, reconciliation, ledger consistency and audit. No demo balance, arbitrary crediting or “funds added” before confirmed settlement. Payment-source setup and top-ups must use the actual payment provider; test failed/cancelled/duplicate/wrong-tenant/amount-mismatched webhook events. Browser success redirects must not credit funds.
- Where campaign/voice usage consumes a wallet, reconcile reservations, actual usage, release of unused reservations and failed/unknown outcomes. If metering does not support charging, show that limitation rather than inventing debits, refunds or available credit.
- Use payment-provider test mode for payment acceptance. Real charges, refunds or collection of real card information are not authorized by “test the CRM”. Never store card numbers/CVV in this application. Unsupported billing configuration must show an actionable unavailable state.

## 5. Audit the new field-service implementation end to end

Read `tenant-features.ts`, `field-service-domain.ts`, `field-service.ts`, `private-object-storage.ts`, `protected-national-id.ts`, the field-service UI/APIs and the current additive migration, including `a26f09c4d13e_add_tenant_field_service_foundation.py` if still present. Do not assume it is applied locally or on DEV.

Test the complete lifecycle, not just standalone functions:

1. Platform admin grants entitlement; tenant admin enables the module and configures WhatsApp intake, AI scheduling, OCR, shared technician login, approval and calendar access independently. Core CRM remains usable without this optional module.
2. Invite a technician, accept the invitation, assign permissions, create/link the technician profile and identify the technician during an actual visit. Complete the normal non-shared-login path; do not force shared login to conceal missing user linking.
3. Create a case manually and from a controlled WhatsApp conversation. A store representative and the end customer are different entities. Handle incomplete intake, corrections, unknown warranty, ambiguous customer matching and identifier disagreement. Require applicable review/confirmation before creating or changing authoritative records.
4. Schedule, reschedule and cancel. Manual scheduling works without external calendar configuration. Read-only AI may suggest but cannot book. Approved write mode must recheck current availability and authorization; simultaneous bookings must not double-allocate a technician.
5. Start a visit, identify the assigned technician and record arrival/departure evidence in the right order. Wrong-assignment, expired-session and duplicate-signing attempts must not replace signed evidence. Recover usability after refresh/network interruption without fabricating attendance.
6. Draft and finalize a report with required diagnosis, work performed, fault/module photos, arrival/departure evidence and replacement answers/details. Enforce requirements in the API/DB, not only the form. Reopening produces an authorized revision; finalized/superseded reports and branding/customer/technician snapshots remain historically stable.
7. Process OCR as an untrusted proposal with review state and provenance. Test low-confidence results, malformed output, unavailable provider, retries, stale results and human edits during processing. Never overwrite confirmed values silently or treat OCR as identity verification.
8. Inspect links back to contacts, conversations, calls, tasks and calendar events. Test wrong-tenant/wrong-case relationships and actionable navigation with the actual user's role.
9. Disable/revoke entitlement during an open page and during queued/running work. New unauthorized operations stop, ordinary messaging continues and policy-permitted historical archives remain accessible. Re-enabling must not replay stale business actions unexpectedly.
10. Verify reports/archives/downloads are complete, permission-aware and usable on phone and print. Distinguish browser print/PDF from generated documents and CSV/JSON from ZIP; implement a required missing export or correct the claim.

Exercise the complete service-case transition graph, missing-intake/report combinations, signed-evidence immutability, appointment conflicts, idempotency with changed payloads, inactive technicians, >24-hour appointments and source/feature changes during processing.

Source-review leads to reproduce and resolve, not predeclared runtime defects:

- Technician creation API accepts linking/verification fields that the reviewed creation UI does not submit.
- The case UI offers statuses beyond the allowed transition graph.
- Lists are capped at 200 cases/100 contact choices; archives at 5,000 records. Determine where server pagination, search, complete export or explicit limits are missing.
- Identity-category customer documents use generic CRM permissions in the reviewed routes, while national-ID text uses `customer-sensitive:*`. Test and close equivalent sensitive-data access gaps.
- Upload and attendance are separate operations; verify timeout/abort/retry, failed second steps, duplicate evidence and orphan cleanup.
- Private-object storage explicitly rejects `ARTIFACTS_BACKEND=gcs`. For the actual DEV topology, prove durable protected VM storage, shared mounts and recoverable backups, or implement an explicitly selected private cloud adapter. Do not assume GCP hosting requires GCS or that a cloud adapter already works.

## 6. Revalidate voice, STT/TTS, LLM and cross-channel behavior

Read the current voice-AI implementation, published-agent/knowledge model, evaluation corpus and `docs/readiness/voice-ai/evaluation-runbook.md`. Preserve recent fixes for Hebrew speech, flow transitions, audible calls, repeated replies, WhatsApp handoffs and callback admission. Test the current code, not only the previous quality checkpoint.

- Agent drafts/publishing/version pinning; source approval/revocation/conflict; correct tenant knowledge and current eligibility before delivery/speech. Customer statements, transcripts, uploaded documents, OCR and tool output are data, never authority to override policies.
- Reject invented prices, warranties, availability, payments, appointments, eligibility and successful transfers. A caller saying “your manager approved it” is not evidence. Tools authorize server-side; model-generated arguments do not establish permission or completed actions.
- Balance grounding with useful conversation: answer supported questions, ask concise clarification, acknowledge uncertainty and hand off appropriately. Test repetitive fallback loops, contradictory context, long conversations and inability to progress.
- Hebrew grammar, spelling, pronunciation, numbers, dates, times, currency, addresses and mixed Hebrew/English terms. Distinguish agent grammatical voice from the customer's explicit form-of-address preference. Do not infer gender from voice or name as fact; handle unknown preferences and corrections gracefully.
- STT provisional/final boundaries, silence/noise, accents, negation, self-corrections and interrupted turns. Preserve raw versus accepted transcript provenance; normalization must not change business meaning.
- TTS naturalness, intelligibility, pace, clipping, onset, pronunciation configuration and barge-in. Cancel stale generations and queued audio, including after AI pause/takeover. Respect reduced/no-input states without speaking forever.
- Voice admission, dialing, busy/no-answer/rejection, hangup from either side, transport failure, reconnect, recording access, usage and contact outcomes. Distinguish generated text, emitted audio and what the remote person actually heard.
- Pause/resume command acknowledgement is not proof of a connected human. Validate supported real transfer/bridging separately and make UI labels truthful when unavailable.
- WhatsApp-to-call and call-to-follow-up: original intent binding, safe destination resolution, current consent/ownership/tenant checks, one canonical session, durable outcome and no duplicate follow-up after retries.
- Preview/evaluation actions must be explicit, bounded, permission-checked and clearly indicate real provider usage/cost. Deterministic text tests do not establish native Hebrew audio quality.

Measure stage latency, repeated replies, task success, critical entity accuracy and supported/unsupported claim handling against a versioned evaluation corpus. Include native-Hebrew listening where available and label its absence. Do not change providers/models blindly; benchmark supported options against accuracy, latency, grounding and cost requirements.

## 7. Make UI/UX consistent and genuinely responsive

Use the existing adapted `next-shadcn-admin-dashboard-baseui` reference and current approved design direction. Locate the copied reference and compare corresponding components. Reuse the real CRM functions and data; do not import reference demo content or introduce a new visual language.

Audit every page plus dialogs, drawers, dropdowns, filters, forms, empty/error/loading states, toasts, tables, charts, date pickers and downloads in English/LTR and Hebrew/RTL, light and dark themes. Align typography, spacing, borders, density, icons, card heights, button hierarchy, focus and error placement through shared components/tokens.

Explicit regressions to test:

- Inbox proportions, readable message bubbles, conversation switching, anchored composer and mobile list-to-thread/back navigation.
- Dashboard straight-segment chart, full spike reveal and completed animation, real data/counts, accessible data fallback, reduced motion, compact cards and no accidental blank grid gaps.
- Dark/light transition animation completes cleanly; menus/options retain contrast on the fixed dark authentication panel. Controls remain visible during and after transitions.
- Brand logo appears correctly; uploaded organization/user images replace only the intended fallback, with no stacked initials, overflow or stale image after removal.
- Auth/invitation surfaces remain shell-free. Sidebar profile menu does not reintroduce removed duplicate language/theme controls.
- Calendar, tasks, tenants, profile/settings and field-service routes render their own current views, not stale content, wrong active navigation or loading forever.

Test at least 320/360/390/430px phones, 768/1024px tablets and 1440/1920px desktops, plus real component breakpoints, landscape, 200% zoom and text scaling. Verify no accidental page-wide horizontal overflow, clipped dialogs, inaccessible actions or hidden validation. Use scrollable tables only where intentional and provide usable mobile alternatives for critical workflows.

Test keyboard-only navigation, labels, screen-reader names, focus traps/return, errors/live announcements, contrast, target size and reduced motion against [WCAG 2.2 AA guidance](https://www.w3.org/WAI/WCAG22/quickref/). Automated scans are not complete accessibility certification.

On the technician phone journey test camera/file input, large images, orientation, progress/cancel/retry, keyboard avoidance, weak network and interrupted report submission. Do not add offline storage of national IDs or private documents without an explicit security design. Distinguish responsive browser emulation from actual iOS Safari/Android Chrome device evidence.

Capture representative before/after screenshots and short animation evidence with fictional data. Compare DOM/computed geometry as needed; do not claim pixel-perfect parity from memory or a single screenshot. Test browser console, failed network requests and hydration/runtime errors alongside visuals.

## 8. Harden security and data integrity

Use applicable [OWASP ASVS controls](https://owasp.github.io/www-project-application-security-verification-standard/) as a traceable review baseline, verifying the current version. Select controls appropriate to sensitive multi-tenant CRM data; do not claim certification or legal compliance from a checklist.

- Enforce tenant scope and field/object permissions in UI, API, services, worker execution and PostgreSQL RLS. Test with actual non-owner/non-superuser runtime DB roles. Cover caches, exports, search, files, recordings, summaries and audit views, not just contact endpoints.
- Validate sessions, cookie attributes, CSRF/origin checks, CORS, OAuth, API/service signing keys, request validation, parameterized SQL, XSS and stored rich text, SSRF, open redirects, insecure object references and mass assignment. Test logout/revocation while a page/job remains active.
- Review security-definer functions, search paths, grants and composite tenant foreign keys. Privileged connections must not be the default application path. Test pooled-connection tenant context under concurrency.
- Protect national IDs and identity documents: masked by default, least privilege, tenant-bound encryption, no plaintext in URLs/logs/analytics/client caches/ordinary exports or unapproved AI input. Audit reveals/changes without copying raw values. Check key-loss/rotation behavior and client-state clearing after tenant/session changes.
- Validate uploads by content as well as declared MIME; limit size/complexity, sanitize filenames, prevent traversal/symlinks and unsafe inline execution. Test malformed images/PDFs, download headers, private object authorization, checksum mismatch, partial writes, disk-full and DB/file consistency. Quarantine or safely handle unsupported content; do not invent successful malware scanning.
- Redact tokens, prompts containing PII, provider payloads, recordings and confidential error details. Rate-limit abuse-prone paths and bound body size, pagination, generation, upload and worker concurrency.
- Test webhook signatures, replay and event ordering. Retry only where idempotent; retain explicit uncertain external outcomes and reconciliation. Do not claim exactly-once network delivery where the provider cannot guarantee it.
- Check dependencies and container images with current advisories, lockfile reproducibility, image provenance and CI permissions. Fix confirmed risk with compatibility tests; document justified exceptions rather than forcing major upgrades blindly.

Never perform exploit attempts, denial-of-service, destructive fault injection or broad security scanning against shared DEV or third parties. Reproduce those cases in owned isolated infrastructure.

## 9. Improve performance, reliability and maintainability

Measure before changing: cold/warm navigation, interaction latency, API/DB p50/p95, query count, table/filter performance, memory, worker throughput and voice stages on representative datasets. Record hardware/network and agree measurable budgets appropriate to the VM; do not call a single fast request a reliability result.

Eliminate unnecessary serial requests, N+1 queries, over-fetching, unbounded collections, avoidable client bundles and repeated session checks where safe. Add indexes based on measured query plans, preserving tenant filtering and stable pagination. Avoid tenant-unsafe cache keys; invalidate on mutation, ownership/permission change and tenant switch. Keep responsive navigation feedback while data loads, without displaying stale unauthorized content.

Test connection-pool pressure, timeout/cancellation, slow providers, queue backlogs, lease expiry, concurrent jobs, worker restart and graceful shutdown. Recover scheduled work without silently losing or duplicating actions. Use bounded retries/backoff and actionable failed-job/reconciliation views.

Review the complete migration chain on empty and upgraded disposable databases. Verify constraints, transactional boundaries, enum/status compatibility, index creation strategy and writer concurrency. Rehearse backup/restore and compatible rollback before any authorized shared migration. Never rewrite an already-applied migration to hide a defect.

Remove unreachable production mock paths, unused imports/dependencies/files and duplicate implementations only after proving they are unused across runtime, dynamic imports, workers, CLI, tests, migrations and deployment. Keep legitimate fixtures, simulators and evaluation data isolated from production. Do not mass-delete stored data or flatten useful module boundaries for cosmetic cleanup.

## 10. Complete missing features without uncontrolled scope growth

For every discovered gap identify the blocked user journey, existing primitives, proposed minimal completion, permissions/data effects and acceptance tests. Implement necessary CRUD/lifecycle/recovery controls and advertised-but-unreachable functions; do not merely list them as future work.

Evaluate useful CRM additions against current overlap: complete server search/pagination, safe correction/archive flows, technician linking/deactivation/reassignment, assignment and overdue reminders, delivery reconciliation, audit visibility, saved views, duplicate detection, onboarding readiness and contextual help. Prefer finishing these over adding unrelated modules.

Prioritize P0 security/data-loss/critical workflow blockers, then P1 operational completion and UX, then bounded P2 improvements. New autonomous outreach, real-money operations, public signup, broad mailbox synchronization, novel accounting/ERP features or irreversible merging require explicit product/security decisions. Record alternatives and ask only the decision needed; do not pretend an unavailable capability is complete or leave an enabled dead button.

## 11. Run layered tests with honest evidence

Inspect the current CI/package scripts and isolated harnesses before execution. Start with a reproducible baseline, distinguish pre-existing failures from new regressions and repair tests/harnesses that no longer match the architecture.

Important repository-specific precautions:

- `scripts/dev.py` loads repository `.env` over ambient variables; `make verify` uses this runner. Setting test flags in the shell alone is not proof of isolation. Review `scripts/preview_ui.py` and any helper's DB/provider behavior before using it.
- `infra/scripts/readiness_stack.py` referenced removed staging Compose files at review time. Repair/replace obsolete harness assumptions before relying on them.
- Messaging-worker `ai-reply.live.test.ts` and `call-followup.live.test.ts` use dedicated `CROSS_CHANNEL_TEST_DATABASE_URL` and mocked provider HTTP. Their “live” name means real PostgreSQL, not real Meta/telephone verification.
- Worker `readiness.live.test.ts` expects a specially guarded local database target. Do not repoint it at the application's database to make it run.
- `pnpm contracts:check` regenerates files and compares Git diffs. Preserve pre-existing generated edits and distinguish genuine contract drift from the dirty baseline.

Run the current equivalents of formatting, lint, typechecking, unit tests, integration tests, PostgreSQL/RLS/migration tests, contracts, dependency/security checks and production builds. At this review the main entry points include `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm peers check`, `pnpm audit --audit-level critical`, `scripts/pip_audit.py`, repository/docs/secrets check scripts, `scripts/db_verify.py offline`, Ruff/Pyrefly and pytest. Resolve exact invocations/tool versions from CI; a critical-only dependency check is not a full risk assessment.

Add automated browser end-to-end coverage where missing, using the repository's supported toolchain or a narrowly scoped test dependency. Test actual UI controls and persisted outcomes, not only direct API setup. Create deterministic fictional fixtures in disposable tenant-separated databases, including datasets exceeding pagination limits. Keep provider simulators explicitly labeled and unreachable from the public deployment.

For each bug add a reproducing regression test, implement the fix, run targeted checks and rerun affected cross-feature suites. Cover race conditions at DB/service layers and reachability/feedback at browser layers. Report test counts, skips, failures, commands, revision and evidence paths. Neither code coverage percentage nor a green build substitutes for workflow validation.

## 12. Perform bounded real-provider and deployed DEV acceptance

Read-only inspection comes first: intended origin, served SHA/image digests, schema version, service health, supported configuration, queue state and QA identities. Do not dump `.env`, connection strings or full logs containing customer data.

Before any live side effect, establish a run manifest containing the dedicated QA tenant/account, controlled WhatsApp sender and recipient, controlled call destination and someone able to answer, allowed actions, short test window, maximum messages/calls/duration/spend, provider mode and stop conditions. Reuse explicit existing authorization; ask only for missing scope. Do not guess test numbers from real contacts, old screenshots or production campaigns. Lack of this manifest blocks live sends/calls, not local implementation.

Keep real providers disabled in general tests. Use isolated QA jobs/provider credentials when supported; do not globally activate unrelated existing queues. Record created IDs and clean up only owned test artifacts under the agreed retention rules. No real financial transactions.

Required real-provider evidence when authorized:

- **WhatsApp:** controlled inbound message → verified webhook → correct tenant/contact/conversation → grounded AI reply → provider ID and actual recipient receipt/delivery → human takeover → no stale AI reply → controlled resume. Include an allowed template path where relevant. Distinguish local injected webhooks from actual provider receipt.
- **Voice:** one bounded call → ringing/answer → audible two-way Hebrew conversation → interruption/correction → grounded response → supported AI/human control → hangup → protected transcript/recording/outcome/usage. Verify far-end hearing with the test participant or permitted recording. A session row, generated transcript or dispatcher “started” state is insufficient.
- **Cross-channel:** requested callback links to the correct conversation/customer, handles unavailable human/provider honestly and creates follow-up only once. No unintended additional call or message after worker restart/retry.
- **OAuth:** dedicated test account connects/cancels/disconnects with correct scopes; revoked access stays revoked. Label unsupported sync/send separately.
- **OCR:** only synthetic/non-sensitive test documents go to an authorized configured provider; show proposal/review/persistence rather than claiming results from mocks are live.
- **Payments:** test-mode payment source/top-up and verified test webhooks prove ledger behavior; production funds remain untouched.

On deployed DEV use ordinary signed-in roles, a fresh tenant and realistic QA records. Test core CRUD, invitations, tenant switching, field-service activation/onboarding/report completion, uploads/downloads, task/calendar persistence and feature unavailability. Watch browser errors and scoped server/worker evidence. Do not let a login-page HTTP 200 stand in for database-backed workflow checks.

Correlate UI action, request ID, durable job, provider receipt/callback, persisted outcome and applicable cost without exposing sensitive content. Run a bounded post-change stability observation with a recorded duration, representative controlled traffic, error/latency/queue measurements and exact release identity. Use the product's monitoring mechanism if the observation extends beyond the active turn. Short smoke tests do not establish long-term uptime.

## 13. Fix deployment and recovery gaps, then prove the intended release

Reproduce and repair these source-review concerns in isolated tests before proposing a release:

- CI's reviewed remote command runs deployment followed by cleanup with `;`; cleanup success can mask a failed deployment. Preserve the real exit code and fail the workflow on deployment failure.
- Public smoke checks only redirect/login. A healthy old release after rollback can pass them. Verify exact intended source/artifact identity and authenticated functionality on the newly served release.
- `deploy-dev.sh` migrates while prior writers may still run and its error rollback restarts previous worker/voice profiles. Prove expand/contract compatibility, active-call draining, pending-job handling, migration-failure behavior and schema-compatible rollback. Preserve intended profiles/provider safety rather than enabling work incidentally.
- Test release-archive validation against unsafe entry types, symlink/hardlink targets, duplicate/missing image keys, digest/source mismatch and partial extraction. Treat these as security review leads, not established exploits.
- Current local DB dumps do not alone establish disaster recovery. Verify checksums, retention, off-host recovery appropriate to DEV and consistent recovery of private objects/recordings alongside metadata and RLS roles. Restore into a new isolated database/storage destination; never validate backups with destructive restore over live DEV.
- Confirm process/worker readiness, failure monitoring, disk usage, certificate renewal, permissions, restart behavior and actionable diagnostics. Do not invent a public worker health endpoint if a supported private heartbeat suffices.

Retain the production-shaped Compose runtime: Caddy as public edge, private PostgreSQL/control services, least-privilege DB roles, immutable images, protected secrets and durable storage. Do not replace it with `next dev` on the VM. Check the actual VM resource budget and shared object mounts.

First-owner bootstrap is for a genuinely empty identity database, not a shortcut for creating a QA tenant. Existing DEV users/data must survive upgrades. Record a reviewed deployment/rollback procedure and exact release artifacts; execute a release only with explicit authority. If deployment is not authorized, finish local work and mark deployed validation blocked rather than claim DEV was updated.

## 14. Completion and handoff

Continue until the mapped core workflows are implemented and verified, or a specific external prerequisite prevents further in-scope progress. Keep progress updates short and evidence-based. Do not silently downgrade a failing requirement or declare success because time, context or one test suite ran out.

Deliver:

1. Feature/role/workflow coverage matrix with source anchors and local/deployed/provider status.
2. Implemented fixes and necessary features, with regression tests and changed-file summary.
3. Current test results and reproducible commands; UI/mobile/RTL/theme evidence; performance before/after; security findings and dispositions.
4. Deployed run manifest and release identity, if inspected; real call/WhatsApp evidence and explicit unavailable checks, with private data redacted.
5. Migration, backup/restore, rollout/rollback and operator setup instructions reconciled with actual code.
6. Remaining issues ranked by severity, exact impact, next action and reason blocked. Optional product ideas must be separate from required release blockers.

Give separate verdicts for **local implementation**, **deployed DEV**, **real-provider workflows** and **production readiness**. A verified single-VM DEV environment is not automatically production-ready or highly available. No unresolved critical security/data-loss issue or broken enabled core journey may be hidden behind a green summary.

For a positive release recommendation require every inventory item classified, required automated checks passing, designated end-to-end journeys verified on the intended release and no unresolved critical/high issue in the release scope. Explicitly identify environment/device/provider limitations and optional excluded features. A missing prerequisite yields a specific blocked verdict, not an invented pass.

Begin now with current-source discovery and the coverage matrix, then implement and verify in priority order. Do not stop after writing another plan.
