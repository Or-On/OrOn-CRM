# Phase 5 — Telephony

## Status and baseline

This document is the authoritative Phase 5 implementation scope reconstructed
from the master prompt, the completed Phase 0–4 evidence, and the locked Or-on
source at `cece174f4d590a1b8a283d539dd66e08cc689aa9`.

- Phase 4 baseline: `e6d2e303c07a3a0df35e39d30baf1f5584564464`
- Phase 5 branch: `codex/phase-5-telephony`
- Preparation status: complete
- Application implementation status: in progress through P5-008
- Real-provider status: prohibited by default

The branch is a planning checkpoint until the explicit Phase 5 implementation
request. Preparation does not enable LiveKit, SIP, carrier, speech, or model
provider traffic and does not claim telephony parity.

## Mission

Integrate Or-on's proven Python voice system into the unified platform through
thin adapters and stable contracts while preserving its package identities,
dependency direction, PostgreSQL/RLS behavior, LiveKit/SIP/Pipecat lifecycle,
flows, Hebrew/audio behavior, sessions, campaigns, diagnostics, and tests.

Phase 5 must deliver a simulator-first voice experience inside the authenticated
Or-On product shell. A fictional operator must be able to start a simulated
outbound call from a canonical contact, observe lifecycle events, inspect a
transcript and outcome, and see the call in voice/campaign analytics without a
carrier, phone call, speech-provider credential, or external AI request.

The working engine remains:

```text
carrier SIP
  -> LiveKit SIP
  -> LiveKit room
  -> retained Or-on dispatcher
  -> retained Or-on Pipecat voice agent
```

The target integration becomes:

```text
authenticated browser
  -> same-origin Next.js BFF
  -> generated control-api client
  -> retained Or-on tenancy/session/flow packages
  -> canonical PostgreSQL

outbound call command
  -> simulator adapter by default
  -> retained dispatcher + LiveKit SIP only after two explicit safety gates

LiveKit webhook
  -> signature verification
  -> DID/tenant/flow resolution
  -> persisted call session
  -> one retained voice agent per room
```

## Source-informed preservation boundary

The following package identities are preserved and imported in dependency order:

1. `oron-common`
2. `oron-db`
3. `oron-flows`
4. `oron-tenancy`
5. `oron-secrets`
6. `oron-sessions`
7. `oron-hebrew`
8. `oron-agent`
9. `oron-dispatcher`

The one-way source direction remains:

```text
oron-agent / oron-dispatcher
  -> oron-sessions
  -> oron-tenancy
  -> oron-db
  -> oron-common
```

`oron-flows`, `oron-hebrew`, and `oron-secrets` remain bounded capabilities.
New `platform-*` code may adapt across systems but must not become renamed copies
of these packages.

The import includes only source needed for the target runtime and its behavioral
tests. It does not copy the source Vite console, GKE/Cloud Build deployment,
real environment files, customer data, model weights, or obsolete Firebase
console integration. Every copied or adapted artifact is added to
`docs/audit/source-map.md` with the locked SHA and proprietary-project treatment.

## Technology disposition

### Preserved

- Python, FastAPI, Pydantic, SQLModel, SQLAlchemy, Alembic, asyncpg, and httpx.
- PostgreSQL transaction-local tenant context and fail-closed RLS.
- LiveKit server, LiveKit SIP, LiveKit APIs, and Redis only for LiveKit/SIP.
- Pipecat and the bundled `pipecat.flows` namespace.
- Per-call dispatcher, one bot per room, inbound DID admission, outbound SIP
  orchestration, session lifecycle, campaign claiming, artifact capture,
  transcript/outcome/usage/latency semantics, and graceful cancellation.
- Hebrew G2P/normalization/TTS filters and the existing audio pipeline, subject
  to dependency/model license and compatibility gates.
- Or-on flow composition/component catalog and immutable published flow versions.
- uv, Ruff, Pyrefly, pytest, dependency injection, enums, and source tests.

### Adapted because the unified target requires it

- Or-on session/tenancy routes are mounted behind the canonical control API and
  stable versioned OpenAPI instead of becoming a second public product API.
- The standalone Or-on console admin/Firebase boundary is replaced by the
  canonical Phase 3 session, tenant, RBAC, CSRF, and service-auth boundaries.
