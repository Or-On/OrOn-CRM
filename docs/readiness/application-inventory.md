# Application inventory — source audit, 2026-09-12

This is the application slice of the readiness feature matrix, not a release
approval. The baseline is in `baseline.md`. Discovery used `rg --files` over
`apps/web/src/app`, `apps/web/src/features`, and `packages/ts`, including untracked
files. It found **25 page entrypoints and 69 API route handlers**. No application
files, environment values, customer database rows, providers, or Git state were
modified for this audit.

## Evidence and status conventions

- **Source-inspected** means the named page, repository, route, or relevant action
  was read. It does not mean its workflow passed.
- **Discovered** means the entrypoint/method/guard was mechanically enumerated;
  deeper behavior remains unreviewed.
- Readiness status is **unreviewed** for supported paths until current isolated
  execution provides evidence. Confirmed source defects below are **failed**.
  Deliberate missing modules are **deferred-with-reason**, not silently passed.
- Test paths below are existing candidate coverage, **not tests executed during
  this audit**. Source contracts/CSS tests do not establish browser correctness.
- Main audit/security/worker inventories own exhaustive authorization, service,
  migration, integration, and deployment findings. This document does not replace
  their evidence.

Common boundaries: `features/auth` authenticates sessions, mutations assert CSRF
and origin, `withCurrentTenant(permission, callback)` selects a role-aware tenant
transaction, and CRM repositories use PostgreSQL. These are observed architectural
boundaries; negative RLS/role execution still requires isolated PostgreSQL tests.
`features/access` is presentation-only. Built-in permissions are in
`packages/ts/auth/src/authorization.ts`:

| Permission shorthand | Intended tenant roles (platform superuser overrides separately) |
| --- | --- |
| R = `crm:read`, P = `platform:read`, VR = `voice:read` | owner, admin, agent, viewer |
| W = `crm:write`, M = `messaging:operate`, PM = `pipelines:manage`, VO = `voice:operate` | owner, admin, agent |
| CM = `campaigns:manage`, FM = `flows:manage` | owner, admin |
| TM = `tenant:manage`, MM = `members:manage`, MR = `members:change-role` | owner, admin, with owner-assignment rules enforced separately |
| SA | active platform superuser, not an ordinary tenant owner/admin |

## Page and significant-action matrix

All page source entrypoints follow `apps/web/src/app/<route>/page.tsx`; `/` uses
`apps/web/src/app/page.tsx`. Feature paths below are relative to
`apps/web/src/features`; database repositories are relative to
`packages/ts/crm/src`. Unless explicitly stated, workflow status is **unreviewed**
and inspection is **source-inspected**.

