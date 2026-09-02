# Or-On Platform progress

Last updated: 2026-09-02 (Asia/Jerusalem)

## Current checkpoint

- Phase: Phase 6 — Cross-channel platform
- Branch: `codex/phase-6-cross-channel`
- Phase 0 baseline: `93eb808e65f8edb1754c1940afe1949e7e18223a`
- Phase 1 baseline: `20b46159078ec533a9891e6768d47595e35b7a7c`
- Phase 2A status: **OFFLINE IMPLEMENTATION COMPLETE**
- Live status: **PHASE 2B LIVE POSTGRESQL VALIDATION COMPLETE**
- Phase 3 status: **COMPLETE**
- Phase 4 status: **COMPLETE**
- Phase 5 status: **COMPLETE — SIMULATOR-FIRST ACCEPTANCE PASSED**
- Phase 6 status: **IN PROGRESS — WORKER COMPLETION AND RUNTIME PARITY; OPENLIVE DEFERRED**
- Active task: P6-011 worker complete; verify retained-runtime adapters and final Phase 6 acceptance
- Phase 2B clean baseline commit: `830a8371836ea7922fca5c320624bf3bd32ec229`
- Phase 3 exact baseline commit: `9ca3a022c2fb18a5d416b39aa7d1404f7910ae1b`
- Phase 4 exact baseline commit: `fdaabedfe0c6dd3586261a338f2fd82f904023d8`
- Phase 5 exact baseline commit: `e6d2e303c07a3a0df35e39d30baf1f5584564464`
- Phase 6 exact baseline commit: `946b08a1c418567f56df87cbe17a97b143596a01`
- Provider safety: no real telephone call, WhatsApp message, webhook mutation, or provider provisioning performed

## Phase 6 implementation state

Phase 6 starts from clean Phase 5 head
`946b08a1c418567f56df87cbe17a97b143596a01`. By explicit product decision,
OpenLive, Live Lab, browser-local voice/vision, WebGPU, ACP, and the desktop
wrapper are deferred to the final integration phase. Phase 6 now owns the
formerly planned cross-channel work and may implement only canonical voice and
messaging agent/flow adapters. The authoritative scope is
[`phase-6-cross-channel.md`](plans/phase-6-cross-channel.md).

| ID | Task | Status | Commit | Verification evidence | Next exact task |
| --- | --- | --- | --- | --- | --- |
| P6-001 | Baseline, instruction, upstream-integrity, and scope verification | complete | preparation checkpoint | Clean Phase 5 baseline `946b08a`; all locked upstreams clean; roadmap reordered by explicit user direction | Inventory retained voice and messaging profile/flow semantics. |
| P6-002 | Canonical agent/profile and flow source-parity inventory | complete | `7fb1b74` | Retained Or-on voice and WACRM messaging semantics mapped to one versioned contract; OpenLive excluded | Complete. |
| P6-003–P6-006 | Canonical agent/flow schema, validation, publishing, immutability, RBAC, RLS, and audit | complete | `a6aa0c1`, `7fb1b74` | Two generated Alembic revisions; one head; live PostgreSQL catalog/RLS/immutability tests pass | Complete. |
| P6-007–P6-009 | Retained voice/messaging adapters and cross-channel coordinator | in progress | `7fb1b74` | Deterministic channel-filtered artifacts exist; they do not yet prove execution through retained engines | Verify configuration preservation and runtime parity. |
| P6-010 | Call-outcome-to-WhatsApp simulator workflow | complete | successor to `34a14ac` | Worker now consumes the job atomically; four isolated PostgreSQL tests cover runtime-role RLS, concurrency/replay, consent/opt-out, malformed mode and foreign-tenant contact; workspace tests/typecheck/build pass | P6-011 voice-job consumer. |
| P6-011 | WhatsApp-to-CRM-to-call simulator workflow | complete | successor to `7a9657f` | Nine isolated PostgreSQL consumer tests and cross-language inbound→CRM→call→follow-up test pass; simulator sessions/events/outbox and completion share one transaction | Retained adapter execution parity and full acceptance. |
| P6-012–P6-014 | Handoff, activity, usage, latency, and cost | implemented | `7fb1b74` | Existing domain/API tests; cost intentionally unpriced | Recheck in final cross-channel end-to-end acceptance. |
| P6-015–P6-017 | Control API contracts and accessible responsive operator surfaces | complete | `7fb1b74`, `10ae55f` | Generated OpenAPI/client, strict typecheck, UI tests, and Next.js 16.3.3 production build pass | Complete. |
| P6-018–P6-021 | Database/end-to-end verification, architecture, provenance, and clean checkpoint | reopened | successor to `34a14ac` | Earlier suite results did not exercise both queued cross-channel job consumers; previous completion claim was too broad | Finish remaining consumers/adapters before final acceptance. |
| P6-022 | Real Meta adapter, durable admission, consent/window/idempotency, and dual kill switches | complete | `956cf75` | Mocked 400/401/403/429/5xx/timeout/success tests; no network call; worker persists provider IDs outside request transactions | Complete. |
| P6-023 | GET verification, exact-raw-body POST signature, status ingestion, and deduplication | complete | `956cf75` | API/parser tests and live durable worker test prove signed duplicate delivery updates once | Complete. |
| P6-024 | Real-delivery UI, explicit confirmation, protected smoke command, and runbook | complete | `10ae55f`, Phase 6 docs checkpoint | Simulator remains default; REAL path is unmistakable and double-confirmed; smoke command is manual-only | User must finish Meta Dashboard configuration before the first authorized send. |
| P6-025 | Repair Inbox team-directory and assignment privileges | complete | successor to `f75e492` | Narrow tenant/member-checked SQL function replaces forbidden direct identity reads; isolated and actual localhost Inbox queries pass as `platform_web`; migration `9d3038bec65e` applied locally; 47 database and 5 isolated TS integration tests pass | Resume P6-011. |

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