- The browser uses same-origin BFF routes and generated types; it never receives
  database, LiveKit API-secret, carrier, or speech-provider credentials.
- Existing `sessions` remain the authoritative call records. They are bridged to
  canonical contacts, platform campaigns, objects, audit records, and events
  with target-owned successor migrations rather than duplicated in a new
  `voice.calls` table.
- Existing Or-on voice campaigns remain the execution projection beneath the
  canonical `platform.campaigns` parent. Canonical contacts are the audience;
  protected phone data is resolved only at the bounded voice adapter.
- Legacy Or-on runtime roles may coexist during migration, but target processes
  move to the least-privilege `platform_voice`/`platform_worker` direction only
  after live role and RLS parity passes.
- Existing artifact URIs are supported during migration. New recordings and
  transcript artifacts use canonical object metadata and the mounted local
  object directory; large bytes never enter PostgreSQL.
- Source Loguru output is adapted to the platform structured/redacted logging
  contract without changing call behavior.

### Required removals from the target runtime

- `firebase-admin`, Firebase token verification, and Firebase browser config.
- HTTP Basic admin-console access as an application authorization model.
- Any real-provider path that bypasses `ENABLE_REAL_TELEPHONY=false`.
- Any SIP trunk creation with an empty allowed-address ACL.
- Any runtime dependence on the sibling `../or-on` checkout.

No optional technology replacement is approved or proposed in Phase 5.

## Canonical data decisions

### Calls and sessions

The preserved public-schema `sessions` table is the canonical Phase 5 call
record. The product may label it a call, but Phase 5 must not create a parallel
table for the same lifecycle.

Target-owned migrations may add only integration fields and child records proven
necessary by product queries, including:

- canonical `crm.contacts` reference;
- canonical `platform.campaigns` reference;
- initiating canonical user/service reference;
- provider call/event identifier and idempotency key;
- object metadata references for transcript/recording artifacts;
- append-only lifecycle/event data when the source session row cannot represent
  ordered state safely.

Existing encrypted caller/callee fields and blind indexes are preserved. The UI
must not receive decrypted phone data merely because it displays a call. Contact
resolution uses tenant-scoped normalized channel identities and existing blind
index semantics.

### Phone numbers and SIP admission

The preserved `phone_numbers` table remains the DID-to-tenant/flow authority.
Registration and reprovisioning must be atomic or compensating, report provider
drift explicitly, and fail closed when SIP provisioning is unavailable. A
reconciliation read never silently fixes provider state.

The local SIP control-plane profile must include Redis. An SFU-only profile is
not valid evidence for trunk, dispatch-rule, or DID behavior. An empty ACL is
always rejected; `0.0.0.0/0` remains an explicit development-only danger that is
never part of ordinary bootstrap or automated tests.

### Campaigns and contacts

Voice campaigns use a canonical `platform.campaigns(channel='voice')` parent and
the retained Or-on campaign/contact execution tables as the channel projection.
Audience membership references canonical contacts rather than creating a second
CRM contact population. The adapter enforces active contact state, valid E.164
identity, voice consent/opt-out rules, bounded attempts, calling windows, and
per-tenant concurrency before work can be claimed.

### Flows

The retained Or-on graph, component catalog, validation, publishing, and
Pipecat execution semantics remain the Phase 5 voice-flow engine. Unified web
screens may author and inspect this voice capability, but Phase 5 does not claim
the Phase 7 cross-channel canonical graph/compiler is complete. No working
Or-on runtime is deleted or rewritten.

### Transcript, recording, outcome, and cost

The simulator produces deterministic, PII-free transcript/outcome/usage data via
the same persistence contract as the real dispatcher. Real transcripts and
recordings remain protected artifacts. Metadata, tenant ownership, checksum,
retention, and references live in PostgreSQL; bytes live in the mounted object
directory locally and GCS later.

## Runtime and contract boundaries

### Unified web/BFF

The authenticated browser talks only to same-origin Next.js routes. Every
mutation uses the canonical CSRF guard and permission checks. Expected product
surfaces are:

- calls overview and active/historical status;
- call detail with safe contact context, timeline, transcript, outcome, usage,
  latency, and artifact availability;
- phone-number/DID configuration and reconciliation diagnostics;
- voice campaign creation, audience preview, progress, pause/resume/cancel;
- voice flow list/editor/validate/publish experience;
- simulator-based test call;
- voice analytics and provider-health diagnostics.