| Page/deep link | Feature code, actions and actual data | Roles and dependencies | Coverage candidates / limitations |
| --- | --- | --- | --- |
| `/` | `overview/index.tsx`, `activity-chart.tsx`; `analytics.ts` reads full tenant counts, 14 UTC day message cohorts, monthly operational aggregates and pipeline currencies | R; PostgreSQL | `overview-experience.test.tsx`, `overview-insights.postgres.test.ts`; aggregates mix simulator/real records (APP-003), no fresh visual/performance evidence |
| `/login` | `login/login-form.tsx`; password sign-in, session-aware redirect; public entry with branding/theme/locale | public; auth service | `login-page.test.tsx`, auth service tests; deep auth review delegated |
| `/invite?token=…` | `invite/accept-form.tsx`; token inspection, existing/new account acceptance, post-accept session behavior | public token; auth service, identity DB | `invitation-page.test.tsx`, `invitation-accept-route.test.ts`, `invitation-accept-form.test.tsx`; concurrency/revocation/new-account flow needs real DB/browser evidence |
| `/[locale]` (`/en`, `/he`) | validates locale then redirects to login or overview; locale proxy persists language | public/session aware | `localized-entry.test.tsx`, `locale-proxy.test.ts`; no independent landing page |
| `/start` | permission-aware getting-started links; no automatic setup mutation | authenticated | onboarding guidance, not provisioning |
| `/contacts?q=…&create=1` | `contacts/contact-manager.tsx`, `contact-results.tsx`; search, create, CSV import; `contacts.ts`, `csv.ts` | R read/W create/import; PostgreSQL contacts, channel identities, tags | `crm-workspaces.test.tsx`, `contact-creation-policy*.test.ts`, `csv.test.ts`; default 50/max100 list has no continuation, import SQL-error rollback issue APP-002 |
| `/contacts/[id]` | `contact-detail-panel.tsx`, `contact-call-dialog.tsx`; profile update, notes, custom-field values, voice/WhatsApp consent, archive, timeline, published-flow call dialog | R read/W edits/VO calls; PostgreSQL plus control API | `crm-workspaces.test.tsx`, `real-call-route.test.ts`, `form-recovery.test.tsx`; unrelated control API outage blocks entire contact page APP-001 |
| `/pipelines` | `pipelines/pipeline-board.tsx`; full boards, search/filter, keyboard/drag stage move; `pipelines.ts` | R/PM; `crm.pipelines`, stages, deals, contacts | CRM PostgreSQL suite; no create/edit pipeline/deal API discovered; unbounded board/deal load APP-007; no stale-edit version guard |
| `/inbox?conversation=…&search=…&filter=…` | `inbox-workspace.tsx`, `conversation-thread.tsx`; queue/filter/search, history paging, draft reply, text/template/provider selection, quick replies, assignment/status, human/AI ownership, reactions, delete, contact panel, sound/notification toggle | R/M; `messaging.ts`, `whatsapp-outbound.ts`, signed Meta webhook, durable worker | `inbox-interaction.test.tsx`, `whatsapp*.test*`, `message-page*.test.ts`, `conversation-deletion.postgres.test.ts`; latest100 queue only, client search/filter limited to loaded set; text/templates supported, attachment send/upload not discovered; reactions stored locally (provider propagation unverified) |
| `/operations?tab=campaigns|automations|history&create=campaign` | `operations-panel.tsx`, campaigns/automations/run-history; create and dispatch **simulator** broadcast, legacy empty automation create/publish/run, real stored run history | R/CM/FM; `campaigns.ts`, `automations.ts`, ops jobs | `messaging-experience.test.tsx`, `operational-empty-states.test.tsx`; no real campaign send path here; simulator endpoints not environment-gated APP-003; empty automation records success APP-004 |
| `/orchestration?tab=agents|flows|activity|handoffs&contact=…` | `orchestration-panel.tsx`, `agent-register.tsx`, `flow-canvas.tsx`; agent draft/publish, fixed cross-channel graph construction/publish/simulation, contact activity, handoff create/claim/complete | R read/FM configuration+simulation/M handoff; `cross-channel.ts`, `flow-runtime.ts`, voice references | `orchestration*.test.tsx`, `flow-canvas.test.ts`, CRM cross-channel/flow tests; canvas is graph visualization, not general arbitrary graph editing; contact selector only first50; recent runs first50 |
| `/voice` | `voice/voice-overview.tsx`; session polling, number register/reconcile, call state/cost links; generated control API client | VR read; voice writes mapped to control capability by `issueControlApiGrant`; Python services/DB | `voice.test.tsx`, `voice-live-pricing.test.tsx`; no external telephony tested; page awaits four backend calls |
| `/voice/calls/[id]` | recording player, live summary, transcript/event timeline, costs | VR; control session/recording endpoints, local/GCS object storage | `voice-recording-route.test.ts`, `voice-presentation.test.ts`, `voice-live-pricing.test.tsx`; acoustic, live pricing accuracy and object-access checks not executed here |
| `/voice/campaigns` | `voice-campaign-panel.tsx`; campaign create, run, status/results; published flow selection | VR read, control write permission; Python campaign engine | `voice.test.tsx`; real/simulated execution boundaries owned by worker audit |
| `/flows` | `voice-flow-panel.tsx`; catalog/list, JSON definition dialog, validate, publish | VR/control write; retained Python flow catalog/runtime | `voice.test.tsx`; contextual navigation under Voice, no standalone replacement engine |
| `/calendar` | `calendar-workspace.tsx`, `calendar-time.ts`; day/week/month views, date/search/status filters, create/edit/cancel, organizer, all-day/timezone, cursor page loading | R/W; `calendar.ts`, `crm.calendar_events`, current team | `calendar-time.test.ts`, `tenant-operations.test.tsx`, CRM tenant operations; no recurrence, reminders, contact/deal links implemented; date parsing and update locking inspected, DST/browser matrix pending |
| `/tasks` | `tasks-workspace.tsx`; list/filter/search, create/edit/complete/reopen/cancel, due time/priority/assignee | R/W; `tasks.ts`, `crm.tasks`, current team | `tenant-operations.test.tsx`, CRM tenant operations; max500 initial list, no continuation; contact/deal linkage/reminder jobs absent; UI uses browser local timezone instead of tenant timezone APP-008 |
| `/finance` | `finance-workspace.tsx`; expense create/edit/cancel, filter/cursor list, per-currency summaries, optional voice estimates, wallet, payment-source setup, hosted top-up | TM; `expenses.ts`, `billing.ts`, Stripe adapter, PostgreSQL | `tenant-operations.test.tsx`, `stripe-server.test.ts`; real billing flag/keys required, no mock funds in current code; no provider calls run; changed-payload idempotency APP-005; refund/dispute workflow absent |
| `/email` | `email-workspace.tsx`, `oauth-server.ts`; actual channel listing, Google/Microsoft credential setup and OAuth link | P list; TM credential/start/callback; encrypted DB credentials | `tenant-product-workspaces.test.tsx`; OAuth connection is not a mailbox client; no mailbox sync, compose/send, disconnect, refresh worker discovered; some setup text predates credential implementation |
| `/profile` | `profile-workspace.tsx`; display/email/password, avatar replace/remove, current workspace context | P self only; canonical account APIs | `tenant-product-workspaces.test.tsx`, `identity-image*.test*`; verified email-change/session lifecycle covered by separate security audit |
| `/users?role=…` | `users-workspace.tsx`; live members/invites, role filter, invite/copy link/revoke/remove/change role | MM/MR; `management.ts`, canonical membership/invitation functions | `settings-access.test.tsx`, `authorization-contract.test.ts`, auth tests; invitation **link issuance** not mail delivery |
| `/roles` | `roles-workspace.tsx`; built-in permission matrix/member counts and links to users | MM; canonical `authorization.ts`, current team | `authorization-contract.test.ts`; custom role creation/editing absent by design |
| `/tenants` | `tenant-workspace.tsx`; platform directory, create with optional existing owner and defaults, guarded soft deletion via typed slug dialog | SA; `tenants.ts`, platform security-definer functions | `tenant-deletion.test.tsx`, `tenant-delete-route.test.ts`, `tenant-deletion.postgres.test.ts`; deletion retains data, not physical erasure; background lifecycle review required |
| `/settings` | `management-panel.tsx`; account/password/images, organization name/slug/currency/locale/timezone, members/invites, API keys, notification list, appearance | P self/read; TM organization/keys, MM/MR team | `tenant-settings.test.tsx`, `settings-access.test.tsx`, `settings-layout-contract.test.ts`; notifications read-only, no per-user preference backend route discovered |
| `/system/health` | `system-health/index.tsx`; authenticated probes, manual/30-second refresh, current-page sample history, runtime flags | authenticated; control liveness/readiness plus reported PostgreSQL state | `system-health.test.tsx`, `health-route.test.ts`; does not prove provider/queue/worker health or historical SLA |

