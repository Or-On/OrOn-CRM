# Phase 0 repository inventory

Audit date: 2026-08-31 (Asia/Jerusalem)
Audit mode: read-only inspection of `../or-on`, `../wacrm`, and `../openlive`

Paths in this audit are relative to the Or-On Platform repository root. Facts were verified from Git metadata, repository instructions, manifests and lockfiles, migrations, CI and deployment files, tests, and implementation code. README-only claims are called out when current code disagrees. No dependency installation, source mutation, migration, service startup, provider call, telephone call, or WhatsApp send was performed.

## Locked sources

| Source | Verified origin | Branch | Commit | Worktree | License |
| --- | --- | --- | --- | --- | --- |
| Or-on | `https://github.com/Abssel-AI/or-on.git` | `master` tracking `origin/master` | `cece174f4d590a1b8a283d539dd66e08cc689aa9` | clean; local HEAD equals tracking ref | No license file or package license metadata found. Treat as proprietary private source under the master prompt. |
| WACRM | `https://github.com/ArnasDon/wacrm.git` | `main` tracking `origin/main` | `98b5bd26e8feacacfd4b74ff58411acb8154d212` | clean; local HEAD equals tracking ref | MIT, copyright 2026 Arnas Donauskas (`../wacrm/LICENSE`). |
| OpenLive | `https://github.com/katipally/openlive.git` | `main` tracking `origin/main` | `849173cd1c8c17a95d600b17b428c301722bf5df` | clean; local HEAD equals tracking ref | MIT, copyright 2026 Yashwanth Reddy Katipally (`../openlive/LICENSE`). |

The machine-local checkouts exactly matched their configured upstream tracking refs at audit time. No network fetch was needed, so “current” means current in the supplied checkout, not a new comparison against GitHub.

## Or-on

### Purpose and layout

Verified AI telephone call-center platform: carrier SIP -> self-hosted LiveKit SIP/SFU -> LiveKit room -> Pipecat agent. The repository is a Python 3.12+ `uv` virtual workspace with a Vite/React operator console.

| Area | Evidence-backed inventory |
| --- | --- |
| Root | `pyproject.toml`, `uv.lock`, root Alembic history, shared pytest fixtures, CI, deployment configuration. |
| Python packages | `oron-common`, `oron-db`, `oron-tenancy`, `oron-secrets`, `oron-sessions`, `oron-flows`, `oron-hebrew`, `oron-dispatcher`, `oron-agent`. |
| Web app | `apps/console`: React 19, TypeScript, Vite, React Flow; dev port 5173; proxy defaults to dispatcher 8080. |
| Dependency direction | Documented and reflected in manifests: agent/dispatcher -> sessions -> tenancy -> db -> common, with flows, Hebrew, and secrets as bounded packages. |
| Tracked files | 355. The source is predominantly Python (260 `.py` files), plus 32 TypeScript/TSX files. |

Key evidence: `../or-on/README.md`, `../or-on/CLAUDE.md`, `../or-on/pyproject.toml`, and `../or-on/packages/*/pyproject.toml`.

### Runtime services and ports

| Service | Runtime / entrypoint | Default or published ports | Persistence / dependencies |
| --- | --- | --- | --- |
| Sessions/control API | FastAPI/Uvicorn, `oron-sessions` | package default 8080; deployed as 8081 | PostgreSQL via async SQLAlchemy/SQLModel; Alembic schema; GCS artifacts optional. |
| Dispatcher/admin BFF | FastAPI/Uvicorn, `oron-dispatcher` | 8080 | LiveKit API/webhooks, sessions API, SIP provisioning, Firebase token verification for console. |
| Voice worker | Pipecat, `oron-agent` | joins LiveKit; no ordinary public HTTP port | LiveKit transport, Soniox STT/TTS, Gemini/Vertex or OpenAI-compatible LLM, session API. |
| Session sweeper | `oron-sessions-sweeper` | none | PostgreSQL campaign/session state. |
| Console | Vite in development; nginx image in deployment | 5173 dev; public through Caddy | Browser calls `/admin`; Firebase browser auth; local UI preferences/drafts. |
| PostgreSQL | Compose | host 5433 -> container 5432 for local dev | Sole Or-on application database. Dev uses PostgreSQL 18; deployment uses PostgreSQL 16 Alpine. |
| LiveKit SFU | Compose | 7880 HTTP/WS, 7881 TCP fallback, 7882/UDP media | Redis required for the complete SIP control plane. |
| LiveKit SIP | Compose | 5060/UDP, 10000-10100/UDP media | Requires non-empty inbound ACL. |
| Redis | Compose | 6379 in SIP dev profile | LiveKit/SIP infrastructure only, not business persistence. |
| Phoenix tracing | Compose | 6006 UI, loopback 4317 OTLP gRPC | Optional observability. |
| Caddy | deployment Compose | public HTTP/HTTPS | Reverse proxy for console and service routes. |

Or-on deployment currently includes GKE- and Cloud Build-oriented material even though the unified target explicitly standardizes on one GCP VM and Docker Compose. Several LiveKit images use floating `latest`, which conflicts with the target's pinned-image rule.

