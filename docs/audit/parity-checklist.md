# Source parity checklist

Status values for later phases: **Unstarted**, **Mapped**, **Ported**, **Verified**, **Deferred**, **Replaced**. Phase 0 marks capabilities as Mapped only; no application code has been implemented.

## Or-on parity

| ID | Capability | Source evidence | Target treatment | Acceptance evidence | Status |
| --- | --- | --- | --- | --- | --- |
| O-01 | Self-hosted LiveKit SFU/SIP topology | `deploy/livekit`, README | Retain/adapt to VM Compose | Private digest-pinned voice profile and read-only SIP health pass; carrier smoke deferred | Verified |
| O-02 | DID registration, dispatch-rule provisioning and reconciliation | `oron-tenancy` routes/provisioner/admission | Retain | Authenticated simulator API, read-only reconciliation and catch-all/empty ACL denial pass | Verified |
| O-03 | Inbound LiveKit webhook dispatch | `oron-dispatcher/webhook.py` | Retain | Signed/tampered/replay fixtures and unknown-DID denial pass | Verified |
| O-04 | Outbound call orchestration | dispatcher `/calls` | Retain behind safe flag | Complete/no-answer/failure/cancel simulator; both real-action gates deny by default | Verified |
| O-05 | Pipecat LiveKit voice pipeline | `oron-agent` | Retain | Retained pipeline/turn/barge-in/cancellation suite and simulator transcript pass | Verified |
| O-06 | Soniox STT/TTS and Gemini TTS/provider selection | agent config/tts tests | Retain adapters | Provider fixture/contract tests; no credential CI | Mapped |
| O-07 | Vertex/Gemini and OpenAI-compatible LLM | agent LLM adapter | Retain/adapt to credential catalog | Provider adapter fixtures and timeout/cost tests | Mapped |
| O-08 | Hebrew G2P/niqqud/normalization | `oron-hebrew` | Retain | Retained Hebrew suite passes; real speech evaluation remains model/provider-gated | Verified |
| O-09 | Caller voice-gender inference | ECAPA pipeline | Retain only after license/accuracy review | Model license resolved; Hebrew telephony evaluation documented | Mapped |
| O-10 | Turn-taking, interruption, idle/hangup behavior | agent tests/modules | Retain | Retained state/timeout/barge-in tests pass | Verified |
| O-11 | Warm SIP transfer | README says not implemented | Implement later, not source parity | Explicit handoff E2E before marking verified | Deferred |
| O-12 | Tenant/user/membership model | tenancy models/migration | Retain/adapt | Auth/RBAC/RLS tests | Mapped |
| O-13 | Firebase console identity binding | Firebase Admin/auth console | Replace | Unified auth migration and no Firebase runtime dependency | Replaced |
| O-14 | Transaction-local RLS | `oron-db`, migrations/tests | Retain/extend | Cross-tenant/cross-role/fail-closed PostgreSQL tests | Mapped |
| O-15 | Hashed tenant API keys | tenancy | Retain/adapt | Plaintext-once, hash, scope/revocation tests | Mapped |
| O-16 | Sessions/transcripts/artifacts | sessions models/API | Retain and normalize voice model | Canonical call/detail/contact simulator paths persist ordered transcript and object metadata | Verified |
| O-17 | Encrypted phone fields/blind indexes | sessions/campaign migrations | Retain/adapt | Round-trip, key rotation, lookup and redaction tests | Mapped |
| O-18 | Usage, cost and latency | session fields/observers | Retain | Usage and provider-latency event persistence plus call/detail metrics pass | Verified |
| O-19 | Outcomes/answer/no-answer states | later Alembic revisions | Retain | Completed/no-answer/failed/cancelled simulator lifecycle tests pass | Verified |
| O-20 | Voice campaigns/calling windows/retries | campaigns package/migrations | Retain/adapt | Explicit consent, IANA window, bounds and per-contact idempotency pass | Verified |
| O-21 | Flow composition/components/runtime | `oron-flows`, agent bindings | Retain behind canonical adapter | Typed catalog, validation, immutable publish and retained fixtures pass; Phase 7 compiler deferred | Verified |
| O-22 | Telephony flow editor | `apps/console` | Port behavior into unified Flow Studio | Unified JSON author/validate/publish adapter is keyboard operable; visual graph compiler deferred | Verified |
| O-23 | Console calls/sessions/campaign diagnostics | `apps/console` | Port into unified voice features | Unified calls/detail/DID/campaign diagnostics render responsively in English/Hebrew direction | Verified |
| O-24 | GCP Secret Manager/KMS/GCS | secrets/session/deploy code | Retain/adapt | Local/GCP config tests, encrypted secret/object path | Mapped |
| O-25 | OTel/Phoenix tracing | agent/deploy | Retain/standardize | Trace IDs/redaction/optional profile | Mapped |
| O-26 | GKE deployment | deploy docs/scripts | Replace with one-VM Compose | VM deployment/rollback passes | Replaced |