## Exact API surface (all 69 route files)

Paths below append `/route.ts` under `apps/web/src/app`. `GET/POST` is a list of
implemented methods, not permission equivalence. All handlers were mechanically
discovered; **S** marks handler bodies/source dependencies inspected in this
application slice, **D** means detailed behavior delegated/unreviewed. There are
no DELETE/PUT routes beyond those explicitly listed.

| Endpoint | Methods | Access/action | Inspection |
| --- | --- | --- | --- |
| `/api/account/avatar` | GET, PATCH, DELETE | P; own avatar read/replace/remove | D |
| `/api/account/password` | PATCH | P; own password change | D |
| `/api/account/profile` | PATCH | P; own profile/email update | D |
| `/api/auth/invitations/accept` | POST | public invitation token; accept/account/session | D |
| `/api/auth/live-grant` | POST | authenticated scoped short-lived live service grant | D |
| `/api/auth/login` | POST | public login | D |
| `/api/auth/logout` | POST | authenticated mutation/session revocation | D |
| `/api/auth/session` | GET | public-safe current session projection | D |
| `/api/auth/tenant` | POST | authenticated allowed tenant switch | D |
| `/api/automations` | GET, POST | R list/FM empty draft creation | S |
| `/api/automations/[id]/publish` | POST | FM; legacy empty graph publication | S |
| `/api/automations/[id]/run` | POST | FM; legacy empty no-op succeeded record | S |
| `/api/billing/payment-source` | POST | TM; gated Stripe customer/setup checkout | S |
| `/api/billing/topups` | GET, POST | TM; wallet/history, gated hosted top-up | S |
| `/api/calendar/events` | GET, POST | R list/W event create; range/cursor | S |
| `/api/calendar/events/[id]` | PATCH, DELETE | W; edit/cancel retained event | S |
| `/api/campaigns` | GET, POST | R list/CM simulator campaign create | S |
| `/api/campaigns/[id]/deliver` | POST | CM; durable simulator recipient enqueue | S |
| `/api/crm/contacts` | GET, POST | R tenant search/W create | S |
| `/api/crm/contacts/[id]` | GET, PATCH, DELETE | R detail/W profile+consent update/archive | S |
| `/api/crm/contacts/[id]/custom-fields/[fieldId]` | POST | W; custom value upsert | S |
| `/api/crm/contacts/[id]/notes` | POST | W; append note | S |
| `/api/crm/contacts/import` | POST | W; bounded CSV batch | S |
| `/api/crm/deals/[id]/stage` | POST | PM; same-pipeline move | S |
| `/api/email/oauth/[provider]/callback` | GET | TM; state/PKCE token exchange persistence | D |
| `/api/email/oauth/[provider]/start` | GET | TM; configured provider redirect | D |
| `/api/email/oauth/configuration` | GET, POST | TM; configuration presence/encrypted save | D |
| `/api/finance/expenses` | GET, POST | TM; list/summary/create | S |
| `/api/finance/expenses/[id]` | PATCH, DELETE | TM; edit/cancel retained expense | S |
| `/api/messaging/conversations` | GET | R; latest100 or exact ID | S |
| `/api/messaging/conversations/[id]` | PATCH, DELETE | M; ownership/assignment/status, guarded hard deletion | S |
| `/api/messaging/conversations/[id]/messages` | GET, POST | R cursor history/M durable text-template outbound | S |
| `/api/messaging/messages/[id]/reactions` | POST | M; tenant DB reaction | S |
| `/api/messaging/simulate/inbound` | POST | M plus development/preview gate | S |
| `/api/orchestration/activity` | GET | R; contact activity | S |
| `/api/orchestration/agents` | GET, POST | R list/FM profile draft | S |
| `/api/orchestration/agents/[id]/publish` | POST | FM; immutable published version | S |
| `/api/orchestration/flows` | GET, POST | R list/FM canonical flow draft | S |
| `/api/orchestration/flows/[id]/publish` | POST | FM; validated publication | S |
| `/api/orchestration/flows/[id]/simulate` | POST | FM; durable canonical simulator run | S |
| `/api/orchestration/handoffs` | GET, POST | R list/M request | S |
| `/api/orchestration/handoffs/[id]` | PATCH | M; accept/complete | S |
| `/api/orchestration/simulate` | POST | FM; fixed cross-channel simulation | S |
| `/api/settings` | PATCH | TM; tenant settings | D |
| `/api/settings/api-keys` | POST | TM; issue scoped key once | D |
| `/api/settings/api-keys/[id]` | DELETE | TM; revoke key | D |
| `/api/settings/invitations` | POST | MM; issue invitation token | D |
| `/api/settings/invitations/[id]` | DELETE | MM; revoke unused invitation | D |
| `/api/settings/logo` | GET, PATCH, DELETE | P read/TM replace/remove tenant logo | D |
| `/api/settings/members/[id]` | PATCH, DELETE | MR role/MM membership removal | D |
| `/api/system/health` | GET | authenticated; timed control probes and flags | S |
| `/api/tasks` | GET, POST | R list/W create | S |
| `/api/tasks/[id]` | PATCH, DELETE | W; edit/complete/reopen/cancel | S |
| `/api/tenants` | GET, POST | SA; platform directory/atomic creation | D |
| `/api/tenants/[id]` | DELETE | SA; guarded soft-delete function | D |
| `/api/v1/contacts` | GET, POST | hashed API key contacts read/write scopes | D |
| `/api/voice/campaigns` | GET, POST | VR/control write; list/create | D |
| `/api/voice/campaigns/run` | POST | control write; campaign run | D |
| `/api/voice/flows/publish` | POST | control write; voice graph publish | D |
| `/api/voice/flows/validate` | POST | control write; voice graph validation | D |
| `/api/voice/phone-numbers/reconcile` | GET | VR; persisted/configured reconciliation | D |
| `/api/voice/phone-numbers` | GET, POST | VR/control write; list/register | D |
| `/api/voice/real-calls` | POST | VO; real gates and contact/flow validation | D |
| `/api/voice/session-detail` | POST | control read; session detail projection | D |
| `/api/voice/sessions` | GET | VR; session list | D |
| `/api/voice/sessions/[id]/recording` | GET | VR; authorized binary recording | D |
| `/api/voice/simulated-calls` | POST | control write; telephony simulation | D |
| `/api/webhooks/stripe` | POST | public signed raw-body event; billing gate | S |
| `/api/webhooks/whatsapp` | GET, POST | public verification/signature; durable ingestion | D |