Next exact task: finish P6-007/P6-008 adapter configuration and runtime parity,
then rerun final acceptance before starting Phase 7.

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

| ID | Task | Status | Commit | Verification evidence | Next exact task |
| --- | --- | --- | --- | --- | --- |
| P5-001 | Baseline, instructions, locked-source inventory, and Phase 5 scope | complete | preparation checkpoint | Clean Phase 4 baseline `e6d2e303`; locked clean upstreams; actual Or-on packages/routes/models/tests/deployment inspected; authoritative scope recorded | Begin the compatibility/license gate without importing source yet. |
| P5-002 | Or-on dependency/version/license compatibility gate | complete | `f2c966e` | Current registry/official-source discovery; Python 3.14 isolated imports for Pipecat/LiveKit/native stack; isolated and target `pip-audit` clean; model-license download boundary documented | Keep model assets blocked until immutable revision/hash/license records exist. |
| P5-003 | Import `oron-common`, `oron-db`, and `oron-flows` | complete | `f2c966e` | Original package identities retained; 115 passed/2 intentional skips; Ruff, Pyrefly, imports, repository guard, and real-PostgreSQL RLS helper test pass | Preserve these dependency-direction anchors while integrating higher layers. |
| P5-004 | Import/adapt tenancy, secrets, and sessions packages | complete | `5fc6391` | Package identities/direction preserved; provider-neutral identity binding, redacted secrets, default-off telephony, 249 offline Python tests, and dependency audit pass | Mount only through the later canonical API/service-auth boundary. |
| P5-005 | Reconcile imported models with canonical identity/RLS/schema | complete | `5fc6391` | Retained identity, role, and API-key models match canonical tables; repository boundary guard passes; 35 live PostgreSQL tests pass at sole head `b56eb0a0aca1` | Add new behavior only through an Alembic successor. |
| P5-006 | Canonical call/contact/campaign/object/event bridge migration | complete | `0b16ccb` | Generated successor `e24340ce81c8`; deterministic one-head SQL; tenant-consistent contact/campaign/object/session FKs; scoped idempotency; append-only RLS events; 38 live PostgreSQL tests | Keep `sessions` authoritative and emit transport events through the outbox. |
| P5-007 | Control API voice routes and generated TypeScript client | complete | `8d903a6` | Authenticated `GET /api/v1/voice/sessions`; canonical RBAC and tenant assertion; `platform_voice` RLS query; deterministic OpenAPI/client; container and same-origin login/BFF proof; full verification clean | Preserve this read-only contract while adding mutations through the simulator-first command boundary. |
| P5-008 | Telephony simulator and real-provider denial boundary | complete | `7a56c78` | CSRF/RBAC/service-auth command; deterministic PostgreSQL lifecycle/outbox/audit; replay idempotency and contact-conflict test; 39-test live gate; production-container E2E; both real-action gates tested | Keep the simulator as the default adapter and never add a fallback to real transport. |
| P5-009 | Import/adapt dispatcher and LiveKit webhook contracts | complete | `49c1d6d` | Signed fixture/tamper/replay tests; canonical assertion/capability tests; DID/persistence/trunk/default-off tests; sole head `315710614ae5`; 41 live PostgreSQL tests; no provider call | Keep runtime not-ready until the retained P5-010 agent launcher is injected. |
| P5-010 | Import/adapt Hebrew and Pipecat voice-agent packages | complete | `34a62e2` | 349 passed/3 explicit P5-011 skips; full Python suite 622 passed/45 intentional skips; Ruff and strict Pyrefly pass; model path/hash, secret redaction, default-off provider gate, launcher injection, base/voice dependency isolation, repository and secret guards verified | Keep all real provider execution denied while building the opt-in control-plane profile. |
| P5-011 | LiveKit/SIP/Redis opt-in Compose voice profile | complete | `5eef886` | Digest pins verified; Redis/LiveKit/SIP healthy; read-only SIP lists returned 0 inbound, 0 outbound, 0 rules; Redis/SIP have no host bindings; 63 focused and 632 full Python tests pass; TypeScript strict/test/build gate passes | Keep this profile mutation-free while adding canonical DID admission APIs. |
| P5-012 | Phone-number/DID admission and reconciliation | complete | `a246bf3`, `7b45140` | Authenticated simulator admission requires a published flow and restricted non-empty ACL; catch-all denial and read-only provider-disabled reconciliation pass; no provider mutation | Keep real DID/trunk changes behind a separate approved action. |
| P5-013 | Voice flow catalog, validation, publishing, and adapter UI | complete | `a246bf3`, `7b45140` | Retained component catalog, typed validation, immutable PostgreSQL versions, generated client, and unified authoring surface pass | Phase 6 owns the cross-channel compiler. |
| P5-014 | Canonical voice campaigns and CRM audience integration | complete | `a246bf3`, `7b45140` | Explicit voice consent, usable E.164 identity, IANA calling window, DB concurrency/attempt bounds, and per-campaign/contact idempotency pass on PostgreSQL 18.6 | Real dialing remains disabled. |
| P5-015 | Calls overview/detail and contact call action | complete | `a246bf3`, `7b45140` | Authenticated calls/detail routes and consent-gated contact simulator action render through same-origin BFF contracts | No carrier fallback exists. |
| P5-016 | Transcript, outcome, artifacts, usage, latency, and analytics | complete | `a246bf3`, `7b45140` | Ordered lifecycle includes transcript/outcome/usage/latency; deterministic object metadata and overview/detail metrics persist under tenant RLS | Binary recording/media remains object-storage work, never PostgreSQL bytes. |
| P5-017 | Observability, audit, provider diagnostics, and security controls | complete | `a246bf3`, `7b45140` | Correlated control API, safe audit metadata, read-only provider diagnostics, bounded policy values, scenario/idempotency conflicts, and default-off provider gates pass | Full production telemetry export is a later deployment concern. |
| P5-018 | Unit, contract, PostgreSQL, RLS, simulator, and concurrency tests | complete | `a246bf3`, `7b45140` | 41 live PostgreSQL tests plus control contract and web render suites pass; retained runner/dispatcher/concurrency suites remain in the full gate | Run consolidated P5-021 verification. |
| P5-019 | UI accessibility, responsive, keyboard, English/Hebrew/RTL checks | complete | `7b45140` | Semantic labels, status text, keyboard-native controls, responsive grids, reduced-motion inherited tokens, direction strategy, and explicit LTR phone rendering are covered | Broader WCAG certification remains out of scope. |
| P5-020 | Provenance, parity, architecture, runbook, and threat-model updates | complete | `7f1164c` | Source map, parity matrix, telephony architecture/package boundaries, threat model, README, and runbook distinguish simulator proof from deferred carrier activation | Re-review before any real-provider approval. |
| P5-021 | Full Phase 5 verification and clean checkpoint | complete | `73b4553`, `413ba21`, final checkpoint | Doctor/bootstrap/migrate, deterministic offline database gate, 41-test live PostgreSQL 18.6 gate, 634 Python tests, all TypeScript suites, strict lint/type checks, generated contracts, Next production build, production images/core health, read-only LiveKit/SIP smoke, dependency audits, guards, and upstream integrity pass | Prepare Phase 6 scope without enabling a provider. |

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