### Database, migrations, tests, and integrations

- PostgreSQL tables verified in SQLModel and migrations: `tenants`, `phone_numbers`, `api_keys`, `users`, `user_identities`, `memberships`, `sessions`, `flows`, `campaigns`, and `campaign_contacts`.
- Tenant data uses UUIDs and transaction-local `app.current_tenant`; RLS is enabled and forced on `sessions`, `flows`, `campaigns`, and `campaign_contacts`. Runtime roles are split into `oron_sessions_app` and `oron_tenancy_app`.
- Root Alembic has 22 revisions and one statically verified head, `a41d2f6c2925`. Revision `8aa960fd77ec` merges two branches. See [database-map.md](database-map.md).
- 130 test modules were found. CI runs Ruff check/format, Pyrefly, console Vitest/build, real PostgreSQL migrations plus `alembic check`, and parallel pytest with per-worker databases.
- Verified integrations: LiveKit SFU/SIP/API, Telnyx setup, Pipecat, Soniox, Google Vertex/Gemini/TTS, OpenAI-compatible LLM endpoints, GCP Secret Manager/KMS/GCS, Firebase Auth token verification, OpenTelemetry/Phoenix, RenikudPlus/Hugging Face, ECAPA voice-gender weights, optional Krisp SDK/model.
- Reusable strengths: working telephony lifecycle, DID admission/reconciliation, safe SIP ACL guard, tenant RLS/session helpers, field encryption/blind indexes, sessions/usage/latency/outcome tracking, campaign claim/retry scheduling, typed flow composition/runtime, Hebrew voice pipeline, structured tests.
- Verified gap: README says warm transfer is not implemented. The repository also depends on Firebase for console identity, prohibited in the target.

## WACRM

### Purpose and layout

Verified self-hostable WhatsApp CRM template built as one Next.js application with a separate MCP server and ordered Supabase SQL migrations.

| Area | Evidence-backed inventory |
| --- | --- |
| Application | Next.js 16.2.12 App Router, React 19.2.4, TypeScript 6, Tailwind 4, next-intl, Base UI, XYFlow, DnD Kit, Recharts. |
| Database access | `@supabase/ssr` and `@supabase/supabase-js` are used in server code, browser hooks, pages, and routes. |
| MCP | `mcp-server/`, Node/TypeScript, stdio MCP wrapper over `/api/v1`, read-only by default with separate write and broadcast flags. |
| Package manager | npm 10.9.9; Node >=20.0.0; two npm lockfiles (app and MCP server). |
| Tracked files | 482: 389 TypeScript/TSX files and 40 SQL files. |

Key evidence: `../wacrm/package.json`, `../wacrm/package-lock.json`, `../wacrm/src`, `../wacrm/mcp-server`, and `../wacrm/supabase/migrations`.

### Runtime services and ports

| Service | Runtime / entrypoint | Port | Persistence / dependencies |
| --- | --- | --- | --- |
| Web, BFF, webhook, and cron endpoints | Next.js standalone server | 3000 in container; configurable host port | External Supabase Postgres/Auth/Realtime/Storage. |
| MCP server | Node stdio process | no network listen of its own | Calls WACRM `/api/v1` using scoped API key. |
| Automation/flow delayed work | External scheduler invokes GET cron routes | same application origin | Database pending-execution/flow-run state; no bundled scheduler service. |

The Compose file contains only the application. It does not include PostgreSQL and does not run migrations.

### Database, migrations, tests, and integrations

- 39 ordered SQL migrations. The schema contains 37 verified public tables plus Supabase `auth.users` and `storage` objects; `uuid-ossp` and `vector` extensions; many RLS policies, SECURITY DEFINER functions, triggers, and RPCs.
- Core models include accounts/profiles/invitations; contacts/tags/custom fields/notes; conversations/messages/reactions/quick replies; pipelines/stages/deals; WhatsApp config/templates; broadcasts/recipients; automations/steps/logs/pending executions; flows/nodes/runs/events; notifications/presence; API keys/webhook endpoints; AI config/knowledge/usage.
- Tenancy evolved from per-user `auth.uid()` policies to one account per profile with `owner/admin/agent/viewer`. It is not the target's many-membership tenant model and is coupled to Supabase Auth JWT context.
- Storage buckets `avatars`, `flow-media`, and `chat-media` are Supabase-specific and public-readable where Meta needs URLs. Inbound media mirroring addresses Meta retention but must be replaced by local object storage/GCS metadata in PostgreSQL.
- 80 test modules found. CI runs npm install, lint, TypeScript checks, Vitest, and Next build. A separate workflow starts Supabase locally, replays migrations, and checks the resulting schema.
- Verified integrations: Meta WhatsApp Cloud/Business APIs, Supabase Auth/Postgres/PostgREST/Realtime/Storage, OpenAI and Anthropic AI replies, pgvector/full-text knowledge retrieval, signed outbound webhooks with SSRF controls, MCP, external cron scheduler.
- Reusable strengths: unified CRM UX, shared inbox, message/template/media/reaction behavior, contact import/dedupe/tags/custom fields/notes, pipelines/Kanban, broadcasts with resume/status aggregation, automation and visual flow editors, teams/RBAC/invitations, API keys and REST API, MCP safety gates, AI handoff/knowledge/usage, webhook verification/dedup-related logic, extensive unit tests.
- Target blockers: pervasive Supabase client/Auth/Realtime/Storage coupling and direct browser database access; real WhatsApp send routes lack the target-wide `ENABLE_REAL_WHATSAPP=false` gate.

