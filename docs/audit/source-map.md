# Source provenance and reuse map

This map is a plan for preserving provenance when code is copied into the target.
No source code was copied during Phase 0. Phase 1 foundation code, contracts,
configuration, UI, containers, migrations, and documentation were authored in the
target; no upstream business artifact was copied or adapted, so no Phase 1 source
mapping row is required.

## Provenance rules

1. `source-lock.json` is the immutable Phase 0 source snapshot.
2. Preserve source commit SHAs in import commits and in file/package notices where practical.
3. WACRM and OpenLive copies or substantial derivatives retain their MIT notices in `THIRD_PARTY_NOTICES.md` and appropriate package/file headers.
4. Or-on remains private/proprietary target code. Do not add a public license to it or to the target without owner instruction.
5. No finished runtime dependency on sibling repositories, Git submodules, Supabase projects, SQLite stores, or external Obsidian vaults.
6. Prefer history-preserving subtree/filter-repo import when it is low risk, but do not let history tooling block functional integration.

## Planned Or-on reuse

| Upstream source | Verified capability | Tentative target | Action |
| --- | --- | --- | --- |
| `../or-on/alembic` | Sole working PostgreSQL history, RLS and role grants | `db/alembic` | Preserve every valid revision exactly, then continue with generated revisions. |
| `../or-on/packages/oron-db` | SQLModel bases, async engine, RLS session helper, roles | `packages/py/oron-db` | Retain/adapt; make it the PostgreSQL foundation. |
| `../or-on/packages/oron-common` | Call context, phone and usage primitives | `packages/py/oron-common` | Retain narrowly; avoid turning it into a dumping ground. |
| `../or-on/packages/oron-tenancy` | Tenants, users, identities, memberships, API keys, DID admission | `packages/py/oron-tenancy` and control API | Retain core and replace Firebase-specific identity adapter. |
| `../or-on/packages/oron-sessions` | Sessions, campaigns, artifacts, encryption, usage/outcomes | `packages/py/oron-sessions` plus control API | Retain and migrate toward canonical voice/campaign contracts. |
| `../or-on/packages/oron-flows` | Typed graph/composition/component runtime | `packages/py/oron-flows` | Retain runtime; add compiler/adapter from canonical graph. |
| `../or-on/packages/oron-hebrew` | Hebrew G2P, normalization, niqqud, gender pipeline | `packages/py/oron-hebrew` | Retain as bounded ML package; resolve model/code license notices. |
| `../or-on/packages/oron-agent` | Pipecat/LiveKit voice worker | `services/py/voice-agent` | Retain mature pipeline and provider adapters; default to simulated calls in tests. |
| `../or-on/packages/oron-dispatcher` | LiveKit webhook, outbound orchestration, admin facade | `services/py/dispatcher` | Retain orchestration; remove Firebase/admin UI coupling and add target contracts. |
| `../or-on/apps/console` | Flow editor, campaigns/calls/sessions diagnostic UX | Unified web feature modules / parity reference | Port behavior/components selectively; retire only after parity. |
| `../or-on/deploy/livekit` | LiveKit/SIP/Redis/Caddy operational knowledge | `infra/compose`, `infra/caddy`, runbooks | Adapt from GKE/current Compose to one-VM private networks; pin images. |
| `../or-on/deploy/postgres` | Local PostgreSQL setup | `infra/compose` | Adapt to unified database and roles. |
| `../or-on/.github/workflows/ci.yml` | Python/PostgreSQL/console gates | Root workflows | Consolidate; preserve migration/RLS/role checks. |

Do not import: Firebase runtime dependency, GKE topology as target architecture, real customer/PII fixtures, or external Obsidian workflow dependency.

## Planned WACRM reuse

