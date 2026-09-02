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

## Phase 5 retained Or-on foundation packages

Locked source SHA for every row:
`cece174f4d590a1b8a283d539dd66e08cc689aa9`. Or-on has no repository license
file and remains private/proprietary project code. No public license is inferred.

| Source path | Target path | Status | Reason / exact adaptation |
| --- | --- | --- | --- |
| `packages/oron-common/src`, `tests` | `packages/py/oron-common/src`, `tests` | copied | Preserve call context, direction, E.164 validation, usage/cost behavior, and source tests. Content matches after line-ending normalization. |
| `packages/oron-common/pyproject.toml` | `packages/py/oron-common/pyproject.toml` | adapted | Original name/version retained; target Python 3.14 range and verified exact Pydantic/phonenumbers pins replace broad source ranges. |
| `packages/oron-db/src`, `tests/test_base.py` | `packages/py/oron-db/src`, `tests/test_base.py` | copied | Preserve SQLModel bases, async engine/session factory, runtime roles, and transaction-local tenant helper. Content matches after line-ending normalization. |
| `packages/oron-db/tests/test_rls.py` | `packages/py/oron-db/tests/test_rls.py` | adapted | Assertion is preserved; target adds postgres/RLS markers, missing-server skip, and standard-URL-to-asyncpg normalization for the canonical local environment. |
| `packages/oron-db/pyproject.toml` | `packages/py/oron-db/pyproject.toml` | adapted | Original identity retained; exact Python 3.14-compatible asyncpg, SQLAlchemy, and SQLModel pins selected. |
| `packages/oron-flows/src`, `tests` | `packages/py/oron-flows/src`, `tests` | adapted | Preserve typed graph, component library, composition, validation, seeds, store seam, voice metadata, and 102 collected source tests/evaluations. Quoted annotations were modernized for Python 3.14 and long expressions/fixtures were wrapped for target lint limits; runtime values and assertions are unchanged. |
| `packages/oron-flows/pyproject.toml` | `packages/py/oron-flows/pyproject.toml` | adapted | Original name/version and build layout retained; exact Pydantic pin and target workspace source are explicit. |

No source console, deployment configuration, provider credential, customer data,
model weight, Firebase integration, or runtime sibling dependency was imported in
this slice.

### Phase 5 tenancy, secrets, and sessions packages

Locked source SHA for every row remains
`cece174f4d590a1b8a283d539dd66e08cc689aa9`.

| Source path | Target path | Status | Reason / exact adaptation |
| --- | --- | --- | --- |
| `packages/oron-tenancy/src` | `packages/py/oron-tenancy/src` | adapted | Preserve tenant, phone, flow-store, SIP admission, RLS-facing, and membership behavior. Replace Firebase-specific runtime identity binding with `platform.identity_bindings`, canonicalize roles, align the Phase 4 scoped `api_keys` model, add the default-off telephony gate, redact credentials, and remove E.164/provider details from logs. |
| `packages/oron-tenancy/tests/test_control_plane.py`, `test_reconcile.py`, `test_provisioner.py`, `test_users_models.py` | matching target tests | adapted | Preserve provider-free model/reconciliation/LiveKit request fixtures; assertions now cover canonical roles, identity binding, secret redaction, and the mandatory real-telephony gate. No LiveKit request leaves the injected fake. |
| `packages/oron-tenancy/pyproject.toml` | `packages/py/oron-tenancy/pyproject.toml` | adapted | Identity retained; exact Python 3.14-compatible FastAPI, SQLModel, SQLAlchemy, asyncpg, LiveKit API, settings, and logging pins replace source ranges. |
| `packages/oron-secrets/src`, `tests/test_secrets.py` | `packages/py/oron-secrets/src`, `tests/test_secrets.py` | copied | Preserve explicit-value precedence and injected-client Secret Manager resolution without network access. Formatting only. |
| `packages/oron-secrets/pyproject.toml` | `packages/py/oron-secrets/pyproject.toml` | adapted | Identity retained; Python 3.14 and current stable Secret Manager client pinned. |
| `packages/oron-sessions/src` | `packages/py/oron-sessions/src` | adapted | Preserve encrypted sessions, blind indexes, campaigns, artifacts, client, sweeper, and API behavior. Add typed/redacted secrets, real-telephony gating, PII-safe failure logging, Python 3.14 modernization, and target lint adaptations. |
| `packages/oron-sessions/tests/test_client.py`, `test_config.py`, `test_contacts_file.py`, `test_crypto.py`, `test_models.py` | matching target tests | adapted | Preserve selected provider-free behavior; add default-off and redaction assertions. Source database/API/concurrency suites are deferred to P5-018 where they will use the canonical disposable-PostgreSQL harness rather than the source migration runner. |
| `packages/oron-sessions/pyproject.toml` | `packages/py/oron-sessions/pyproject.toml` | adapted | Identity/scripts retained; exact Python 3.14-compatible web, PostgreSQL, encryption, KMS, object-storage, spreadsheet, and multipart pins replace source ranges. |