## WACRM parity

| ID | Capability | Source evidence | Target treatment | Acceptance evidence | Status |
| --- | --- | --- | --- | --- | --- |
| W-01 | Login/signup/reset/session UI | auth routes/hooks | Replace provider, retain UX requirements | Unified login/session/rotation/revocation E2E | Mapped |
| W-02 | Team accounts, roles, invitations, ownership transfer | migrations 017-020, account routes/UI | Retain/adapt to tenant memberships | RBAC/invite/transfer tests and migration report | Mapped |
| W-03 | Profile/password/avatar/global sign-out | settings/auth | Retain behaviors; object/auth adapters replaced | Settings and session-revocation E2E | Mapped |
| W-04 | Shared WhatsApp inbox | inbox pages/components | Retain | Inbound simulator -> inbox -> assignment/reply/status E2E | Mapped |
| W-05 | Conversation assignment/status/unread | schema/hooks/components | Retain; replace Realtime | Same-origin live update and handoff tests | Mapped |
| W-06 | Contact profile/tags/custom fields/notes | CRM schema/UI | Retain | CRUD/import/dedupe/timeline E2E | Mapped |
| W-07 | CSV contact import | import code/tests | Retain/adapt | PII-free import validation/idempotency tests | Mapped |
| W-08 | Pipelines/stages/Kanban deals | pipeline code/schema | Retain | Drag/drop/order/currency/automation E2E | Mapped |
| W-09 | Meta webhook verification/signature | webhook route/tests | Retain/harden | Raw-body signature/replay/dedup fixtures | Mapped |
| W-10 | Inbound text/media/status | webhook/media code | Retain | Simulator fixtures, object retention and status E2E | Mapped |
| W-11 | Outbound text/template/media | send/meta code | Retain behind safe flag | Simulator E2E; live adapter denied by default | Mapped |
| W-12 | Message reply/reaction/interactive/quick replies | migrations/code/tests | Retain | UI/provider contract fixtures | Mapped |
| W-13 | Message templates lifecycle and sync | template routes/libs | Retain | Create/validate/sync/status fixture tests | Mapped |
| W-14 | WhatsApp registration/config diagnostics | config routes/UI | Retain with credential refs | Config/verification simulator and redaction tests | Mapped |
| W-15 | Broadcast audience/personalization/schedule | broadcasts UI/libs | Retain/adapt | Consent, template variable, schedule E2E | Mapped |
| W-16 | Broadcast recipient status/count/resume | migrations 003/005/037/038 | Retain on durable jobs | Crash/resume/idempotency/concurrency tests | Mapped |
| W-17 | Automation triggers/actions/conditions/waits | automation builder/engine | Retain via canonical graph adapter | Source fixtures plus cross-channel workflow E2E | Mapped |
| W-18 | Messaging flow graph/editor/runtime | flows modules/components | Retain via canonical graph adapter | Publish/version/run/trace parity | Mapped |
| W-19 | AI reply draft/playground | AI routes/libs | Retain/adapt to agent profile | Provider fixtures and permission/usage tests | Mapped |
| W-20 | AI auto-reply caps/human handoff | AI migrations/libs | Retain | Cap, escalation, ownership and audit E2E | Mapped |
| W-21 | Knowledge FTS/pgvector | migrations 030-032 | Retain/adapt | FTS and optional semantic retrieval PostgreSQL tests | Mapped |
| W-22 | AI usage logs | migration 033/routes | Retain/normalize | Usage/cost analytics tests | Mapped |
| W-23 | Dashboard analytics/activity | dashboard code | Retain/rebuild over canonical queries | Metric parity fixtures and live activity view | Mapped |
| W-24 | Notifications/presence | migrations/hooks/UI | Retain behavior; replace Supabase Realtime | Live update/presence expiry tests | Mapped |
| W-25 | Scoped public REST API | `/api/v1`, docs | Retain/formalize OpenAPI | Compatibility/scopes/pagination/error tests | Mapped |
| W-26 | Hashed API keys | migration 026/libs/UI | Retain/canonicalize | Plaintext-once, scope, revoke, audit tests | Mapped |
| W-27 | Outbound webhook endpoints/signing/SSRF | migration 028/libs | Retain on durable jobs | Signature/retry/SSRF/DNS-rebind fixtures | Mapped |
| W-28 | MCP read tools | MCP server | Retain | MCP contract over unified API | Mapped |
| W-29 | MCP opt-in writes/broadcast confirmation | MCP server safety model | Retain and strengthen with platform flags | Tool registration/scope/confirmation tests | Mapped |
| W-30 | English/Korean locale catalogs | `messages` | Retain selectively; add Hebrew | Locale build and RTL UI tests | Mapped |
| W-31 | Supabase Auth/SSR/JS/PostgREST | package/code | Replace | Dependency absent from runtime graph | Replaced |
| W-32 | Supabase Realtime | hooks | Replace | Unified authenticated event transport passes parity | Replaced |
| W-33 | Supabase Storage buckets | migrations/storage code | Replace | Local/GCS object adapter with metadata/ACL/retention | Replaced |
| W-34 | Supabase migration runner | workflow/migrations | Replace with Alembic | One-head and upgrade tests | Replaced |
| W-35 | Docker standalone build | Dockerfile/Compose | Retain concept in unified images | Non-root production build and health test | Mapped |

