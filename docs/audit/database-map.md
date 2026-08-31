# Database and migration map

## Current persistence topology

| Source | Authoritative stores today | Migration mechanism | Target status |
| --- | --- | --- | --- |
| Or-on | PostgreSQL; local/GCS artifacts; some browser console drafts/preferences | Root Alembic | Preserve Alembic history and PostgreSQL model. Review browser draft authority. |
| WACRM | Supabase PostgreSQL, Auth, Realtime, Storage; minor UI localStorage | 39 ordered Supabase SQL files | Convert required schema/data behavior to Alembic; remove Supabase runtimes. |
| OpenLive | SQLite chats/messages; JSON provider/settings/voice metadata; files/models/wav; browser localStorage/Cache Storage; external agent session stores | Runtime DDL plus a JSON-to-SQLite importer | Model authoritative state in PostgreSQL; keep isolated one-time import readers; files/models remain object/cache data. |

## Or-on migration authority

Static graph inspection found 22 revisions, one base, one merge revision, and one head.

```text
0001 sessions
 -> 0002 multitenancy
 -> 0003 phone dispatch rule
 -> 0004 caller-number encryption/backfill
 -> 0005 session usage
 -> 0006 session flow_id
 -> 0007 flows table + RLS
 -> 0008 browser direction
 -> 0009 cached prompt tokens
 -> 0010 session latency
 -> 0011 split application roles
 -> 8eda5976c920 drop response_latency
 -> branch A: 46a2cce29f18 campaigns/campaign_contacts
              -> 7433e45e0d29 answer/no-answer/retry scheduling
              -> f596c72044b0 calling window + claim index
              -> c80d93f1c8be session outcome
              -> 3b4a1c5307b4 to-number blind index
              -> ea9aef9b2d14 campaign_contact session index
              -> 0e01a2f68295 per-weekday calling hours
 -> branch B: b38ef3c19979 session STT audio seconds
 -> 8aa960fd77ec merge + campaign/STT audio seconds
 -> a41d2f6c2925 users, identities, memberships (HEAD)
```

Do not copy the early hand-assigned numeric pattern for new revisions. The source explicitly requires generated Alembic IDs.

### Or-on tables at the locked revision

| Table | Purpose and key fields | Tenant / security notes |
| --- | --- | --- |
| `tenants` | UUID tenant, name, unique slug, status, timestamps | Control-plane table. |
| `users` | UUID, case-insensitive email, status, superuser flag | Uses `citext`; tenancy service role only. |
| `user_identities` | User-to-Firebase UID binding | Provider-specific legacy identity; replace Firebase runtime but preserve migration identity. |
| `memberships` | `(user_id, tenant_id)` key, role | Canonical many-to-many seed; lacks full permission model/versioning. |
| `phone_numbers` | Tenant DID, E.164 unique, LiveKit dispatch rule and flow binding | Tenant-owned; SIP provisioning invariants. |
| `api_keys` | Tenant, hashed key, label/timestamps | Plaintext is not stored. |
| `sessions` | Tenant/call IDs, provider/room, direction, encrypted caller/callee with blind indexes, flow, timestamps, transcript/artifacts/usage/latency/outcome fields | Forced RLS via `app.current_tenant`; sessions runtime role. |
| `flows` | Tenant, flow UUID/version/language/name/source JSON, timestamps | Forced RLS; source graph is flexible structured data. |
| `campaigns` | Tenant, flow, state/schedule/calling hours/retry policy, counts/timestamps | Forced RLS; voice-specific execution policy. |
| `campaign_contacts` | Tenant/campaign, protected phone, status/attempts/scheduling/session/outcome | Forced RLS; indexed claim path for workers. |

Migration `0011` creates/grants separate `oron_sessions_app` and `oron_tenancy_app` runtime roles. The test harness injects per-worker role names and tests cross-role denial.

## WACRM PostgreSQL/Supabase schema

The checked-in history contains migrations `001` through `039` with no gaps. They are SQL migration files, not Alembic revisions, and must not remain an active second migration runner.

### Verified table groups