The source `oron-sessions` Dockerfile, standalone source Alembic tests, console
contract test, environment files, deployment manifests, and any provider/model
assets were not copied. Target Compose, canonical Alembic, generated contracts,
and later Phase 5 integration tests own those concerns.

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
| `alembic/versions/0004_backfill_caller_number_encryption.py` | `db/alembic/versions/0004_backfill_caller_number_encryption.py` | adapted | Live encryption/blind-index behavior and revision metadata are preserved. Offline mode skips the row-reading backfill that Alembic's mock connection cannot execute; live imports use the target-local compatibility surface below. |
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
| `packages/oron-sessions/src/oron_sessions/crypto.py`, `config.py` | `db/alembic/oron_migration_compat.py` | adapted/reduced | Migration-only AES-256-GCM `v1:` format, tenant AAD, E.164 HMAC-SHA256 blind index, explicit LOCAL/KMS selection, and direct/`SECRET__` environment aliases preserve the historical non-empty `0004` backfill without importing the sibling runtime package. The target uses patched `cryptography==50.0.0` instead of the locked source's vulnerable 49.0.0; no key is generated or persisted. |

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
| Effective WACRM account/contact/inbox/pipeline schema and ID relationships | `db/importers/wacrm_legacy/` | behaviorally adapted/re-written | New provider-neutral MIT-compatible export planner/writer maps explicit account→tenant and user identities, then writes the initial contact/channel/conversation/message/pipeline/stage/deal slice through canonical PostgreSQL and its import ledger. No Supabase client or source migration runner is copied. |

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

## Phase 4 WACRM behavioral adaptations

Locked WACRM source SHA for every row:
`98b5bd26e8feacacfd4b74ff58411acb8154d212`. WACRM is MIT-licensed. These
artifacts are clean target implementations informed by source behavior; no
source file was copied verbatim. The existing WACRM notice remains in
`THIRD_PARTY_NOTICES.md`.