## OpenLive parity

| ID | Capability | Source evidence | Target treatment | Acceptance evidence | Status |
| --- | --- | --- | --- | --- | --- |
| L-01 | Browser-local Silero VAD | web live engine | Retain | Permission/VAD state and manual hardware smoke | Mapped |
| L-02 | Browser-local Whisper STT | model worker/engine | Retain | Model load/progress/fallback and transcript tests | Mapped |
| L-03 | Smart-Turn end-of-turn | web live model code | Retain | Pause/mid-thought/end-turn fixture tests | Mapped |
| L-04 | Kokoro TTS | web live code | Retain | Model lifecycle/voice/speed/barge-in tests | Mapped |
| L-05 | Supertonic TTS | web live code | Retain subject to license | License resolved; model/load/audio tests | Mapped |
| L-06 | Voice cloning with ZipVoice | agent voice routes/engine/UI | Retain optional | Consent, install/delete/profile/object and latency tests | Mapped |
| L-07 | Barge-in/cancel/spoken-prefix persistence | live engine/protocol/session | Retain | Ordering/cancel/persist-only-spoken tests | Mapped |
| L-08 | Camera/screen vision frames | protocol/UI/turn runner | Retain | Explicit consent/indicator/frame ordering tests | Mapped |
| L-09 | No raw audio sent to server | architecture/protocol | Retain invariant | Contract/network test rejects audio payloads | Mapped |
| L-10 | `/live` typed WebSocket protocol | shared live events/ws | Retain/version | JSON Schema/Zod compatibility and reconnect tests | Mapped |
| L-11 | Provider brain/harness | harness/registry/turn runner | Retain/adapt | Provider dialect fixtures and credential isolation | Mapped |
| L-12 | Local Ollama support | provider registry | Retain optional | Keyless/local adapter test | Mapped |
| L-13 | Exa/fetch worker tools | agent tools | Retain with security controls | SSRF/tool permission/timeouts/audit tests | Mapped |
| L-14 | Claude Code ACP | agent registry/driver | Retain | Session/resume/permission/model option fixtures | Mapped |
| L-15 | Codex ACP | agent registry/driver | Retain | Same, with best-effort resume accurately shown | Mapped |
| L-16 | Cursor ACP | agent registry/driver | Retain | Non-persistent resume limitation displayed/tested | Mapped |
| L-17 | OpenCode/Hermes ACP | agent registry/driver | Retain | Install/auth/session discovery and no-store-write tests | Mapped |
| L-18 | ACP permission/elicitation relay | protocol/supervisor/UI | Retain | Voice/tap approval, expiry/deny/cancel tests | Mapped |
| L-19 | Agent supervision/watchdogs/restart | supervisor | Retain/harden | Start/first-output/stall/crash tests | Mapped |
| L-20 | MCP config passthrough | agent registry/driver | Retain | Native vs passthrough policy tests | Mapped |
| L-21 | Chat/history/export | web API/UI/db | Retain; PostgreSQL persistence | Create/resume/order/export/delete auth E2E | Mapped |
| L-22 | External agent history discovery | history parsers | Retain read-only where safe | Bounded parsing/dedupe/path privacy tests | Mapped |
| L-23 | Provider settings/API-key protection | db/API/UI | Retain behavior; replace store | Tenant-scoped encrypted credential records and redaction | Mapped |
| L-24 | Pipeline configuration | localStorage/settings UI | Retain; move authority to profiles/settings | Save/version/select across devices through PostgreSQL | Mapped |
| L-25 | Voice profile import/export/preview | voice UI/routes/files | Retain | Object ownership, checksum, import/export/delete tests | Mapped |
| L-26 | Desktop tray/mini mode/notifications | Electron app | Retain after web-first gate | macOS/Windows/Linux compile and manual UX smoke | Deferred |
| L-27 | Auto-update/release packaging | release workflow/Electron | Retain later | Signed/unsigned policy and update smoke | Deferred |
| L-28 | SQLite chats/messages | db package | Replace after import | Legacy importer validation; no runtime SQLite dep | Replaced |
| L-29 | JSON providers/settings/voice metadata | db package | Replace after import | JSON importer validation; no runtime file DB | Replaced |
| L-30 | Browser business state in localStorage | live hooks/config | Replace authority; retain cache/UI prefs | Server-backed configuration and denylist audit | Replaced |
| L-31 | Optional shared-secret-only service auth | server/ws | Replace | User/tenant-authenticated HTTP/WS tests | Replaced |

