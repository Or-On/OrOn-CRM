# Capability matrix

Legend: **Mature** = implementation plus meaningful tests/operational evidence; **Present** = implemented but narrower or less operationally proven; **Partial** = incomplete or depends on an external subsystem; **Absent** = no verified implementation; **Replace** = source implementation violates target rules but its behavior/data must be preserved.

| Capability | Or-on | WACRM | OpenLive | Phase 0 disposition |
| --- | --- | --- | --- | --- |
| Unified operator shell | Partial: focused telephony console | Mature CRM shell | Present Live Lab shell | Reuse WACRM's Next.js patterns/components as the initial unified shell; port the other experiences into bounded features. |
| Authentication | Present Firebase ID-token console auth | Mature Supabase Auth session flows | Absent user auth; optional service shared secret | **Replace all three assumptions** with one PostgreSQL-backed application identity/session system. Preserve user/account migration data and APIs, not provider auth runtimes. |
| Multi-tenancy / RBAC | Mature tenants, memberships, roles, service roles, RLS | Mature one-account-per-profile RBAC and RLS | Absent | Retain Or-on's many-to-many tenant foundation and transaction-local RLS; map WACRM accounts/profiles/roles into it. |
| Contacts | Campaign contacts only; encrypted phone fields | Mature CRM contacts, identities-by-phone, tags, custom fields, notes, CSV import/dedupe | Absent | WACRM is the functional source; normalize canonical contacts/channel identities and map Or-on campaign rows to canonical contacts. |
| Omnichannel inbox | Absent | Mature WhatsApp inbox | Chat/history UI, not CRM inbox | Retain WACRM inbox behavior and incorporate voice/OpenLive activity through a unified timeline projection. |
| WhatsApp Cloud API | Absent | Mature inbound/outbound, templates, media, reactions, status, verification | Absent | Retain WACRM adapters and tests behind durable inbox/outbox and a default-off real-send gate. |
| Pipelines/deals | Absent | Mature Kanban pipelines/stages/deals | Absent | Retain and adapt WACRM. |
| Voice campaigns | Mature campaign/contact scheduling, calling windows, retries, outcomes | Broadcast campaigns only | Absent | Retain Or-on runtime; merge audience/consent/reporting concepts with canonical campaigns. |
| WhatsApp broadcasts | Absent | Mature templates, recipients, resume, counts/status | Absent | Retain WACRM behavior; move execution to PostgreSQL jobs/worker. |
| Telephone inbound/outbound | Mature LiveKit/SIP dispatcher and Pipecat agent | Absent | No telephony; local browser conversation only | Retain Or-on service boundaries and simulators; never route OpenLive browser audio into telephony by accident. |
| SIP/DID management | Mature registration, reconciliation, trunk rules, Telnyx setup, ACL guard | Absent | Absent | Retain Or-on. Real provisioning remains opt-in and credentials external. |
| Call sessions/transcripts | Mature session lifecycle, transcript/artifacts, latency, cost, outcome | Messaging conversations only | Local chats/messages and coding-agent sessions | Create distinct specialized records with a unified activity read model; do not collapse all into one table. |
| Human handoff | Warm SIP transfer explicitly not implemented | Mature AI-to-human conversation handoff/assignment | Permission/elicitation relay, not CRM handoff | Reuse WACRM assignment semantics; implement voice handoff later against verified LiveKit behavior. |
| Flow editor | Mature React Flow telephony editor and typed component catalog | Mature automation tree builder and XYFlow graph editor | Absent | Evaluate both editors in Phase 1; expose one canonical graph while retaining runtime adapters until parity. |
| Flow runtime | Mature Pipecat flow composition and handler library | Mature messaging automation and flow runtimes | Absent | Preserve both engines behind canonical versioned graph contracts; no premature runtime rewrite. |
| Automation scheduling | Voice campaign claimer/sweeper | External cron routes, pending executions, delays, logs | Absent | Consolidate durable scheduling in PostgreSQL `SKIP LOCKED` workers. |
| Agent profile model | Per-flow/provider/voice configuration, not unified versioned agents | AI configs, reply policies, knowledge | Provider rows, pipeline config, coding-agent registry | Define one versioned agent profile and channel-specific capability adapters; import all three shapes. |
| Browser-local voice | Browser mic only for LiveKit test call; processing is server agent | No; `opus-recorder` supports messaging audio | Mature VAD/STT/end-turn/TTS/WebGPU/barge-in | Retain OpenLive thick client. |
| Browser-local vision | Absent | Absent | Mature camera/screen frames and `look` flow | Retain with explicit consent/visible capture state. |
| Voice cloning | Absent | Absent | Present ZipVoice profiles, local model and files | Retain as optional Live Lab capability; metadata/config in PostgreSQL, media/models in object storage. |
| Hebrew voice quality | Mature Hebrew G2P/niqqud, normalization, language packs, gender inference | UI translations only English/Korean | No verified Hebrew localization or speech specialization | Retain Or-on's Hebrew packages and tests; add unified Hebrew/RTL UI coverage separately. |
| AI model providers | Vertex/Gemini and OpenAI-compatible LLM; Soniox/Gemini speech | OpenAI/Anthropic reply assistant | Broad 15-provider harness plus local Ollama | Reuse OpenLive's provider-neutral text harness where contracts fit; retain Or-on speech adapters. Centralize credential references. |
| Knowledge retrieval | No canonical knowledge module | Mature full-text/pgvector knowledge documents/chunks | Web search/fetch worker and model context, not knowledge store | Retain WACRM knowledge semantics in PostgreSQL; preserve OpenLive tools as separate capabilities. |
| Public REST API | Internal FastAPI surfaces and dispatcher BFF | Mature scoped `/api/v1` | Next API routes, no public tenant API | Preserve WACRM public behaviors and formalize unified OpenAPI; generate TS clients for Python services. |
| MCP | Absent | Mature read-only-default MCP over REST | MCP project-config passthrough to coding agents | Retain both distinct uses: platform MCP server and ACP agent MCP passthrough. Apply unified auth/audit. |
| Coding-agent ACP | Absent | Absent | Mature Claude/Codex/Cursor/OpenCode/Hermes drivers | Retain OpenLive bounded live-agent service and protocol. |
| Realtime updates | LiveKit events and console polling/feeds | Supabase Realtime hooks | WebSocket live session | Replace WACRM Supabase Realtime with same-origin app event transport; retain LiveKit and versioned OpenLive WebSocket adapters. |
| API/provider key security | API key hashing, GCP Secret Manager, KMS field crypto | Hashed API keys; AES-GCM Meta/AI secrets | AES-GCM provider keys with file/env master key | Reuse audited patterns but centralize encrypted PostgreSQL credentials and external master key. |
| Media/object storage | GCS artifacts and local artifacts | Supabase public buckets | Local files, browser Cache Storage | Standardize local mounted objects/GCS. PostgreSQL owns metadata; model cache remains disposable. |
| Usage/cost | Mature call token/audio/latency/cost fields | AI usage log and dashboard metrics | Provider/agent context and cost display | Normalize usage/cost events without erasing source detail. |
| Audit trail | Operational logs; no complete canonical audit table | Some logs/webhook histories; not a complete immutable audit system | Logs/session history; no tenant audit trail | Build canonical audit records; import useful execution logs. |
| Observability | OpenTelemetry/Phoenix, health endpoints | App logs/healthcheck; dashboard analytics | Structured local logs and `/health` | Reuse Or-on OTel foundation; standardize liveness/readiness, IDs, redaction, and optional observability profile. |
| Desktop packaging | Absent | Absent | Mature Electron build/update/mini mode | Keep compiling; defer as a first acceptance gate per master prompt. |
| Local provider-safe simulation | Unit fakes; LiveKit dev stack can still provision SIP | Unit mocks but real routes are available | Provider tests/fakes, local agent CLIs | Create explicit unified telephony and WhatsApp simulators and deny real outbound operations by default. |

