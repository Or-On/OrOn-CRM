# Feature, role and workflow coverage

Statuses apply to the safe source snapshot in [Baseline](baseline.md). `PASS`
means a cited deterministic/local contract passed; it does not imply deployed or
real-provider acceptance.

## Canonical role model

| Role | Effective product access |
| --- | --- |
| Owner | All tenant permissions, including membership roles, tenant settings, field-service management and sensitive customer fields |
| Admin | Current permission set is equivalent to owner except ownership-only role assignment policy; cannot assign owner |
| Agent | Customer operations, pipelines, messaging, voice and field-service read/operate; no tenant/member/feature/sensitive-field administration |
| Technician | Platform shell plus field-service read/operate only |
| Viewer | Platform, CRM, voice and field-service read only |
| Platform super-administrator | Explicit `isSuperuser` bypass in the canonical authorization decision; independent of the selected tenant role |

Anchors: `packages/ts/auth/src/authorization.ts`,
`packages/ts/auth/src/tenant-context.ts`, route `requirePermission` calls, and
PostgreSQL role/RLS definitions. Unit authorization tests pass. Actual runtime
DB-role and cross-tenant RLS execution passed in the isolated PostgreSQL 18.6 CI
suite. Authenticated browser acceptance on DEV is tracked separately.

## Application capability matrix