| Domain | Tables | Important behavior |
| --- | --- | --- |
| Identity/tenant | `profiles`, `accounts`, `account_invitations`, `member_presence` | Supabase `auth.users`; one account per profile; owner/admin/agent/viewer; invitation RPCs; presence/Realtime. |
| CRM | `contacts`, `tags`, `contact_tags`, `custom_fields`, `contact_custom_values`, `contact_notes` | Phone normalization/dedup, tag filters, imports, account scope. |
| Messaging | `conversations`, `messages`, `message_reactions`, `quick_replies`, `notifications` | Assignment/unread/status, reply links, interactive payloads, AI flags/handoff, media metadata. |
| WhatsApp configuration | `whatsapp_config`, `message_templates` | Encrypted tokens/config, phone-number uniqueness and registration state, Meta template lifecycle/media. |
| Sales | `pipelines`, `pipeline_stages`, `deals` | Ordered stages, assignment, values/currency/status. |
| Broadcasts | `broadcasts`, `broadcast_recipients` | Recipient WAMIDs/status, incremental aggregates, template params, delivery lock/resume. |
| Automations | `automations`, `automation_steps`, `automation_logs`, `automation_pending_executions` | Trigger/action trees, logs, delayed work, execution counters. |
| Flows | `flows`, `flow_nodes`, `flow_runs`, `flow_run_events` | Graph runtime, active-run uniqueness, execution trace/events. |
| API/integration | `api_keys`, `webhook_endpoints` | Hashed scoped API keys; signed outbound webhook state/failure tracking. |
| AI | `ai_configs`, `ai_knowledge_documents`, `ai_knowledge_chunks`, `ai_usage_log` | Encrypted provider/embedding keys, FTS/vector retrieval, reply caps/handoff and usage. |

### Supabase-specific dependencies to translate

- `auth.users`, `auth.uid()`, `authenticated`, `service_role`, JWT-derived RLS context.
- Supabase Storage `storage.buckets`/`storage.objects`: `avatars`, `flow-media`, `chat-media`.
- Supabase Realtime clients for inbox, unread counts, notifications, presence, and broadcast progress.
- PostgREST/client RPC calls and direct browser `.from(...)` queries.
- Supabase CLI as migration runner and schema verifier.

Extensions: `uuid-ossp` and `vector`. Functions include membership/RBAC helpers, invitation/member/ownership RPCs, contact/conversation dedupe, broadcast count/resume functions, tag filters, AI knowledge matching, presence touch, webhook failure tracking, and updated-at/notification triggers.

### WACRM migration conversion groups

| Alembic conversion group | Source migrations | Notes |
| --- | --- | --- |
| CRM/messaging baseline | 001-005 | Replace `auth.users` references and initial per-user RLS with canonical identity from the outset in the integrated upgrade path. Preserve data-import compatibility. |
| Automations and message actions | 006-009 | Convert tables/functions/triggers; delayed execution becomes worker jobs. |
| Flow engine | 010-016 | Preserve graph/run behavior; media objects move to target object store. |
| Accounts/RBAC | 017-022 | Map accounts/profiles to tenants/users/memberships; preserve invitations and role semantics. |
| Media/presence/API/notifications | 023-028 | Replace Storage/Realtime; retain business metadata, scoped API keys, webhook endpoints. |
| AI/knowledge | 029-034 | Retain FTS; pgvector only if extension is enabled and testable; credential columns become references. |
| Interactive/reliability | 035-039 | Preserve quick replies, dedupe, webhook/broadcast resume, inbound media metadata. |

## OpenLive current data model

### SQLite

`packages/db/src/sqlite.ts` creates the database on first use; there is no versioned migration history beyond a `meta` marker.

| Table | Columns / behavior | Target mapping |
| --- | --- | --- |
| `meta` | string key/value; contains `migrated_json` marker | Import ledger/checkpoint tables, not generic runtime settings. |
| `chats` | `id`, title, timestamps, coding `agent_id`, `cwd`, external `agent_session_id` | Tenant/user-scoped Live Lab session plus external agent-session link. Treat `cwd` as sensitive local configuration. |
| `messages` | autoincrement `seq`, unique ID, chat FK cascade, role, JSON blocks, live flag, timestamp | Canonical Live Lab messages with stable ordering and JSONB content blocks. |