| ID | Task | Status | Commit | Verification evidence | Next exact task |
| --- | --- | --- | --- | --- | --- |
| P4-001 | Baseline, instructions, and Phase 4 reconstruction | complete | `ab9100f` | Clean Phase 3 baseline; locked clean upstreams; master Phase 4 scope recovered; scoped rules and WACRM instructions read | Complete code-level behavior inventory. |
| P4-002 | Locked WACRM behavior inventory and provenance plan | complete | `ab9100f` | Contacts, inbox, provider, webhook, pipeline, broadcast, automation, and public API behavior inspected; provenance recorded without wholesale copying | Keep mappings aligned as later slices land. |
| P4-003 | Canonical CRM/messaging repository package | complete | `5d0ccea` | Strict `@or-on/crm`; tenant-transaction contacts, inbox, simulator, pipelines, metrics, unit and live tests | Extend through bounded domain modules only. |
| P4-004 | Contacts, tags, notes, custom fields, and import | complete | `3c5e335` | CRUD/archive, E.164 dedupe, tags, notes, custom values, deterministic CSV import, detail UI, live rollback tests | Field-definition administration is incremental product work. |
| P4-005 | Shared inbox and conversation operations | complete | `ed7acb2` | Tenant-safe reads, unread/status, member-validated assignment, same-origin refresh, seeded inbox, responsive UI, authenticated routes | Replace polling only when a durable delivery transport is justified. |
| P4-006 | WhatsApp webhook and provider simulator | complete | `36c1674`, `e19b6dd` | Simulator auth/CSRF/dedupe; disabled real route verifies exact raw bytes and persists unique inbound work before acknowledgement | Real Meta activation remains explicitly deferred. |
| P4-007 | Human reply, delivery status, reactions, and quick replies | complete | `e19b6dd`, `ed7acb2` | Idempotent simulator reply, canonical delivery history, status, reactions, quick replies; no provider traffic | Provider-specific manual retry waits for provider activation. |
| P4-008 | Pipelines, stages, and deals | complete | `5d0ccea` | Canonical board and persisted same-pipeline stage movement API/UI pass strict/live builds | Rich deal editing is incremental product work. |
| P4-009 | Templates, broadcasts, campaigns, and durable delivery | complete | `e19b6dd` | Stable audience, idempotent jobs, claims/retry/leases, aggregates, live worker execution | Meta delivery adapter remains deferred and disabled. |
| P4-010 | Automation persistence and execution adapter | complete | `ed7acb2` | Draft/publish and manual empty-graph adapter produce persisted succeeded traces without replacing mature engines | Channel runtime adapters belong to their owning phases. |
| P4-011 | Teams, settings, analytics, and notifications | complete | `ed7acb2` | Metrics, canonical roster, workspace settings, notifications, safety UI | Invitations/role editing remain identity enhancements. |
| P4-012 | Scoped public API and API keys | complete | `d664781`, `e19b6dd`, `ed7acb2` | One-time issue, keyed-HMAC storage, RLS, resolver, revocation, scoped contacts REST; live/E2E checks | Expand resources only with versioned contracts. |
| P4-013 | MCP-compatible CRM tool surface | complete | `e19b6dd` | Three typed tool contracts expose safe reads and require explicit write confirmation | Bind them to the unified MCP transport later. |
| P4-014 | Messaging worker and PostgreSQL durable work | complete | `d664781`, `e19b6dd` | Narrow cross-tenant claims, `SKIP LOCKED`, leases, bounded retries, inbound completion, simulator delivery, live tests | Add production metrics before provider activation. |
| P4-015 | CRM/WhatsApp UI integration and accessibility | complete | `ed7acb2` | Production render/build, semantic controls, authenticated HTTP pages, 390px visual check with zero horizontal overflow, explicit Hebrew direction unit strategy | Authenticated visual regression automation can be added without browser-held passwords. |
| P4-016 | Security, E2E, parity, provenance, and documentation | complete | final checkpoint | Architecture/runbook/provenance current; auth/CSRF, signature, HMAC API key, live RLS/claim tests and simulator/API E2E pass | Re-review before real provider activation. |
| P4-017 | Full Phase 4 verification | complete | final checkpoint | Live PostgreSQL, consolidated verify, production image/core health, simulator campaign, scoped API, audits, upstream integrity pass | Await explicit next-phase scope. |

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