## Capabilities that must be retained

- Or-on: LiveKit/SIP/Pipecat call path, DID admission/reconciliation, sessions/tenancy/RLS, field protection, usage/latency/outcomes, campaign scheduler, typed flows, Hebrew voice processing, operator diagnostics.
- WACRM: contacts/inbox/pipelines/deals, templates/media/reactions, broadcasts, automations/flows, team roles/invitations, AI reply/knowledge/handoff, analytics, public API, MCP and its write guards, webhook signing/SSRF protections.
- OpenLive: on-device VAD/STT/end-turn/TTS, no-audio WebSocket contract, vision, model download/cache UX, barge-in, provider harness, ACP drivers/supervision, permission/elicitation relay, voice cloning, desktop build.

## Consolidation candidates

- One identity/tenant/membership/RBAC model: Or-on relational foundation plus WACRM user/account migration.
- One contact and channel-identity model: WACRM contacts plus Or-on campaign phone references.
- One agent profile/version model: Or-on speech/telephony config, WACRM reply/knowledge policy, OpenLive model/agent/pipeline options.
- One canonical flow graph: adapters into Or-on voice runtime and WACRM messaging runtime.
- One credential catalog: encrypted PostgreSQL records referenced by profiles and integrations.
- One activity timeline projection over specialized voice, messaging, automation, and Live Lab tables.
- One PostgreSQL job substrate for webhooks, campaigns, automation, retries, and outbox delivery.

## Experimental, obsolete, or target-incompatible areas

| Source area | Classification | Reason |
| --- | --- | --- |
| Or-on GKE deployment | Superseded for target | Target is one GCP VM with Compose, not Kubernetes/GKE. Preserve operational learning, not topology. |
| Or-on Firebase console auth | Replace | Firebase is explicitly prohibited; identity rows are reusable migration inputs. |
| Or-on warm transfer | Incomplete | README explicitly says not implemented; do not mark parity complete. |
| WACRM Supabase runtime stack | Replace | Direct conflict with PostgreSQL-only, one migration authority, same-origin BFF, and no browser DB access. |
| WACRM external cron-only deployment | Adapt | Durable jobs need an integrated worker; route semantics/logs can be retained. |
| WACRM public Supabase buckets | Replace | Target object storage rules require controlled local/GCS objects and PostgreSQL metadata. |
| OpenLive SQLite/JSON stores | Replace after import | Prohibited runtime persistence; keep only a one-time import reader. |
| OpenLive business preferences in localStorage | Split | Device-only UI/model-cache preferences may remain; agent/session/profile configuration must move to PostgreSQL. |
| OpenLive docs claiming JSON conversations | Obsolete documentation | Current `sqlite.ts` is authoritative. |
| OpenLive process-wide `uncaughtException` continuation | Harden | Continuing after unknown corruption can leave unsafe state; isolate sessions and fail/restart cleanly. |