## Cross-channel target acceptance

| ID | Workflow | Required source behaviors | Status |
| --- | --- | --- | --- |
| X-01 | WhatsApp inbound to live inbox | W-04, W-09, W-10, W-24 | Unstarted |
| X-02 | Human WhatsApp reply through simulator | W-04, W-11, W-13 | Unstarted |
| X-03 | Contact -> outbound simulated call -> transcript/outcome timeline | O-04, O-05, O-16, O-19, W-06 | Unstarted |
| X-04 | Call outcome -> automation -> simulated WhatsApp follow-up | O-19, W-11, W-17 | Unstarted |
| X-05 | WhatsApp/CRM event -> scheduled simulated call | W-04, W-06, W-17, O-04 | Unstarted |
| X-06 | Live Lab configuration -> immutable shared agent version | L-01-L-24, canonical agent model | Unstarted |
| X-07 | One flow graph -> voice and messaging runtimes | O-21/O-22, W-17/W-18 | Unstarted |
| X-08 | Human handoff with context/audit | W-05/W-20 and future O-11 | Unstarted |
| X-09 | Tenant isolation across CRM, messaging, voice, Live Lab and jobs | O-14 plus translated WACRM/OpenLive models | Unstarted |
| X-10 | English and Hebrew/RTL keyboard-accessible core routes | Or-on Hebrew behavior, WACRM shell, OpenLive Live Lab | Unstarted |

No source entry may be deleted merely because it is Mapped, Ported, Replaced, or Deferred. Deletion requires the acceptance evidence to be linked and status changed to Verified (or an explicit approved defer/removal rationale).