Screens replace source-console behavior only as their parity items pass. The
source console is never copied wholesale and unavailable operations are marked
honestly.

### Control API

FastAPI/OpenAPI remains authoritative for Python HTTP contracts. Versioned
external BFF-facing capabilities should include calls, sessions, flows, phone
numbers, campaigns, component types, analytics, and safe artifacts. Generated
TypeScript client/type freshness remains mandatory.

The control API authenticates the internal BFF using the established short-lived
service assertion and propagates canonical tenant/user/role context. It does not
accept a browser-held service key or trust arbitrary `X-Tenant-Id` headers.

### Dispatcher

The dispatcher retains LiveKit webhook verification, inbound DID resolution,
one-agent-per-room orchestration, outbound SIP calls, browser/local test rooms,
active-call diagnostics, hangup, and finalization. Target adaptations add:

- short-lived service authentication and explicit audience;
- provider flag enforcement at the lowest real SIP boundary;
- idempotent outbound command handling;
- structured readiness for PostgreSQL/control API, LiveKit, and required SIP
  dependencies;
- redacted structured logs and safe error envelopes;
- durable lifecycle persistence before serving or dialing a call.

A persistence failure cannot be swallowed while a chargeable call continues.

### Voice agent

The voice agent retains the Pipecat/LiveKit transport, flow binding, turn-taking,
barge-in/cancellation, transcript collection, artifact capture, usage/cost,
language/Hebrew processing, idle/hangup behavior, and provider adapters. Phase 5
adapts configuration and lifecycle to platform conventions but does not rewrite
the audio engine.

Optional speech/LLM/TTS providers report unavailable without breaking the core
simulator stack. No model or provider asset is downloaded merely to make normal
bootstrap pass.

### Events

Call lifecycle events use a versioned language-neutral contract and durable
PostgreSQL outbox state. At minimum:

- `voice.call.requested.v1`
- `voice.call.started.v1`
- `voice.call.answered.v1`
- `voice.call.transcript.updated.v1`
- `voice.call.ended.v1`
- `voice.call.failed.v1`
- `voice.call.outcome.recorded.v1`

LISTEN/NOTIFY may wake consumers but is never the durable record. Cross-channel
automation consumption remains Phase 7; Phase 5 only proves the event contract
and persistence.

## Provider safety model

Normal development and CI use the telephony simulator. Real outbound calling
requires all of the following:

1. `ENABLE_REAL_TELEPHONY=true` in the trusted server environment.
2. Explicit user approval for that concrete call/test run.
3. Valid configured LiveKit/SIP/provider credentials.
4. A registered tenant, canonical contact/number, published flow, consent, and
   idempotency key.
5. A runtime path that passes authorization, audit, rate/concurrency, calling
   window, and provider-readiness checks.

The UI flag alone is never authority. The simulator and real adapter use
different provider identifiers and cannot silently fall through to one another.
Inbound provider infrastructure, webhooks, trunks, DIDs, or firewall rules are
not created or modified during ordinary Phase 5 implementation.

`ENABLE_REAL_TELEPHONY` remains false in `.env.example`, tests, Compose defaults,
and local development. Tests assert that missing, malformed, or false values deny
the real adapter.

## Local infrastructure direction

The existing Compose `core` profile remains small. Phase 5 adds an opt-in `voice`
profile with pinned images and health checks for:

- Redis used only by LiveKit/SIP;
- LiveKit server;
- LiveKit SIP control plane;
- dispatcher;
- voice agent where a provider-free mode is available.

The simulator works without the voice profile. The local SIP profile validates
control-plane behavior but does not claim carrier media works through Docker
Desktop/Windows networking. Real SIP media remains a protected Linux/VM smoke
test for a later explicitly approved run.

PostgreSQL remains the only authoritative application database. Redis never
stores authoritative call, campaign, contact, session, job, or transcript state.

## Implementation slices

1. Verify baseline, locked upstream, source behavior, dependency/license risk,
   and current official compatibility before import.
2. Import `oron-common`, `oron-db`, and `oron-flows` with original identities and
   tests; prove the dependency graph and schema contract remain coherent.
3. Import/adapt `oron-tenancy`, `oron-secrets`, and `oron-sessions`; replace
   identity assumptions while preserving RLS, encryption, sessions, campaigns,
   artifacts, and flow storage.