| Source artifacts | Target artifacts | Status | Reason / license implications |
| --- | --- | --- | --- |
| `src/lib/contacts/dedupe.ts`, `parse-contact-csv.ts`, `tag-write.ts`; contact pages/components | `packages/ts/crm/src/phone.ts`, `contacts.ts`; `apps/web/src/features/contacts/` | behaviorally adapted/re-written | Preserve normalized contact identity, dedupe, search, and tag presentation while replacing Supabase calls with tenant-local canonical PostgreSQL. MIT behavioral reference. |
| `src/lib/inbox/conversations.ts`; `src/components/inbox/*`; `src/lib/whatsapp/resolve-conversation.ts`, `send-message.ts` | `packages/ts/crm/src/messaging.ts`; `apps/web/src/features/inbox/`; same-origin messaging routes | behaviorally adapted/re-written | Preserve shared-conversation, unread, message ordering, provider-ID idempotency, and reply semantics. Phase 4 uses the local simulator only; no Meta call path is enabled. MIT behavioral reference. |
| `src/lib/whatsapp/phone-utils.ts`; `src/app/api/whatsapp/webhook/route.ts`; `src/lib/whatsapp/webhook-signature.ts` | `packages/ts/crm/src/phone.ts`, `webhook.ts`, and simulator ingestion | behaviorally adapted/re-written | E.164 normalization, exact raw-body HMAC-SHA256 verification, defensive Meta text-envelope parsing, and idempotency behavior are implemented without enabling a real provider route. MIT behavioral reference. |
| pipeline pages/components and migration `002_pipelines_enhancements.sql` | `packages/ts/crm/src/pipelines.ts`; `apps/web/src/features/pipelines/` | behaviorally adapted/re-written | Preserve ordered pipeline stages and same-pipeline deal movement on the canonical schema created in Phase 2. MIT behavioral reference. |
| dashboard aggregates and CRM navigation behavior | `packages/ts/crm/src/analytics.ts`; authenticated shell navigation | behaviorally adapted/re-written | Preserve operator-oriented CRM counts while using canonical identity and RLS. MIT behavioral reference. |
| `src/lib/broadcast-status.ts`, `broadcast-retry.ts`; `src/lib/whatsapp/broadcast-core.ts`, `broadcast-resume.ts`; broadcast wizard components | `packages/ts/crm/src/campaigns.ts`; `apps/web/src/features/operations/` | behaviorally adapted/re-written | Preserve stable audience, recipient aggregates, provider identifiers, and simulator-safe delivery. Durable worker claiming/retry remains explicit follow-up work. MIT behavioral reference. |
| `src/lib/automations/validate.ts`, `engine.ts`, builder components and automation pages | `packages/ts/crm/src/automations.ts`; `apps/web/src/features/operations/` | behaviorally adapted/re-written | Preserve draft/publish direction using the canonical immutable flow graph/version tables. Runtime execution remains adapter-owned and is not rewritten. MIT behavioral reference. |
| webhook persistence/retry and broadcast resume helpers | `db/alembic/versions/66e34e3b2067_add_messaging_worker_claim_primitives.py`; `services/ts/messaging-worker/src/database.ts` | behaviorally adapted/re-written | Preserve at-least-once webhook and resumable campaign semantics using canonical PostgreSQL leases/jobs rather than Supabase/background-process state. No provider SDK or source file copied. |
| public API key routes and CRM integration helpers | `db/alembic/versions/b56eb0a0aca1_add_scoped_public_api_keys.py`; `packages/ts/crm/src/api-keys.ts`; `/api/v1/contacts` | behaviorally adapted/re-written | Preserve tenant API access while replacing plaintext/broad source assumptions with HMAC-digested, scoped, expirable canonical keys. MIT behavioral reference. |

## Phase 5 Or-on dispatcher adaptations

Locked Or-on source SHA for every row:
`cece174f4d590a1b8a283d539dd66e08cc689aa9`. Or-on has no repository license
file and remains private/proprietary project code. No public license is inferred.

| Source artifacts | Target artifacts | Status | Reason / exact adaptation |
| --- | --- | --- | --- |
| `packages/oron-dispatcher/src/oron_dispatcher/dispatcher.py` | `packages/py/oron-dispatcher/src/oron_dispatcher/dispatcher.py` | behaviorally adapted/re-written | Preserves one-agent-per-room, DID-first inbound rejection, outbound/browser lifecycle, active calls, hangup, and finalization. Replaces best-effort persistence with a strict port, stable request/room identifiers, redacted logs, and provider preflight. Agent-specific imports are deferred to P5-010. |
| `packages/oron-dispatcher/src/oron_dispatcher/webhook.py` | `packages/py/oron-dispatcher/src/oron_dispatcher/webhook.py`, `webhook_ledger.py` | behaviorally adapted/re-written | Preserves LiveKit signed-body verification and event routing. Replaces static outbound bearer auth with canonical short-lived service assertions and adds durable PostgreSQL claim/replay handling. |
| `packages/oron-dispatcher/src/oron_dispatcher/sip_client.py` | `packages/py/oron-dispatcher/src/oron_dispatcher/sip_client.py` | adapted | Preserves LiveKit `CreateSIPParticipantRequest` behavior while adding mandatory configuration + explicit-approval checks both before orchestration and at the provider boundary. |
| `packages/oron-dispatcher/src/oron_dispatcher/tenancy_client.py` | `packages/py/oron-dispatcher/src/oron_dispatcher/tenancy_client.py` | behaviorally adapted/re-written | Preserves fail-closed DID resolution and bounded httpx behavior; points at the canonical versioned API contract and accepts injected service-auth headers. |
| `packages/oron-dispatcher/src/oron_dispatcher/config.py`, `app.py` | `packages/py/oron-dispatcher/src/oron_dispatcher/config.py`, `services/py/dispatcher/src/dispatcher_runtime/` | behaviorally adapted/re-written | Preserves typed process configuration and DI composition while removing Firebase/admin console fields/routes and making incomplete engine wiring honestly not ready. |
| `packages/oron-dispatcher/src/oron_dispatcher/admin.py`, `auth.py` | not imported | required removal | Firebase console verification and the standalone admin BFF are replaced by Phase 3 canonical identity/RBAC/CSRF and same-origin web routes. |
| `packages/oron-dispatcher/src/oron_dispatcher/launcher.py` | deferred to P5-010 | deferred | Depends on the retained Pipecat agent and Hebrew model, which are integrated under their separate compatibility/model-license gate. |

