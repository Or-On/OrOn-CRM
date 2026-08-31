# Source provenance and reuse map

This map is a plan for preserving provenance when code is copied into the target. No source code was copied during Phase 0.

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