| ID | Task | Status | Commit | Verification evidence | Next exact task |
| --- | --- | --- | --- | --- | --- |
| P3-001 | Baseline and upstream verification | complete | `523c8a2` | Clean target at `9ca3a02`; Or-on/WACRM/OpenLive clean at locked SHAs; instructions, architecture, ADRs, threat model, migrations, Next 16 bundled auth/security docs, and upstream identity code reviewed | Reverify before every later phase. |
| P3-002 | Current authentication technology discovery | complete | `523c8a2` | Official docs/registries reviewed for Better Auth 1.7.2, Auth.js, Lucia, Keycloak, Argon2, jose, postgres, and Next.js 16 | Re-evaluate only on a material requirements/framework change. |
| P3-003 | Authentication selection ADR | complete | `523c8a2` | ADR 0016 selects a narrow canonical PostgreSQL adapter and records candidate rejection rationale | Keep Alembic and canonical membership authority. |
| P3-004 | Identity threat-model refinement | complete | final docs checkpoint | Implemented and deferred identity controls separated in the living threat model | Re-review before public signup, OAuth, or MFA. |
| P3-005 | Authentication database schema | complete | `0283226` | Generated revisions `c30e1edd7c7f` and live-found hardening successor `3efa5431c380`; one head | Keep successor-only history. |
| P3-006 | Password and token primitives | complete | `7de75c5` | Argon2id, 256-bit random tokens, HMAC-SHA-256 digests, constant-time comparison tests | Rotate policy only through compatibility review. |
| P3-007 | Session lifecycle implementation | complete | `7de75c5` | Login/resolve/idle+absolute expiry/rotate/revoke/status enforcement implemented and live-tested | Add administrative session listing later. |
| P3-008 | Cookie and CSRF controls | complete | `7de75c5`, `e578b91` | HttpOnly SameSite session cookie, session-bound CSRF token, external-origin/Fetch Metadata checks | Apply shared guard to every future mutation. |
| P3-009 | BFF authentication endpoints | complete | `7de75c5`, `e578b91` | Login/session/logout/tenant/live-grant same-origin routes pass host and production-container smoke tests | No public signup/recovery claimed. |
| P3-010 | Tenant switching | complete | `7de75c5` | Membership revalidation, atomic digest rotation, old-token invalidation, audit | Extend UI only with real tenant management. |
| P3-011 | RBAC permission model | complete | `7de75c5` | Canonical owner/admin/agent/viewer matrix and deny tests | Domain object checks remain feature-owned. |
| P3-012 | PostgreSQL RLS context propagation | complete | `7de75c5` | Transaction helper sets transaction-local tenant/user/role from server identity; existing live leakage/RLS suite passes | Use helper in each new TS repository. |
| P3-013 | Service-to-service authentication proof | complete | `7de75c5` | Short-lived signed issuer/audience assertions with tamper/audience tests | Replace shared secret with workload identity in GCP phase. |
| P3-014 | WebSocket authentication contract | complete | `7de75c5` | Capability-bound live-session grant and live-agent validation proof | Bind to real OpenLive session during protocol port. |
| P3-015 | Unified login and authenticated shell | complete | `7de75c5` | Accessible login, server-enforced page redirects, identity/tenant shell; desktop and 390px browser QA passed | Extend only with real product modules. |
| P3-016 | Permission-aware navigation and command palette | complete | `7de75c5` | Shell is session-aware; unavailable modules remain visibly disabled and expose no fake actions | Filter real future actions by typed permissions. |
| P3-017 | Development seeds and simulators | complete | `7de75c5`, `e578b91` | Idempotent ignored auth material and deterministic two-tenant fictional operator seed; Compose-safe Argon2 literals | Never print or commit generated password. |
| P3-018 | Audit and observability integration | complete | `7de75c5` | Login, tenant switch, and revocation write safe immutable audit events; route errors omit credentials | Add metrics without identity cardinality leaks. |
| P3-019 | Authentication security tests | complete | `0283226`, `7de75c5`, `e578b91` | 19 auth unit tests plus four live PostgreSQL identity tests within the 29-test database gate | Expand with every new identity capability. |
| P3-020 | CI and dependency guards | complete | `e578b91` | Consolidated frozen install, formatting, lint, typing, tests, migration/live DB, audits, build, and repository guards pass | Keep auth package/container build ordering explicit. |
| P3-021 | Documentation consolidation | complete | final docs checkpoint | ADR, architecture, threat model, README, auth runbook, runtime topology updated and link-checked | Keep implemented/planned claims distinct. |
| P3-022 | Full Phase 3 verification | complete | final docs checkpoint | Consolidated verify, offline/live database gates, production container auth smoke, responsive browser QA, audits, and final integrity all pass | Obtain an explicit Phase 4 specification before branching. |

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