| Upstream source | Verified capability | Tentative target | Action |
| --- | --- | --- | --- |
| `../wacrm/src/app/(dashboard)` | CRM/inbox/pipeline/broadcast/automation/settings screens | `apps/web` bounded features | Port with current behavior tests; replace direct Supabase reads with BFF/API client. |
| `../wacrm/src/components` | CRM, inbox, flow, automation, pipeline, settings, charts/UI | `packages/ts/ui` and web features | Reuse selectively; retain attribution for Tremor-derived files and other copied code. |
| `../wacrm/src/app/api/whatsapp` | Meta webhook/config/send/template/media/broadcast behavior | Webhook entrypoint and `services/ts/messaging-worker` | Adapt to durable PostgreSQL inbox/outbox, object storage, simulators, default-off real send. |
| `../wacrm/src/lib/whatsapp` | Encryption, Meta client, templates, media, dedupe/reliability helpers | Messaging provider adapter package | Retain verified protocol logic; centralize credentials and runtime validation. |
| `../wacrm/src/lib/automations` | Trigger/action engine, validation, pending execution | Automation module and messaging worker | Adapt to canonical graph/jobs; retain semantics and tests. |
| `../wacrm/src/lib/flows` and flow components | Graph editor/runtime/validation | Unified Flow Studio and messaging adapter | Evaluate as visual editor base; compile canonical graph to retained engine. |
| `../wacrm/src/lib/ai` | Reply drafting/auto-reply, knowledge, retrieval, handoff, usage | Agents/knowledge modules | Adapt to canonical agent versions, pgvector/FTS, credential refs and audit. |
| `../wacrm/src/lib/api-keys`, `src/lib/api/v1`, `src/app/api/v1` | Scoped API-key REST API | Unified BFF/public API | Preserve behavior and scopes; formalize OpenAPI/error envelope. |
| `../wacrm/src/lib/webhooks` | Outbound webhook signing, delivery and SSRF checks | Platform integrations module | Retain controls; move retries to durable jobs. |
| `../wacrm/mcp-server` | Safe MCP facade | `services/ts` or `packages/ts` MCP entrypoint | Retain read-only default, scope enforcement, and explicit broadcast confirmation. |
| `../wacrm/supabase/migrations` | PostgreSQL schema/RLS/functions/data history | `db/alembic` conversion evidence | Translate selected behavior to ordered generated Alembic revisions. Do not keep runner. |
| `../wacrm/messages` | English/Korean locale catalogs | Unified i18n seed | Retain relevant English strings; Korean may remain supported/deferred explicitly; add Hebrew/RTL. |
| `../wacrm/.github/workflows` | App and migration gates | Root workflows | Consolidate without Supabase CLI runtime dependency. |

Do not import as runtime: Supabase Auth/SSR/JS clients, Realtime, Storage, PostgREST assumptions, external Supabase database, or Hostinger-specific deployment topology.

## Planned OpenLive reuse

| Upstream source | Verified capability | Tentative target | Action |
| --- | --- | --- | --- |
| `../openlive/apps/web/src/lib/live` | VAD/STT/end-turn/TTS, model lifecycle, barge-in, WebSocket client | `packages/ts/openlive-audio` and Live Lab feature | Retain browser-local pipeline; separate authoritative config from device cache. |
| `../openlive/apps/web/src/components/live` | Lobby, in-call, camera, transcript, permission/agent UI | Unified `apps/web` Live Lab | Port into unified shell/auth/design system. |
| `../openlive/packages/shared` | Zod wire protocol and coding-agent registry | `packages/ts/openlive-shared` / contracts | Retain as protocol seed; add schema versioning and authenticated tenant context. |
| `../openlive/packages/harness` | Provider-neutral model adapters | `packages/ts/openlive-harness` or provider package | Retain; centralize credentials and server-side policy. |
| `../openlive/services/agent` | Hono `/live`, ACP drivers, supervision, tools, voice cloning | `services/ts/live-agent` | Retain bounded lifecycle; replace local persistence and service auth. |
| `../openlive/apps/web/src/app/api` | Chats/providers/models/settings/history/agents/workspace/voice proxies | Unified BFF adapters | Port behavior selectively; all authoritative access becomes PostgreSQL/tenant-aware. |
| `../openlive/packages/db` | Legacy SQLite/JSON layouts, encryption and migration knowledge | `db/importers/openlive` only | Do not include SQLite/file store in normal runtime. Reuse parsers only in one-time importer. |
| `../openlive/apps/desktop` | Electron wrapper, tray/mini mode/update/permissions | `apps/desktop` optional | Keep compiling; integrate after web acceptance gate. |
| `../openlive/.github/workflows` | Cross-platform tests and packaging | Root workflows | Preserve type/test/desktop compile coverage. |
| `../openlive/assets`, agent icons and model references | Product/media assets | Design/notice review | Reuse only after license/provenance review. |

Do not import as runtime: SQLite state, JSON business stores, auto-generated file master key as deployment secret strategy, or unauthenticated loopback-only assumptions for the server deployment.

## Cross-source canonical ownership

| Canonical concern | Owner / authority | Retained adapters |
| --- | --- | --- |
| PostgreSQL schema/migrations | Or-on Alembic lineage extended in target | WACRM migration conversions; OpenLive importers. |
| Identity/tenancy/RLS | Target model based on Or-on relational/RLS foundation | WACRM account import; external identity records. |
| CRM/messaging/pipelines | WACRM behavior and UI as primary reference | WhatsApp provider adapter; voice activity links. |
| Telephony/voice campaigns | Or-on services/runtime as primary reference | Canonical contacts/campaigns/agents/flows. |
| Live Lab/local media | OpenLive web/agent as primary reference | Canonical auth, agent versions and persistence. |
| Flow graph | New target contract | Or-on voice compiler/runtime; WACRM messaging compiler/runtime. |
| Agent profiles | New target model | Config adapters from all three. |
| Public application shell | WACRM Next foundation adapted to new design | Or-on diagnostics and OpenLive Live Lab modules. |