## Phase 5 Or-on Hebrew and Pipecat-agent adaptations

Locked Or-on source SHA for every row:
`cece174f4d590a1b8a283d539dd66e08cc689aa9`. Or-on has no repository license
file and remains private/proprietary project code. No public license is inferred,
and no model weights or model licenses are imported by these rows.

| Source artifacts | Target artifacts | Status | Reason / exact adaptation |
| --- | --- | --- | --- |
| `packages/oron-hebrew/src/oron_hebrew/{numbers,normalizer,niqqud_filter,gender}.py` | same paths under `packages/py/oron-hebrew/src/oron_hebrew/` | copied/adapted | Preserves Hebrew text, number, niqqud, and gender semantics. Target formatting is mechanical; logs no longer expose input text or raw exception details. |
| `packages/oron-hebrew/src/oron_hebrew/g2p.py` | `packages/py/oron-hebrew/src/oron_hebrew/g2p.py`, `assets.py` | adapted | Preserves Renikud G2P/phoneme behavior but removes the upstream implicit Hugging Face download. Construction requires an existing local model plus exact SHA-256 and fails closed without it. |
| `packages/oron-hebrew/src/oron_hebrew/{gender_audio_ecapa,ecapa_model}.py` | same paths under `packages/py/oron-hebrew/src/oron_hebrew/`, plus `assets.py` | adapted | Preserves ECAPA architecture, VAD-gated buffering, and classification behavior. Model loading requires a checksum-verified local path and `local_files_only=True`; no weights are copied or fetched. |
| `packages/oron-hebrew/tests/` excluding evaluation assets | `packages/py/oron-hebrew/tests/` | copied/adapted | Preserves source assertions. Model-dependent tests inject deterministic local fakes; filesystem expectations are cross-platform and no test downloads a model. |
| `packages/oron-agent/src/oron_agent/` excluding `flows_seed/` | `packages/py/oron-agent/src/oron_agent/` | copied/adapted | Preserves Pipecat/LiveKit transport, STT/TTS/LLM pipeline, flow handlers, barge-in/turn behavior, audio filters, usage, lifecycle, and artifact behavior. Target adaptations add redacted secret types/logging, cross-platform local object URIs, explicit local model path/hash injection, and a default-off real-voice-provider gate. Filesystem JSON flow seeds are intentionally not imported because PostgreSQL/Alembic remain authoritative. |
| `packages/oron-agent/src/oron_agent/config.py`, entrypoint/provider composition | same target package paths | adapted | Provider credentials default empty and are `SecretStr`; provider execution requires `ENABLE_REAL_VOICE_PROVIDERS=true` plus complete configuration. Diagnostics expose booleans only. No provider client/model is built before the gate. |
| `packages/oron-dispatcher/src/oron_dispatcher/launcher.py` | `packages/py/oron-agent/src/oron_agent/launcher.py`; `services/py/dispatcher/src/dispatcher_runtime/app.py` | behaviorally adapted/re-written | Preserves one task per call and Pipecat `run_call` launch semantics in a target-owned typed handle with cancellation, override validation, and provider preflight. Dispatcher composition injects this port explicitly; default-off tests create no provider task. |
| `packages/oron-agent/tests/` excluding `tests/eval/` | `packages/py/oron-agent/tests/` | copied/adapted | Preserves behavioral coverage with local fakes and target paths. External evaluation/model/provider cases are not imported; source deployment assertions now validate target `.env.example` defaults. |
| `packages/oron-hebrew/pyproject.toml`, `packages/oron-agent/pyproject.toml` | target package manifests, root `pyproject.toml`, `uv.lock` | adapted/re-written | Retains verified technologies on Python 3.14 with current compatible pins. Heavy dependencies live in opt-in uv group `voice`; `audiolab==0.5.1` is the tested compatibility fallback for Pipecat's `pyrnnoise==0.4.3`. |

## Phase 5 Or-on LiveKit/SIP deployment adaptation