## Shared packages and non-page surfaces

| Scope | Discovered implementation and candidate tests | Current inspection/status |
| --- | --- | --- |
| `packages/ts/crm` | contacts/identities/consent/import, messaging/history/ownership/status, webhook store/diagnostics/outbound, campaigns, empty automations, canonical graph/adapters/runtime, agents/handoffs/timeline/usage, analytics, calendar/tasks/expenses/billing, tenant settings/team/invites/API keys, contacts tool/MCP adapter | Core repository reads performed above; remaining functions discovered; unreviewed until current execution |
| `packages/ts/auth` | assertions, request security, service/repository, tenant context, four canonical roles | Permission table inspected; deep audit delegated |
| `packages/ts/api-client` | generated control client/schema/OpenAPI, public client export; `tests/client.test.ts` | Discovered, generation freshness unreviewed |
| `packages/ts/contracts` | platform event JSON Schema, generated TS, validator, event tests | Discovered; not a complete contract authority for handwritten BFF DTOs |
| `packages/ts/config` | central typed loadConfig/diagnostics, strict flags/provider groups, config tests | Discovered; no secret values read |
| `packages/ts/observability` | structured logger/redaction and tests | Discovered, security review delegated |
| `packages/ts/platform-integration` | PostgreSQL readiness probe and environment-gated tests | Discovered, not business persistence |
| `packages/ts/ui` | accessible primitives, dialog/confirmation/popover/select/combobox, tables/tabs/metrics/headers/status/progress, optional motion, CSS tokens | Discovered; controls/primitives/color-contrast tests exist; full visual/accessibility checks unreviewed |
| Shell | `features/shell/index.tsx`, `navigation.ts`; responsive navigation, tenant switch, account/logout, command search, help dialog, theme/language header, focused/eager prefetch policies | Source-inspected navigation and route boundaries; `shell*.test.tsx`, bilingual/theme tests; real responsive interaction pending |
| Public/error routes | `not-found.tsx`, `error.tsx`, `global-error.tsx`, `loading.tsx`, Calendar/Tasks scoped error/loading; `proxy.ts`, i18n locale/theme/connection/form validation | Discovered, no invented business results observed from these entrypoints; error/retry/expired-session browser evidence pending |
| Live Lab/desktop | No `page.tsx` or React feature for Live Lab/desktop in active web tree; live-grant and retained service contracts exist elsewhere | **deferred-with-reason**: user postponed OpenLive visual integration; retain source, do not claim parity |
| Email operations | No mail sync job/API, compose/send, refresh/disconnect route in discovered active web APIs | **blocked** for a working email-client claim; OAuth setup alone is not email E2E |
| Pipeline creation | No pipeline/stage/deal create/update API except deal stage move in discovered web APIs | **blocked** for complete CRM pipeline lifecycle; establish intended product acceptance, do not hide an empty pipeline as optional |
| Export/bulk actions | CSV contact import exists; no contact export/bulk edit/delete API in discovered web tree | **deferred-with-reason** pending explicit workflow scope; do not advertise export support |
| Notification preferences/reminders | Inbox sound/browser notification preference is client-local; settings notification list backed by DB; no durable task/calendar reminder action discovered | Persistence/notification-delivery gaps require roadmap classification, not fabricated success |