## Evidence path convention

Audit documents use source paths such as `../or-on/...` relative to the target repository root. After integration, a provenance manifest should map each copied target path to source repository, locked SHA, source path, transformation method, and applicable notices.

## Phase 2A imported Or-on migration artifacts

Locked source SHA for every row:
`cece174f4d590a1b8a283d539dd66e08cc689aa9`. Or-on has no repository license
file and is treated as private/proprietary project code. No public license is
inferred.

| Source path | Target path | Status | Reason / exact adaptation |
| --- | --- | --- | --- |
| `alembic/versions/0001_create_sessions.py` | `db/alembic/versions/0001_create_sessions.py` | copied | Preserve historical root and SQL semantics. |
| `alembic/versions/0002_multitenancy.py` | `db/alembic/versions/0002_multitenancy.py` | copied | Preserve tenancy, role, RLS, and seed lineage. |
| `alembic/versions/0003_phone_dispatch_rule.py` | `db/alembic/versions/0003_phone_dispatch_rule.py` | copied | Preserve historical schema change. |
| `alembic/versions/0004_backfill_caller_number_encryption.py` | `db/alembic/versions/0004_backfill_caller_number_encryption.py` | adapted | Live behavior unchanged; after emitting schema SQL, offline mode skips the row-reading encryption backfill that Alembic's mock connection cannot execute. |
| `alembic/versions/0005_session_usage.py` | `db/alembic/versions/0005_session_usage.py` | copied | Preserve usage lineage. |
| `alembic/versions/0006_flow_id.py` | `db/alembic/versions/0006_flow_id.py` | copied | Preserve flow relationship. |
| `alembic/versions/0007_flows_table.py` | `db/alembic/versions/0007_flows_table.py` | copied | Preserve flow/RLS behavior. |
| `alembic/versions/0008_browser_direction.py` | `db/alembic/versions/0008_browser_direction.py` | copied | Preserve call direction behavior. |
| `alembic/versions/0009_cached_prompt_tokens.py` | `db/alembic/versions/0009_cached_prompt_tokens.py` | copied | Preserve usage field. |
| `alembic/versions/0010_session_latency.py` | `db/alembic/versions/0010_session_latency.py` | copied | Preserve historical upgrade/downgrade. |
| `alembic/versions/0011_split_app_roles.py` | `db/alembic/versions/0011_split_app_roles.py` | adapted | Import path points to target-local compatibility enum with identical role string values; SQL unchanged. |
| `alembic/versions/8eda5976c920_drop_session_response_latency.py` | `db/alembic/versions/8eda5976c920_drop_session_response_latency.py` | copied | Preserve branch ancestor. |
| `alembic/versions/46a2cce29f18_campaigns_and_campaign_contacts.py` | `db/alembic/versions/46a2cce29f18_campaigns_and_campaign_contacts.py` | adapted | Import path points to target-local identical role values; SQL unchanged. |
| `alembic/versions/7433e45e0d29_answered_no_answer_and_retry_scheduling.py` | `db/alembic/versions/7433e45e0d29_answered_no_answer_and_retry_scheduling.py` | copied | Preserve campaign retry semantics. |
| `alembic/versions/f596c72044b0_calling_window_and_a_claim_index_that_.py` | `db/alembic/versions/f596c72044b0_calling_window_and_a_claim_index_that_.py` | copied | Preserve calling window and claim index. |
| `alembic/versions/c80d93f1c8be_session_outcome.py` | `db/alembic/versions/c80d93f1c8be_session_outcome.py` | copied | Preserve outcome semantics. |
| `alembic/versions/3b4a1c5307b4_to_number_blind_index.py` | `db/alembic/versions/3b4a1c5307b4_to_number_blind_index.py` | copied | Preserve privacy index. |
| `alembic/versions/ea9aef9b2d14_index_campaign_contacts_session_id.py` | `db/alembic/versions/ea9aef9b2d14_index_campaign_contacts_session_id.py` | copied | Preserve query index. |
| `alembic/versions/0e01a2f68295_per_weekday_calling_hours.py` | `db/alembic/versions/0e01a2f68295_per_weekday_calling_hours.py` | copied | Preserve calling-hour semantics. |
| `alembic/versions/b38ef3c19979_session_stt_audio_seconds.py` | `db/alembic/versions/b38ef3c19979_session_stt_audio_seconds.py` | copied | Preserve parallel STT branch. |
| `alembic/versions/8aa960fd77ec_campaigns_and_stt_audio_seconds.py` | `db/alembic/versions/8aa960fd77ec_campaigns_and_stt_audio_seconds.py` | copied | Preserve merge revision and parent tuple. |
| `alembic/versions/a41d2f6c2925_users_identities_and_memberships.py` | `db/alembic/versions/a41d2f6c2925_users_identities_and_memberships.py` | adapted | Import path points to target-local identical role values; identity SQL and head metadata unchanged. |
| `packages/oron-db/src/oron_db/roles.py` | `db/alembic/oron_migration_compat.py` | adapted/reduced | Migration-only enum preserves exactly `oron_sessions_app` and `oron_tenancy_app`; no runtime package dependency on sibling source. |