4. Mount the retained control-plane/session behavior behind the canonical control
   API and generate deterministic TypeScript clients.
5. Add target-owned database bridge migration(s) for canonical contacts,
   campaigns, idempotency, objects/events, roles, grants, and indexes; preserve
   one Alembic head and all historical Or-on revisions.
6. Implement the telephony simulator against the real persistence/contracts and
   provider-denial boundary.
7. Import/adapt `oron-dispatcher`, removing Firebase/admin coupling and adding
   canonical service auth, idempotency, health, and safety gates.
8. Import/adapt `oron-hebrew` and `oron-agent` in a separate heavy dependency
   group; preserve audio/flow behavior and document any compatible fallback.
9. Add the opt-in LiveKit/SIP/Redis Compose voice profile and validate the local
   SIP control plane without placing a call.
10. Integrate phone-number registration, flow binding, drift reconciliation,
    and provider-disabled diagnostics.
11. Integrate voice flows/component catalog/validation/publishing into the
    authenticated shell without claiming the Phase 7 canonical compiler.
12. Integrate canonical voice campaigns and CRM audiences with consent,
    idempotent claiming, retry, calling-window, and progress behavior.
13. Add calls overview/detail, contact launch action, simulator test-call,
    transcript/outcome/artifact, active state, and analytics surfaces.
14. Add structured logs, health/readiness, metrics foundations, audit events,
    threat-model updates, rate/concurrency limits, and secret redaction.
15. Run parity, migration/RLS, unit, integration, simulator E2E, Compose,
    accessibility, RTL, production-build, dependency/security, and upstream
    integrity gates; record a clean checkpoint.

## Tracked tasks

| ID     | Task                                                                | Initial status                     |
| ------ | ------------------------------------------------------------------- | ---------------------------------- |
| P5-001 | Baseline, instructions, locked-source inventory, and Phase 5 scope  | complete in preparation checkpoint |
| P5-002 | Or-on dependency/version/license compatibility gate                 | pending                            |
| P5-003 | Import `oron-common`, `oron-db`, and `oron-flows`                   | pending                            |
| P5-004 | Import/adapt tenancy, secrets, and sessions packages                | pending                            |
| P5-005 | Reconcile imported models with canonical identity/RLS/schema        | pending                            |
| P5-006 | Canonical call/contact/campaign/object/event bridge migration       | pending                            |
| P5-007 | Control API voice routes and generated TypeScript client            | pending                            |
| P5-008 | Telephony simulator and real-provider denial boundary               | pending                            |
| P5-009 | Import/adapt dispatcher and LiveKit webhook contracts               | pending                            |
| P5-010 | Import/adapt Hebrew and Pipecat voice-agent packages                | pending                            |
| P5-011 | LiveKit/SIP/Redis opt-in Compose voice profile                      | pending                            |
| P5-012 | Phone-number/DID admission and reconciliation                       | pending                            |
| P5-013 | Voice flow catalog, validation, publishing, and adapter UI          | pending                            |
| P5-014 | Canonical voice campaigns and CRM audience integration              | pending                            |
| P5-015 | Calls overview/detail and contact call action                       | pending                            |
| P5-016 | Transcript, outcome, artifacts, usage, latency, and analytics       | pending                            |
| P5-017 | Observability, audit, provider diagnostics, and security controls   | pending                            |
| P5-018 | Unit, contract, PostgreSQL, RLS, simulator, and concurrency tests   | pending                            |
| P5-019 | UI accessibility, responsive, keyboard, English/Hebrew/RTL checks   | pending                            |
| P5-020 | Provenance, parity, architecture, runbook, and threat-model updates | pending                            |
| P5-021 | Full Phase 5 verification and clean checkpoint                      | pending                            |

Each task must record its coherent commit, evidence, known limitations, and next
exact task in `docs/progress.md`.

## Required tests and acceptance evidence

### Package and architecture

- All retained packages import and build independently from `../or-on`.
- The one-way Python package graph is mechanically enforced and cycle-free.
- No target runtime dependency on Firebase, SQLite, Supabase, MongoDB, or a
  second migration authority exists.
- The current Python/Pipecat/LiveKit/native dependency set passes its explicit
  compatibility gate; any fallback is documented without rewriting the engine.
- Alembic has one head and model/schema drift checks pass for retained tables.