## Prioritized concrete findings (all awaiting verification/fix)

| ID / severity | Evidence and failure mechanism | Required verification / fix direction |
| --- | --- | --- |
| APP-001 / high availability | `app/contacts/[id]/page.tsx` unconditionally awaits `voiceClient("voice:read").listVoiceFlows()` in Promise.all with authoritative CRM detail. Any optional control API outage rejects the whole contact page. | Mock unavailable control API plus isolated backend route render; preserve contact read/edit, show call setup unavailable; do not mask CRM failures as empty contact |
| APP-002 / high integrity | `crm/src/contacts.ts#importContacts` catches per-row SQL errors without SAVEPOINT inside outer `withCurrentTenant` transaction. A constraint error aborts transaction; later rows fail and previous reported creates can roll back while result is returned. Raw `error.message` also becomes row response text. | Isolated real PG import with first valid row, one actual DB constraint failure, later valid row. Use per-row savepoints or atomic all-or-nothing semantics; sanitized stable errors; verify persisted count matches report |
| APP-003 / high staging correctness | `api/campaigns` and deliver routes plus orchestration simulate endpoints lack explicit deployment simulation gate. `campaigns.ts` writes approved simulator template and shared campaign/result state. `analytics.ts` counts messaging/messages and sessions without provider/simulation provenance filters. | Disable/protect simulation routes in staging; isolate labeled simulation records from real analytics. No automatic deletion of existing rows. Preserve explicit test simulator functionality |
| APP-004 / medium misleading outcome | `automations.ts#runManualAutomation` inserts status succeeded with immediate timestamps for empty graph; metadata identifies `phase4-empty-graph`, but standard successful run totals include it. | Label no-op/dev behavior and prevent production claims/simulation aggregation; do not pretend a nonempty workflow executed |
| APP-005 / high financial correctness | `billing.ts#createCampaignTopup` reuses row on idempotency-key conflict without matching amount/currency; `api/billing/topups` sends current request amount to Stripe while row may retain older amount. | Bind idempotency key to immutable request hash/payload; reject changed-payload replay before provider operation; real isolated PG concurrency + mocked HTTP tests |
| APP-006 / medium usability | Contacts default50/max100, Tasks max500, conversations latest100 have no continuation route; Inbox search/filter operates on loaded conversations. | Keep honest capped labels now; implement backend query/cursor where full list required; verify >limit fixture navigation/search and stable cursor ordering |
| APP-007 / medium performance | `pipelines.ts#listPipelineBoards` loads every tenant pipeline/stage/nonarchived deal and filters arrays per pipeline. Campaign/agent/flow library reads are also unbounded. | Benchmark realistic isolated volume before bounded paging/filter or virtualization changes; no speculative indexes |
| APP-008 / medium date correctness | `tasks-workspace.tsx#localDateTime` and task submission use browser offset/Date parsing. Page receives no tenant timezone, unlike Calendar. Operators in different timezones can schedule inconsistent wall-clock task due times. | Inspect intended tenant timezone semantics, test different browser/tenant zones/DST, use explicit conversion and labels |
| APP-009 / medium validation | Contact create/edit validates nonempty name and E.164 but not bounded name/company/email shape/length; CSV supports line-based records only, not quoted multiline fields. `setContactCustomField` accepts arbitrary JSON without field-type validation in repository. | Use existing schema constraints as source, add bounded validation and explicit CSV limitation/errors; no live customer import tests |
| APP-010 / medium concurrency | Contact/task/deal edits have no client version/updated-at precondition; separate operators can silently overwrite same fields. Calendar locks dates but also lacks stale-edit conflict detection. | Risk-based concurrent update tests, version preconditions for material edits; preserve independent-field patches |

These are source-backed hypotheses/failures, not measured runtime incident claims.
Financial, role, tenant-deletion, and AI ownership issues must be reconciled with
the separate security/worker audits before choosing exact fixes. No release gate
is passed solely by this inventory.

## Next evidence tasks

1. Finish security/worker inventories and join this matrix into `feature-matrix.md`.
2. Verify highest-risk APP-001/002/003/005 regressions on disposable PostgreSQL and
   mocked provider boundaries; do not restart real workers or consume user queues.
3. Exercise every supported page/action in an isolated production-mode browser,
   with multiple tenants/roles, English/Hebrew, light/dark, 390px/tablet/desktop.
4. Record command output and screenshots separately, link exact tests to each
   action, and change status only when corresponding execution evidence exists.