SQLite uses WAL, foreign keys, a five-second busy timeout, and two local processes. These concurrency mechanisms are not a target design; PostgreSQL transactions replace them.

### JSON and files

| Store | Current contents | Target mapping |
| --- | --- | --- |
| `providers.json` | Provider ID/name/kind, encrypted API key, last four, default flag | Tenant-scoped provider config plus encrypted credential reference. |
| `settings.json` | Arbitrary string key/value, including instructions/tool settings | Typed user/tenant settings tables; no filesystem persistence. |
| `voice-profiles.json` | Name, transcript, wav filename, duration, timestamp | Voice profile/version metadata in PostgreSQL; wav object in local/GCS storage. |
| `data/.enc-key` | Auto-generated AES-256-GCM master key when env key absent | External local secret file/Secret Manager, versioned key references; never DB. |
| `data/voices/*` | Voice reference wavs | Object storage with ownership, checksums, retention metadata in PostgreSQL. |
| `data/models/*` and browser Cache Storage | Downloaded model artifacts | Disposable model cache/object artifacts, never business rows or PostgreSQL blobs. |
| External agent histories | Claude/Codex JSONL, Cursor metadata, OpenCode/Hermes SQLite | Read-only connectors; do not import blindly or make them platform truth. |

### Browser persistence classification

| Current localStorage class | Target classification |
| --- | --- |
| Theme, panel sizes, tours, disclosure state, hotkey, debug flag | Non-authoritative device preferences; may remain local. |
| Pipeline VAD/STT/end-turn/TTS choices | Agent/profile or user Live Lab configuration; persist through PostgreSQL API, optionally cache locally. |
| Per-chat agent, working directory, resume session ID | Authoritative session binding/sensitive config; persist server-side with tenant/user authorization. |
| Per-agent model/mode/options | Profile/user configuration; persist server-side, local cache optional. |
| Model-ready flags and binary Cache Storage | Disposable performance cache; may remain browser-local. |

## Canonical target mapping

| Target domain | Primary source | Other inputs | Key migration issue |
| --- | --- | --- | --- |
| Identity/tenancy | Or-on users/tenants/memberships | WACRM accounts/profiles/invitations | External auth IDs, one-account constraint, role vocabulary, RLS translation. |
| CRM | WACRM | Or-on campaign contacts/sessions | Protected phone normalization, consent/opt-out, explicit source ID maps. |
| Messaging | WACRM | OpenLive message blocks remain separate Live Lab subtype | Provider IDs/status dedup, media objects, handoff/assignment. |
| Voice | Or-on sessions/campaigns | OpenLive local sessions are not calls | Split call/leg/room/transcript/recording/outcome while preserving legacy session IDs. |
| Agents | New canonical profile/version | All three config shapes | Immutable versions, typed channel caps, credential references. |
| Automations/flows | New canonical graph/version/run | Or-on voice and WACRM automation/flow engines | Avoid double definitions; preserve runtime-specific trace data. |
| Platform jobs/events | New PostgreSQL inbox/outbox/jobs | WACRM reliability functions and Or-on campaign claiming | Idempotency, retry/DLQ, SKIP LOCKED and trace IDs. |
| Objects | New metadata | Or-on artifacts, WACRM media, OpenLive voice/model files | Do not store large binaries in PostgreSQL. |

## Import requirements

- Import ledgers must record source repository, source database/file checksum, source ID, target ID, status, timestamps, and error.
- WACRM import should accept an existing PostgreSQL/Supabase dump without requiring live Supabase services.
- OpenLive importer may read SQLite and JSON only in the import utility dependency graph. It must support dry-run, resume, idempotency, transactions, checksum checks, row counts, and referential validation.
- Preserve timestamps and provider identifiers where valid; never reuse unverified tenant ownership.
- Migration CI must assert exactly one Alembic head and test clean installs plus upgrades from the prior integrated fixture.