| Repository | Expected commit | Verified branch | Result |
| --- | --- | --- | --- |
| Target baseline | `93eb808e65f8edb1754c1940afe1949e7e18223a` | `codex/phase-0-audit` | Clean before branching; `AGENTS.md`, `MASTER_PROMPT.md`, and Phase 0 audit documents tracked. |
| Or-on | `cece174f4d590a1b8a283d539dd66e08cc689aa9` | `master` | Commit matched; worktree clean. |
| WACRM | `98b5bd26e8feacacfd4b74ff58411acb8154d212` | `main` | Commit matched; worktree clean. |
| OpenLive | `849173cd1c8c17a95d600b17b428c301722bf5df` | `main` | Commit matched; worktree clean. |

Phase 0 conclusions were rechecked against instructions, manifests, lockfiles,
Docker/deployment configuration, migration documentation, CI, and current code at
the locked commits. The verified conflicts remain: Firebase console identity in
Or-on, Supabase runtime coupling in WACRM, and SQLite/JSON business persistence in
OpenLive. These are required target adaptations; the surrounding working engines
remain preservation candidates.

## Phase 1 tasks

Status values: `pending`, `active`, `complete`, `blocked`.

| ID | Task | Status | Commit | Verification | Notes / next exact task |
| --- | --- | --- | --- | --- | --- |
| P1-001 | Baseline verification | complete | `b859efb` | Clean target baseline; exact upstream SHAs and clean worktrees verified | Baseline recorded above. |
| P1-002 | Technology baseline discovery | complete | `b859efb` | Official registries/docs; Node/pnpm, Python core, and Python voice/native compatibility gates | Baseline selects Node 24 LTS, pnpm 11, Python 3.14, PostgreSQL 18, patched Next/React, and a documented TypeScript 6 fallback. |
| P1-003 | Architecture and ADR framework | complete | `b859efb` | Required architecture documents and ADRs 0001–0015 reviewed; relative-link and sequence checks passed | Accepted decisions distinguish implemented controls from deferred direction. |
| P1-004 | Repository hierarchy | complete | `d380bf8` | Intended roots contain real code/config or a concise ownership README; no empty enterprise scaffold was created | Future directories require real ownership and content. |
| P1-005 | pnpm/TypeScript workspace | complete | `a788acd` | Node 24.20, pnpm 11.24 frozen workspace; strict typecheck, 15 tests, all package builds, and Next production build pass | Keep pnpm as the sole target JS package manager. |
| P1-006 | uv/Python workspace | complete | `30635b9` | uv 0.12.7 sync, all four packages imported/built; Ruff, Pyrefly, and 8 pytest tests passed on Python 3.14.7 | Preserve this runtime boundary when Or-on packages are imported later. |
| P1-007 | Typed configuration | complete | `e616fac` | TypeScript/Python validation, PostgreSQL-only URL checks, redaction, and default-off provider tests passed | Entrypoints inject these settings rather than reading environment variables in business code. |
| P1-008 | PostgreSQL local infrastructure | complete | `009357e` | PostgreSQL 18.6 named volume, loopback mapping, role bootstrap, health check, control API, and web Compose chain are healthy | Preserve the named development volume; use separate disposable databases for integration tests. |
| P1-009 | Alembic foundation | complete | `4d99516` | Fresh PostgreSQL upgrade of all 27 revisions, `current --check-heads`, supported target-successor downgrade/re-upgrade, and non-empty historical backfill pass | Historical `0004` data downgrade is intentionally backup-based. |
| P1-010 | Contract architecture/proof | complete | `a788acd` | Deterministic FastAPI OpenAPI, generated TypeScript client, versioned JSON Schema event contract, validation tests, and freshness workflow pass | Expand only through versioned language-neutral contracts. |
| P1-011 | Unified web shell | complete | `a788acd` | Next 16.3 production build, render tests, and live browser QA passed; readiness UI reports PostgreSQL outage honestly | Product modules remain clearly marked planned. |
| P1-012 | Python service foundations | complete | `30635b9` | Control API lifecycle/liveness/readiness tests pass; dispatcher and voice entrypoints import with dependency-safe/default-off lifecycle | Later phases integrate retained Or-on packages into these boundaries. |
| P1-013 | TypeScript service foundations | complete | `a788acd` | Live-agent HTTP health/readiness and messaging-worker equivalent health lifecycle build, typecheck, and tests pass | No OpenLive/WACRM business behavior has been ported. |
| P1-014 | Design-system foundation | complete | `a788acd` | Tokens, two themes, focus/reduced-motion rules, eight primitives, and render tests pass | Extend incrementally when real source screens are integrated. |
| P1-015 | Makefile developer workflow | complete | `009357e` | All targets route through one provider-safe runner; bootstrap, migration, live DB, verify, Compose, and container paths pass through the underlying runner | GNU Make remains absent, so literal `make ...` spelling is the only outstanding command-surface check. |
| P1-016 | Observability foundation | complete | `a788acd` | Shared structured JSON logging, recursive secret redaction, service/environment fields, and safe health logging conventions pass tests | OpenTelemetry transport/export remains deferred. |
| P1-017 | Security foundation | complete | `d380bf8` | Threat model explicitly separates implemented and planned controls; provider, config-redaction, secret-scan, DB-role, and dependency controls have tests/checks | Re-review before each deferred public/provider/auth capability ships. |
| P1-018 | CI foundation | complete | `5885b98` | Target-only jobs cover frozen TS/Python installs, database migration, contracts, architecture/security, audits, production build, and containers | CI requires no sibling repository or provider/GCP credential. |
| P1-019 | Dependency/prohibited-runtime guards | complete | `5885b98` | 15 Python tests plus repository, secret, and documentation scans pass; package cycles/directions, runtime imports, database images, migration authorities, and sibling references are checked | Audit docs and future one-time importers are deliberately excluded from runtime-import rejection. |
| P1-020 | GCP development architecture | complete | `d380bf8` | One-VM resource contract, Terraform/core-provider constraints, Caddy edge direction, identity/secrets/backup design; no credentials or apply | Resource implementation and cost-bearing actions remain deferred. |
| P1-021 | Documentation consolidation | complete | `d380bf8` | Required documents, relative links, README/runbooks, ADR index, threat model, and Phase 2 entry plan pass automated validation | Keep status claims aligned with implemented controls. |
| P1-022 | Full verification | blocked | `009357e` | Runtime/database/container gates and consolidated verification pass; doctor passes Docker/daemon and accepts Compose 5 after a compatibility fix | Install GNU Make and run the literal `make ...` sequence; selected Node/pnpm remain repository-local. |

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