| Capability and user purpose | Routes and source path | Roles / guards | Local evidence | Deployed / provider evidence |
| --- | --- | --- | --- | --- |
| Sign in, sign out, refresh and select tenant | `/login`, `/api/auth/*`; `packages/ts/auth` → public identity/session tables | Anonymous only at login; session rotation, membership and fresh tenant context | **PASS** — auth/service/route tests; shell-free route assertions | **BLOCKED** — no ordinary-role DEV session |
| Invitation acceptance and membership onboarding | `/invite`, settings invitation APIs; auth invitation service → tenant memberships | Owner/admin create or revoke; token-bound acceptance; role assignment policy | **PASS** — invitation, settings access and PostgreSQL authorization tests | **BLOCKED** — no disposable DEV tenant/mail delivery run |
| Personal profile, password and avatar | `/profile`, `/api/account/*`; auth/profile store and private avatar route | Authenticated user; current-password check for password change | **PASS** — component/API tests, avatar fallback regression | **BLOCKED** — browser/database runtime unavailable |
| Tenant creation, switch, settings and archive/delete | `/tenants`, `/settings`, tenant/settings APIs; CRM management/tenants → platform functions | Super-admin for cross-tenant administration; owner/admin for own tenant settings | **PASS** — tenant capability/deletion/settings and fresh-auth tests | **BLOCKED** — no owned disposable DEV tenant |
| Members, roles and API keys | `/users`, `/roles`, settings member/key APIs | Owner/admin per assignment matrix; API keys scoped, returned once and revocable | **PASS** — auth, management, settings, UI and PostgreSQL runtime-role tests | **BLOCKED** — authenticated DEV role matrix not executed |
| Contact directory and dossier | `/contacts`, `/contacts/[id]`, `/api/crm/contacts*`; web → `@or-on/crm` → CRM tables | CRM read/write; tenant scope on every query | **PASS** — stable keyset paging/search, CRUD, stale response and resilience tests | **BLOCKED** — no representative runtime dataset |
| Classifications, notes, custom fields and service locations | Contact dossier APIs; `packages/ts/crm/src/contacts.ts` and `field-service.ts` | CRM read/write and tenant scope; these customer-file features remain available when field service is disabled | **PASS** — route/domain and online PostgreSQL FK/RLS tests | **BLOCKED** — authenticated DEV browser journey not executed |
| National ID and identity documents | National-ID and document APIs; protected field crypto/private object store | `customer-sensitive:read/write`; masked routine display; tenant-bound encryption | **PASS** — reveal/change/clear, identity document denial, header and malformed-file tests | **BLOCKED** — key rotation/loss and disk-full drills not executed |
| Contact import, export and large-directory discovery | Contact import/API/export UI and CRM queries | CRM write for import; read/export scope; spreadsheet-safe serialization | **PASS** — server search beyond first page and keyset pagination tests | **BLOCKED** — large PostgreSQL data measurement unavailable |
| Pipelines and deal movement | `/pipelines`, deal-stage API, CRM pipeline queries | CRM read; pipeline manage for mutations | **PASS** — existing route/domain regressions in full suites | **BLOCKED** — concurrent DB writer test unavailable |
| Inbox, assignment, read state, replies, reactions and deletion | `/inbox`, messaging APIs; CRM messaging → durable message/job tables | Messaging operate; fresh tenant scope; human ownership state | **PASS** — API/component and PostgreSQL worker tests including unread/notification, deletion and persistence | **BLOCKED** — simultaneous authenticated DEV browser operators |
| In-app notifications | `/api/notifications`, shell controls and realtime/poll refresh | Authenticated, tenant scoped | **PASS** — shell/notification component contracts | **BLOCKED** — device sound/permission and deployed push reception |
| WhatsApp webhook admission and status reconciliation | `/api/webhooks/whatsapp`; signature/body bound → inbound receipts/events → worker | Trusted phone/channel tenant mapping; signature, replay and payload limits | **PASS** — signed, duplicate, invalid and >2 MiB request tests | **BLOCKED** — no controlled real Meta event |
| WhatsApp AI ownership, reply and human takeover | Messaging worker AI jobs and orchestration handoffs | Published eligible tenant agent; current feature/ownership rechecked before send | **PASS** — isolated PostgreSQL generation/provider delay/takeover, same-second ordering and retry acceptance | **BLOCKED** — real recipient delivery and in-flight provider cancellation |
| Campaigns and automations | `/voice/campaigns`, automation/campaign APIs and worker jobs | Campaign manage; version/idempotency/provider gates | **PASS** — bounded simulator and domain tests | **BLOCKED** — no provider campaign was activated |
| Agents, knowledge, flows and simulations | `/flows`, `/orchestration`, orchestration APIs | Flow manage; draft/publish version validation; simulation provider safety | **PASS** — publish/simulation/graph/version tests | **BLOCKED** — no deployed published-agent journey |
| Tasks | `/tasks`, task APIs; CRM task service | CRM permissions and tenant/customer binding | **PASS** — CRUD/authorization/component regressions | **BLOCKED** — reminder delivery is not claimed |
| CRM calendar | `/calendar`, calendar APIs; CRM calendar service | CRM read/write and tenant scope | **PASS** — create/update/delete and UI tests | **BLOCKED** — DST/device runtime matrix not executed |
| Gmail/Outlook OAuth configuration | `/email`, OAuth configuration/start/callback/disconnect API | Tenant manager with fresh authorization; server-only encrypted configuration, state/callback validation; local disconnect revokes channels, tombstones tokens and audits | **PASS** — configuration/state/disconnect/UI contract tests | **BLOCKED** — no dedicated provider account or upstream revoke proof; mailbox sync/send is not implemented or claimed |
| Expense ledger and payment top-ups | `/finance`, finance/billing APIs and Stripe webhook | Tenant finance visibility; authorized mutations; signed tenant-bound events | **PASS** — ledger, webhook binding and responsive finance regressions; DB cases skipped | **BLOCKED** — no Stripe test-mode checkout/webhook journey |
| Voice sessions, campaigns, controls, recordings and usage | `/voice*`, voice APIs → control/dispatcher/agent/session stores | Voice read/operate; provider flags; pinned versions/knowledge | **PASS** — 1,065-test Python suite covers Hebrew, latency logic, barge-in, grounding, sessions and artifacts | **BLOCKED** — no two-way audio, native-Hebrew listener or actual provider receipt in this execution |
| Cross-channel WhatsApp callback | Durable callback job → dispatcher → linked conversation/customer/session | Explicit request/consent, eligible agent/flow, tenant and ownership recheck | **PASS** — 13 isolated PostgreSQL provider-free job/retry/idempotency/callback cases | **BLOCKED** — no bounded real callback |
| Field-service entitlement and activation | `/settings`, field-service settings/archive APIs; typed registry → entitlement/configuration tables | Super-admin grants availability; owner/admin activates dependencies; disabled by default | **PASS** — API/worker/feature plus PostgreSQL runtime-role tests, disabled queued-work cancellation | **BLOCKED** — authenticated DEV tenant activation not executed |
| Technician profiles and case lifecycle | `/field-service`, case/technician APIs; CRM field service → service schema | Read/operate/manage split; active linked technician role validation; feature required | **PASS** — transition graph, link/edit/deactivate, paging, API and online trigger/FK/concurrency tests | **BLOCKED** — authenticated DEV technician journey not executed |
| Manual scheduling, reassignment and conflict prevention | Appointment APIs/UI → transactional scheduling service | Field-service operate/manage; active technician; tenant timezone | **PASS** — deterministic domain and PostgreSQL exclusion/conflict tests | **BLOCKED** — external booking is not implemented or claimed; device journey not executed |
| Visit identity and attendance evidence | Visit identity/attendance APIs and private object store | Assigned/permitted technician; session/visit-bound identity; idempotency key | **PASS** — multipart arrival/departure/replay/failure cleanup API tests | **BLOCKED** — device camera/network interruption and crash-after-rename reconciliation |
| Reports, revisions, evidence and exports | Report APIs/pages/export; validation → immutable revisions → private files | Field-service operate/manage; historical archive permission; feature/tenant scope | **PASS** — required evidence, revision, XLSX/ZIP/print and bounded complete archive tests | **BLOCKED** — browser print, phone and real stored-object restore |
| OCR, summaries and complete dossier links | OCR/link APIs, field-service worker jobs and contact/case views | Optional tenant switches; proposal/review only; feature rechecked around providers | **PASS** — provider failure/retry/stale-human-edit simulations | **BLOCKED** — no authorized OCR/LLM document provider run |
| Branding and bilingual presentation | settings/logo plus shared tokens/i18n/report snapshots | Tenant manager writes; tenant-scoped reads; finalized snapshot immutable | **PASS** — English/Hebrew, RTL, fallback and report branding tests | **BLOCKED** — browser screenshot/device rendering unavailable |
| Health, deployment and recovery | `/system/health`, CI, Compose, Caddy and deploy/backup scripts | Protected diagnostics; immutable image/source identity; deploy authority external | **PASS** — release tests plus authorized exact-source/image DEV backup, migration, health and endpoint verification | **BLOCKED** — separate-destination restore, off-host retention and production topology |

## Lifecycle coverage

The service-case API now derives UI choices from one canonical graph:

```text
intake draft --validated creation--> awaiting_scheduling
awaiting_scheduling -> scheduled | cancelled
scheduled -> awaiting_scheduling | in_progress | cancelled
in_progress -> scheduled | completed | cancelled
completed -> in_progress | closed
cancelled -> awaiting_scheduling
closed -> (terminal)
```

An intake draft is a separate record, not a case status. Only `closed` is
terminal; cancellation can be deliberately reopened for scheduling. Appointment
reschedule idempotency binds technician, start, end and notes; changed payloads
cannot reuse a key. Report finalization, superseding revision, attendance order
and evidence requirements are enforced in the server/domain/DB contract rather
than only in form controls.

## Connected-journey verdict

The provider-free connected journey **PASSES** against isolated PostgreSQL, and
the exact release is healthy on DEV. The full customer journey remains
**BLOCKED** at authenticated DEV QA, controlled provider and actual device/audio
boundaries. A fresh tenant → contact → WhatsApp → AI → handoff → task/calendar →
service visit/report → finance journey must be executed after the prerequisites
in [Release assessment](release-assessment.md) are met. No simulated segment is
mislabeled as a real-provider pass.