The imported target copies were mechanically normalized by the target Ruff
formatter after import. This changed whitespace/import ordering and modernized
type-annotation syntax only; revision metadata and SQL behavior remain as mapped
above.

## Phase 2A WACRM SQL adaptations

Locked source SHA for every row:
`98b5bd26e8feacacfd4b74ff58411acb8154d212`. WACRM is MIT-licensed. No source
SQL file is copied as a competing migration; final semantics are adapted into
Alembic-generated target revisions. The one-by-one disposition and affected
objects for migrations 001–039 are recorded in
[`docs/migration/wacrm-migration-map.md`](../migration/wacrm-migration-map.md).

| Source artifacts | Target artifacts | Status | License implications / reason |
| --- | --- | --- | --- |
| `supabase/migrations/001`, `002`, `017`, `020`–`022`, `025`, `034`, `036` | `a929e3f55c7a_add_canonical_crm_foundation.py`, `34376836baf5_establish_platform_foundation_and_.py` | adapted/re-written | MIT behavioral/schema semantics; account/auth coupling replaced by canonical tenant/user/membership, E.164 identity, and tenant composite constraints. |
| `supabase/migrations/001`, `003`–`005`, `009`, `013`, `014`, `020`, `023`, `024`, `027`, `035`–`039` | `2ef8ecd10c3d_add_canonical_messaging_foundation.py` | adapted/re-written | MIT messaging behavior; Realtime/Storage/service role replaced by durable PostgreSQL/application delivery/object references and platform roles. |
| `supabase/migrations/006`, `007`, `010`, `012`, `016`, `024` | `cebe5f87cf18_add_automation_operations_and_audit_.py` | behaviorally adapted/re-written | MIT behavior; canonical immutable versions/runs and durable PostgreSQL jobs replace source-specific runtime persistence. |
| `supabase/migrations/008`, `016`, `023`, `039` | `cebe5f87cf18_add_automation_operations_and_audit_.py` | superseded/adapted | MIT storage intent; metadata points to mounted-object/GCS backends and Supabase Storage is not a runtime authority. |
| `supabase/migrations/026`, `028`–`033` | `cebe5f87cf18_add_automation_operations_and_audit_.py` | adapted/re-written | MIT API-key/webhook/AI/knowledge behavior; credential references avoid plaintext secrets and PostgreSQL FTS works without requiring pgvector. |
| `supabase/migrations/011`, `015`, `018`, `019`, `031` | canonical identity docs/foundation and later application transactions | superseded/partially adapted | Auth-provider-specific SQL is not copied; invitations/membership intent retained. |

## Phase 2A OpenLive persistence adaptations

Locked source SHA for every row:
`849173cd1c8c17a95d600b17b428c301722bf5df`. OpenLive is MIT-licensed. The
target migration is a clean-room schema translation from observed persistence
semantics; source SQLite/JSON code is not a runtime dependency.

| Source artifacts | Target artifact | Status | License implications / reason |
| --- | --- | --- | --- |
| `packages/db/src/sqlite.ts`, `packages/db/src/queries.ts` | `f5e8b540dfeb_add_openlive_postgresql_persistence.py` (`live.chats`, `live.messages`) | adapted/re-written | MIT behavioral/schema semantics; stable message sequence and source IDs are preserved under canonical tenant scope. |
| `packages/db/src/queries.ts`, `packages/db/src/store.ts`, `packages/db/src/crypto.ts`, web settings/provider routes | `f5e8b540dfeb_add_openlive_postgresql_persistence.py` (`live.user_preferences`, `live.provider_configurations`) | adapted/re-written | MIT semantics; encrypted-source metadata maps to canonical credential references and plaintext secret keys are rejected from provider settings. |
| `packages/db/src/queries.ts`, live-agent session/provider state | `f5e8b540dfeb_add_openlive_postgresql_persistence.py` (`live.voice_profiles`, `live.sessions`) | adapted/re-written | MIT semantics; PostgreSQL owns metadata, object storage owns audio bytes, and external ACP sessions remain references. |
| `packages/db/src/migrate-conversations.ts`, `sqlite.ts`, `queries.ts`, and legacy file layouts | `db/importers/openlive_legacy/` | behaviorally adapted/re-written | MIT migration semantics; isolated one-time parser only, never imported by runtime packages. Full notice is retained in `THIRD_PARTY_NOTICES.md`. |