Locked Or-on source SHA:
`cece174f4d590a1b8a283d539dd66e08cc689aa9`. Or-on remains private/proprietary;
LiveKit Server and LiveKit SIP images declare Apache-2.0, while the official
Redis 8 image has its separately documented tri-license.

| Source artifacts | Target artifacts | Status | Reason / exact adaptation |
| --- | --- | --- | --- |
| `deploy/livekit/docker-compose.dev-sip.yml`, `livekit.dev-sip.yaml`, `sip/sip.dev.yaml` | `infra/compose/compose.yaml`, `infra/compose/livekit/*.yaml` | adapted | Preserves the required Redis-backed LiveKit/SIP bridge topology. Replaces floating images with exact tags and multi-platform digests, removes the public Redis/SIP/RTP bindings, injects local credentials from ignored environment state, adds dependency-aware health checks, and retains `use_external_ip: false`. |
| Source control-plane readiness lesson (`sip not connected (redis required)`) | `scripts/verify_voice_profile.py`, `scripts/dev.py`, `Makefile` | behaviorally adapted/re-written | Uses only list-inbound, list-outbound, and list-dispatch-rule calls to prove SIP registration. Refuses missing/short/upstream-placeholder credentials and never invokes create/update/delete/participant/transfer APIs. |

## Phase 5 canonical voice product adapters

Locked Or-on source SHA:
`cece174f4d590a1b8a283d539dd66e08cc689aa9`. The artifacts below are new
target implementations over previously imported proprietary packages; no new
upstream file was copied.

| Source artifacts | Target artifacts | Status | Reason / exact adaptation |
| --- | --- | --- | --- |
| `packages/oron-tenancy` phone-number, flow-store and reconciliation behavior | `services/py/control-api/src/control_api/voice.py`; unified `/voice` and `/flows` features | behaviorally adapted/re-written | Preserves canonical DID/flow binding and typed component validation. Provider mutation is replaced by deterministic simulator admission and read-only diagnostics unless a later separately approved real action passes both gates. |
| `packages/oron-sessions` session, event, campaign, calling-window and usage behavior | Alembic `7beb64e1ff33`; control API voice repository; unified call/campaign/contact surfaces | behaviorally adapted/re-written | Preserves `sessions` and retained flow runtime as authorities while adding canonical CRM consent/audience links, immutable version APIs, safe audit/outbox/object metadata, and same-origin UI. No standalone console source was copied. |

## Phase 6 cross-channel adaptations

| Source | Locked source artifacts | Target artifacts | Status / license implications |
| --- | --- | --- | --- |
| Or-on `cece174f4d590a1b8a283d539dd66e08cc689aa9` | `packages/oron-flows/`, retained session/outcome and dispatcher contracts | Alembic `bc63218e8d41`; `packages/ts/crm/src/cross-channel.ts`; `control_api/orchestration.py` | Behaviorally adapted/re-written as a thin `oron-flow.v1` compiler and terminal-session workflow. No new upstream source is copied; Or-on remains private/proprietary. |
| WACRM `98b5bd26e8feacacfd4b74ff58411acb8154d212` | `src/lib/whatsapp/meta-api.ts`, `send-message.ts`, `webhook-signature.ts`, `src/app/api/whatsapp/webhook/route.ts` | `services/ts/messaging-worker/src/providers.ts`; `packages/ts/crm/src/whatsapp-outbound.ts`, `webhook.ts`, `webhook-store.ts`; Alembic `a1a71d1f7a03` | Behaviorally adapted/re-written under MIT: Meta messages edge, text/template shapes, customer window, E.164, signature verification, delivery status, and retry intent. Supabase, direct-send-before-persist, stored access tokens, media, and unrelated template-management code were not copied. |
| WACRM `98b5bd26e8feacacfd4b74ff58411acb8154d212` | automation validation/engine/builder and CRM/inbox/campaign behavior | same Phase 6 migration, cross-channel module, BFF routes, and orchestration UI | MIT behavioral adaptation to `wacrm-automation.v1`, canonical PostgreSQL jobs, RLS, idempotency, and handoff. Existing MIT notice remains in `THIRD_PARTY_NOTICES.md`; no file is copied verbatim. |
| OpenLive `849173cd1c8c17a95d600b17b428c301722bf5df` | none imported in Phase 6 | none | Explicitly deferred to Phase 9. No OpenLive runtime, visual-agent, browser-media, ACP/MCP, WebGPU, or desktop implementation is added. |