## OpenLive

### Purpose and layout

Verified local-first voice/vision interface. The browser renderer owns VAD, STT, end-of-turn, and most TTS; a Hono/WebSocket agent service drives provider models or local coding-agent CLIs; Electron packages both.

| Area | Evidence-backed inventory |
| --- | --- |
| Web | Next.js 16.2.x, React 19.2, Tailwind 4, Web Workers, WebGPU/WASM model execution. |
| Agent service | Hono, `ws`, TypeScript/tsx; `/live` WebSocket and `/voice` HTTP routes. |
| Packages | `shared` wire types/agent registry, `harness` model adapters, `db` persistence, plus web/desktop/agent workspaces. |
| Desktop | Electron 43, electron-builder, updater, tray/mini mode/notifications, local child-process supervision. |
| Package manager | pnpm 11.5.2; Node >=22.13; TypeScript 5.7/locked 5.9. |
| Tracked files | 225, including 168 TypeScript/TSX files. |

### Runtime services and ports

| Service | Runtime / entrypoint | Default ports | Persistence / dependencies |
| --- | --- | --- | --- |
| Web | Next.js custom server | 3000 | API routes plus renderer-local model/cache/preferences. |
| Agent | Hono HTTP + `/live` WebSocket | 8787, loopback by default | SQLite/JSON/files through `@openlive/db`; child ACP processes. |
| Desktop packaged web | Electron-managed Next server | 47824 | same local data directory. |
| Desktop packaged agent | Electron-managed Hono server | 47823 | authenticated with generated local shared secret. |
| Electron debug | Electron | 9333 in development | no business persistence. |

### Persistence, tests, protocol, and integrations

- Current code, not stale docs, is authoritative: `packages/db/src/sqlite.ts` creates `meta`, `chats`, and `messages` in `openlive.db`, using WAL. `providers.json`, `settings.json`, and `voice-profiles.json` remain cross-process locked JSON stores. Wav files and models live below the data directory. A one-time importer moves legacy `conversations.json` to SQLite.
- Browser `localStorage` stores material configuration: pipeline settings, per-chat agent/folder/resume binding, selected models/modes/options, plus UI preferences. Cache Storage holds downloaded models. The target must move business/profile/session configuration to PostgreSQL while preserving non-authoritative device UI preferences and disposable model caches.
- `/live` is a Zod-validated discriminated protocol. Client messages include text turns with optional camera/screen frames, cancel, controls, bind, permission/elicitation responses, and agent option changes. Server messages wrap SSE events and include frame requests, desktop bridges, permissions, agent metadata, bind state, history reloads, and errors. Audio does not cross this socket.
- 19 Vitest modules found. CI runs install, typecheck, and tests on Linux and Windows, and builds unsigned Windows/Linux desktop artifacts. Release builds macOS/Windows/Linux installers.
- Verified integrations: Anthropic, OpenAI, MiniMax, Ollama local/cloud, Groq, OpenRouter, DeepSeek, Mistral, xAI, Google Gemini, Together, Fireworks, Cerebras, Perplexity; Exa search; ACP adapters for Claude Code, Codex, Cursor, OpenCode, Hermes; MCP configuration passthrough; Silero VAD, Whisper, Smart-Turn, Kokoro, Supertonic, ZipVoice/sherpa-onnx; camera/screen capture and Electron OS bridges.
- Reusable strengths: thick-client media privacy, WebGPU pipeline, barge-in and ordering behavior, model lifecycle/progress, typed live protocol, provider harness, coding-agent registry and supervision, permissions/elicitation relay, reconnect and history UX, voice cloning, desktop wrapper.
- Target blockers: no tenant/user auth model; optional shared-secret auth is insufficient for the unified product; SQLite/JSON/localStorage business persistence is prohibited; provider credential rows have no tenant scope; the agent service catches process-wide uncaught exceptions and continues, which needs hardening.
- Documentation drift is verified: `README.md` and `docs/ARCHITECTURE.md` still describe conversations as JSON, while current code stores chats/messages in SQLite. The audit uses code.

## Audit limitations and unresolved evidence

- No upstream tests were executed because Or-on tests can reset PostgreSQL and exercise SIP provisioning, WACRM migration tests start Supabase, and the user requested a read-only audit without installing dependencies.
- Runtime behavior was assessed from source and existing tests, not from provider smoke tests.
- Dependency license inventories were derived from checked-in lock metadata and explicit code/docs; a dedicated SBOM/license scanner remains a Phase 1/10 gate.
- Or-on's external Obsidian architecture/status vault was intentionally not used. The unified repository must become self-contained.
- No license file was found for Or-on. That is a material provenance fact, not an assertion that the code is unlicensed in a legal sense; owner confirmation is required before any distribution outside the private target.