| Repository | Expected commit | Verified branch | Result |
| --- | --- | --- | --- |
| Target baseline | `20b46159078ec533a9891e6768d47595e35b7a7c` | `codex/phase-1-foundation` | Clean before branching; Phase 2A branch created from this exact commit. |
| Or-on | `cece174f4d590a1b8a283d539dd66e08cc689aa9` | `master` | Commit matched; worktree clean. |
| WACRM | `98b5bd26e8feacacfd4b74ff58411acb8154d212` | `main` | Commit matched; worktree clean. |
| OpenLive | `849173cd1c8c17a95d600b17b428c301722bf5df` | `main` | Commit matched; worktree clean. |

## Phase 2A tasks

Status values: `pending`, `active`, `complete`, `blocked`.

| ID | Task | Status | Commit | Evidence | Pending live validation / next exact task |
| --- | --- | --- | --- | --- | --- |
| P2A-001 | Baseline and upstream verification | complete | `109bf9e` | Mandatory target, audit, architecture, ADR, target migration, Or-on lineage, WACRM SQL/runtime, and OpenLive persistence sources read; exact clean SHAs verified | No live validation needed; baseline is fixed at Phase 1 `20b4615`. |
| P2A-002 | Inspect target + Or-on Alembic graphs | complete | `4d9a219` | Mechanical metadata: 22 revisions, root `0001`, branch `8eda5976c920`, merge `8aa960fd77ec`, head `a41d2f6c2925` | Continue successors from the preserved head. |
| P2A-003 | Reconcile Phase 1 bootstrap migration | complete | `d67f8f7` | Phase 1 progress proves live upgrade/current were blocked; old revision retained outside active versions and content recreated at generated successor `34376836baf5` | Live upgrade remains pending Phase 2B. |
| P2A-004 | Import/preserve complete Or-on Alembic lineage | complete | `4d9a219` | All 22 revisions imported; IDs/parents/branch/merge/order preserved; three import paths and one offline-only guard documented | Live historical backfill remains pending Phase 2B. |
| P2A-005 | Verify one canonical offline Alembic graph/head | complete | `363189f` | 27 revisions; sole root `0001`, branch point `8eda5976c920`, sole head `f5e8b540dfeb`; deterministic SQL/static contract pass | Fresh live upgrade/current **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-006 | Canonical tenant/identity mapping | complete | `d67f8f7` | Or-on tenant/user/membership preserved; provider-neutral identity bindings and tenant invitations created | RLS/membership execution pending Phase 2B. |
| P2A-007 | Database schema/ownership architecture | complete | `109bf9e` | Historical Or-on tables stay in place; bounded new schemas and owners documented | Catalog execution pending Phase 2B. |
| P2A-008 | WACRM migration inventory | complete | `109bf9e` | All 39 source SQL migrations have explicit disposition; zero unexplained | Keep mapping aligned with generated revisions. |
| P2A-009 | Translate WACRM identity/account semantics | complete | `d67f8f7` | Account→tenant, profile→user, member→membership, provider-neutral bindings/invitations | Membership/RLS execution pending Phase 2B. |
| P2A-010 | Translate WACRM CRM schema | complete | `69004e9` | Generated `a929e3f55c7a`: contacts/identities/tags/fields/notes/pipelines/stages/deals with composite tenant FKs | Constraints/indexes/RLS pending Phase 2B. |
| P2A-011 | Translate WACRM messaging schema | complete | `69004e9` | Generated `2ef8ecd10c3d`: channels/conversations/messages/delivery/reactions/templates/quick replies/broadcasts | Triggers/idempotency/RLS pending Phase 2B. |
| P2A-012 | Translate WACRM pipeline/campaign schema | complete | `69004e9` | Canonical campaign parent coexists with preserved Or-on voice campaigns; messaging broadcast projection references parent | Live claim/aggregate behavior pending Phase 2B. |
| P2A-013 | Translate WACRM automation/flow schema | complete | `42c21ad` | Generated `cebe5f87cf18`: definitions, immutable published versions, runs, step runs, validation and retry/error metadata | Trigger and RLS execution pending Phase 2B. |
| P2A-014 | Translate WACRM AI/knowledge/database semantics | complete | `42c21ad` | Generated `cebe5f87cf18`: model metadata, sources/documents/chunks, PostgreSQL FTS GIN, usage records; pgvector is not required | FTS generation/query behavior pending Phase 2B. |
| P2A-015 | Supabase Auth/Realtime/Storage/RPC removal mapping | complete | `109bf9e` | Auth/context, Realtime, Storage, service-role, and every RPC classified | Application adapters remain later-phase work. |
| P2A-016 | OpenLive persistence inventory | complete | `75aa1a2` | Actual SQLite schema/query code, legacy conversation migration, encrypted JSON stores, settings APIs, voice-profile files, browser-local keys, and ACP session references mapped | Keep map aligned with importer coverage. |
| P2A-017 | OpenLive PostgreSQL target schema | complete | `75aa1a2` | Generated `f5e8b540dfeb`: tenant/user-scoped chats, ordered messages, preferences, credential-referenced providers, object-backed voice profiles, and sessions | Constraints/RLS/grants pending Phase 2B. |
| P2A-018 | OpenLive legacy importer foundation | complete | `55bdd64` | Explicit SQLite/JSON sources; deterministic UUID mapping/checksums, duplicate/conflict handling, secret-safe dry-run, canonical PostgreSQL writer, six fixture/unit tests | Importer writes/idempotency ledger execution **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-019 | Canonical RLS policies for new tenant data | complete | `75aa1a2` | Static fail-closed FORCE RLS policies exist for identity, CRM, messaging, automation, agents, objects, ops, audit, and live tables | **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-020 | Unified runtime roles/grants successor migration | complete | `d67f8f7` | Generated successor defines six roles without privileged attributes and preserves legacy Or-on roles | **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-021 | Inbox/outbox/idempotency foundation | complete | `42c21ad` | Generated `cebe5f87cf18`: inbound/outbox events and scoped idempotency keys with explicit uniqueness and schedules | Atomicity/deduplication execution pending Phase 2B. |
| P2A-022 | PostgreSQL durable-job foundation | complete | `363189f` | Generated `cebe5f87cf18`: tenant-bound SECURITY DEFINER claims, leases, bounded attempts, `SKIP LOCKED`, exponential backoff+jitter, terminal failure | Concurrency/stale lease/retry behavior pending Phase 2B. |
| P2A-023 | Audit/object metadata foundation | complete | `42c21ad` | Generated `cebe5f87cf18`: metadata-only object records and append-oriented audit records without runtime update/delete grants | Privilege/immutability behavior pending Phase 2B. |
| P2A-024 | Index/constraint/pagination review | complete | `363189f` | Manifest checks 14 critical indexes; migrations define composite tenant FKs, E.164/provider/idempotency uniqueness, explicit deletes, and chronological keyset indexes | Constraint/index catalog and query-plan behavior pending Phase 2B. |
| P2A-025 | Type/contract generation updates | complete | `363189f` | `db/contracts/schema-manifest.json` is a checked consumer catalog at head `f5e8b540dfeb`; existing OpenAPI/event generation remains fresh; no TS migration authority added | Generate DB types only when a real TS repository consumes them. |
| P2A-026 | Offline migration/security guards | complete | `363189f` | Graph/parent/one-head, deterministic SQL, RLS/FORCE/policy, index, extension, definer search-path, Supabase/public/privileged-role guards | Live catalog behavior pending Phase 2B. |
| P2A-027 | Prepare Phase 2B live PostgreSQL tests | complete | `363189f` | 18 collected PostgreSQL tests cover version/head/catalog/roles/RLS/tenant CRUD/domain grants/DDL/idempotency/FK/outbox/flows/FTS/jobs/importer/seed | All 18 are **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-028 | Database architecture/migration documentation | complete | `a311371` | Required architecture, lineage, WACRM/OpenLive maps, schema ownership, extension inventory, notices, and Phase 2B runbook pass the documentation/link guard | Maintain claims as Phase 2B evidence arrives. |
| P2A-029 | Full offline verification | complete | `a311371` | Dedicated offline gate, all Python/TS checks/tests/build, contracts, repository/secret/docs guards, and final upstream integrity pass | Live/database execution checks remain Phase 2B only. |

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