### PostgreSQL and security

- Call, phone-number, flow, campaign, and artifact operations run under the
  intended least-privilege role and transaction-local tenant context.
- Missing tenant context fails closed; tenant A cannot read or mutate tenant B.
- `platform_voice` cannot read unrelated messaging secrets and the web role
  cannot perform provider-side telephony operations.
- Canonical contact and campaign bridges enforce tenant-consistent foreign keys.
- Provider command/event IDs and idempotency keys prevent duplicate call starts.
- Sensitive phone values, transcript content, credentials, and provider payloads
  do not appear in ordinary logs or audit metadata.

### Simulator E2E

- From an authenticated contact page, an authorized operator starts one
  simulator call with an idempotency key.
- A duplicate request returns the same logical call and creates no second call.
- The call progresses deterministically through requested/started/answered/ended.
- A transcript, outcome, usage/latency sample, safe audit record, and durable
  events are persisted through the production contracts.
- The contact and calls pages display the resulting call once.
- A voice campaign claims each eligible fictional contact once, respects bounded
  concurrency/retries/calling windows, and reports aggregate progress.
- Hangup/cancel and simulated failure paths finalize state and release resources.
- The entire test passes with no LiveKit, carrier, STT, TTS, LLM, or real phone.

### Dispatcher, LiveKit, and agent

- Signed LiveKit webhook fixtures reject tampering and process duplicate events
  idempotently.
- Unknown/malformed/unregistered inbound DIDs are rejected before an agent or
  session is served.
- The dispatcher refuses to dial when real telephony is disabled, persistence is
  unavailable, service authentication is invalid, or the trunk is absent.
- The local voice profile proves Redis-backed SIP control-plane connectivity,
  pinned image health, non-empty ACL enforcement, and private networking without
  placing a call.
- Existing flow binding, lifecycle, cancellation, transcript, artifact,
  turn-taking, idle/hangup, usage/cost, Hebrew, and provider-adapter fixture tests
  pass after adaptation.
- Any browser-mic/LiveKit media smoke remains optional and provider-free; it is
  not evidence of carrier SIP media.

### Product shell

- Calls, call detail, phone numbers, voice campaigns, and voice flows are backed
  by real PostgreSQL/API paths rather than static mock state.
- Navigation and mutations are permission-aware, keyboard operable, responsive,
  reduced-motion safe, and no status is color-only.
- English and Hebrew direction/layout checks pass; phone numbers remain visually
  readable under RTL.
- Next.js production build and production containers pass.

### Full gate

Run the relevant package-native commands and the consolidated developer command
surface for formatting, lint, strict typing, unit/integration/PostgreSQL tests,
contracts, migrations, simulator E2E, production builds, container health,
dependency/security audits, secret/prohibited-runtime guards, source provenance,
and upstream integrity.

The final report must explicitly confirm:

- no real telephone call was placed;
- no real WhatsApp message was sent;
- no provider webhook, trunk, DID, firewall, or provider state was modified;
- no provider infrastructure was provisioned;
- no Terraform apply was run;
- `ENABLE_REAL_TELEPHONY=false` remained the default;
- all three upstream worktrees remained clean and locked;
- the target builds/runs without `../or-on`, `../wacrm`, or `../openlive`.

## Explicitly deferred

Phase 5 does not include:

- a real carrier call or purchase/configuration of a DID;
- real provider webhook/trunk/firewall provisioning;
- claiming warm SIP transfer/human handoff parity (the locked Or-on README marks
  warm transfer unimplemented even though low-level transfer code/tests exist);
- Phase 6 OpenLive Live Lab integration;
- Phase 7 cross-channel flow compiler, shared agent-version model, call-outcome
  WhatsApp automation, or complete unified activity timeline;
- replacing LiveKit, SIP, Pipecat, the Python voice system, or browser OpenLive;
- deleting historical Or-on tables, migrations, package identities, or source
  behavior before parity;
- copying or retiring the standalone Or-on console before route-by-route parity;
- GCP deployment, Terraform apply, or production readiness claims.

## Completion language

The only successful completion status is:

`PHASE 5 — TELEPHONY SIMULATOR AND PLATFORM INTEGRATION COMPLETE`

This status does not mean real carrier telephony has been activated. Real
provider smoke testing remains a separate, explicitly approved, protected
operation.