| ID | Task | Status | Commit | Evidence | Remaining work |
| --- | --- | --- | --- | --- | --- |
| P2B-001 | Docker/toolchain readiness | complete | `009357e` | Engine/daemon and ports passed; doctor now accepts the Compose v2-or-newer command surface, including installed Compose 5.5 | Install GNU Make for literal `make ...` acceptance spelling. |
| P2B-002 | Fresh migration and catalog | complete | `4d99516` | Multiple empty PostgreSQL 18.6 databases upgraded through all 27 revisions to sole head `f5e8b540dfeb`; catalog/extensions/functions/indexes and target-successor downgrade/re-upgrade checked | Historical `0004` downgrade remains intentionally data-irreversible and requires a backup. |
| P2B-003 | Seed and readiness | complete | `009357e` | JSONB seed fixed and proven idempotent; least-privilege `platform_web` readiness succeeds | None for the implemented seed. |
| P2B-004 | Roles and RLS automated suite | complete | `009357e` | Runtime attributes, FORCE RLS, missing context, cross-tenant CRUD, membership, `SET LOCAL`, role separation, DDL denial, and audit immutability passed | Broaden policy fixtures as new domain operations arrive. |
| P2B-005 | Integrity/concurrency/importer suite | complete | `bb5c40d` | Provider/message/E.164 idempotency, all 91 unified-schema FK delete declarations, representative CASCADE/RESTRICT/SET NULL execution, check constraints, outbox rollback, immutable flows, message/audit keysets, FTS, concurrent jobs, seed, OpenLive JSON/SQLite imports, and WACRM export mapping passed | Extend fixtures when later domain operations add constraints. |
| P2B-006 | Full core runtime | complete | `009357e` | PostgreSQL, control API, and web containers are healthy; host API and web BFF both report PostgreSQL ready; all ports are loopback-bound | GNU Make remains a host-tool gap only. |
| P2B-007 | Consolidated verification | complete | `009357e` | Initial format, lint, strict typing, tests, contracts, production builds, container builds, guards, peer check, pnpm audit, and pip-audit passed | Superseded by the final P2B-009 rerun. |
| P2B-008 | Extended database acceptance | complete | `4d99516`, `bb5c40d` | Non-empty encrypted `0004` backfill, supported successor downgrade/re-upgrade, complete FK delete-action catalog/family behavior, keyset pagination, SQLite importer writes, and WACRM importer idempotency all pass on disposable PostgreSQL 18.6 databases | No remaining Phase 2B database item. |
| P2B-009 | Final verification/checkpoint | complete | final checkpoint | Fresh 25-test PostgreSQL gate; 35 offline Python tests with 25 correctly separated live skips; 15 TypeScript tests; Ruff/ESLint/Prettier/Pyrefly/strict TypeScript; contracts; one-head check; Next production build; both production images; healthy core Compose chain; peer checks; repository/secret/docs guards; and zero known pnpm/pip-audit vulnerabilities all pass | Remote CI evidence remains separate; GNU Make is still a host-tool spelling gap only. |

Live validation exposed and fixed four real integration issues: the seed passed
an invalid JSONB literal, the legacy importer passed timestamp strings instead
of timezone-aware values, the control API bound only to container loopback, and
the local runner allowed an unrelated ambient `DATABASE_URL` to override the
repository `.env`. The unsafe ambient endpoint returned unavailable; no external
schema or data mutation was performed. The runner now gives the explicit local
file precedence and provider flags remain false.

## Next exact task

Prepare an explicit Phase 6 scope for the OpenLive live-agent/Live Lab
integration. Begin with locked-source protocol, provider-harness, browser-local
speech, WebSocket authentication, desktop, and persistence-adapter parity maps;
do not port features or enable external providers until that scope is approved.
