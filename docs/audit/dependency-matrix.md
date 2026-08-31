# Dependency and runtime matrix

This inventory records checked-in constraints and lockfile state; it does not imply that packages were installed during the audit.

## Toolchain compatibility

| Concern | Or-on | WACRM | OpenLive | Integration implication |
| --- | --- | --- | --- | --- |
| Python | >=3.12; root target Pyrefly is 3.12 | none | Hermes adapter may launch external Python, but app is TypeScript | Keep Python 3.12 initially. Use `uv`; no bare Python/pytest in the migrated workspace. |
| Node | Console CI uses 22 | >=20 | >=22.13 | Adopt >=22.13 after WACRM Next/build compatibility verification. |
| JS package manager | npm in console | npm 10.9.9 | pnpm 11.5.2 | Target requires pnpm/Turbo. Migrate WACRM and console deliberately; do not maintain competing workspace lock authorities. |
| TypeScript | Console locked by npm; React/Vite | TS 6.0.3 locked | TS 5.9.3 locked from ^5.7.3 | Resolve TS major after compile experiments. Shared contracts must not depend on framework-private types. |
| Frontend framework | React 19.2.3, Vite 7.3.1, React Flow 12.10.1 | Next 16.2.12, React 19.2.4, Tailwind 4.3.3 | Next 16.2.9 lock lineage, React 19.2, Tailwind 4.3.2 | WACRM is closest to target shell. Port Or-on editor behavior and OpenLive Live Lab into the selected pinned Next baseline. |
| Database migration tool | Alembic >=1.13 | Supabase CLI 2.113.0 in CI | Runtime SQLite DDL | Alembic becomes the only target migration authority. |
| Tests | pytest 8/asyncio/xdist; Vitest console | Vitest 4.1.10 | Vitest 3.2.7 | Root orchestration can retain native runners; consolidate reporting without rewriting tests first. |

## Or-on Python workspace

| Package | Direct internal dependencies | Important external dependencies | Reusable boundary |
| --- | --- | --- | --- |
| `oron-common` | none | Pydantic, phonenumbers | Call context, phone normalization, shared usage models. |
| `oron-db` | none | SQLModel, SQLAlchemy asyncio, asyncpg | Timestamp/tenant bases, async engine, tenant-local RLS helpers and role definitions. |
| `oron-flows` | `oron-common` | Pydantic | Typed graph, composition, component catalog, validation and store contract. |
| `oron-hebrew` | `oron-common` | RenikudPlus/ONNX Runtime, Pipecat, Loguru, Torch/Torchaudio, safetensors | Hebrew G2P/niqqud/normalization and voice-gender pipeline. Heavy ML dependency boundary. |
| `oron-secrets` | none | Google Cloud Secret Manager | `SECRET__`/ADC secret-loading adapter. |
| `oron-tenancy` | common, db, flows | FastAPI, SQLModel/SQLAlchemy/asyncpg, LiveKit API, Pydantic Settings | Tenants, memberships, phone/SIP admission, API keys, identity records. |
| `oron-sessions` | common, db, flows, tenancy, secrets | FastAPI, Alembic, cryptography, Google KMS/GCS, openpyxl, multipart | Calls/sessions, campaigns, artifacts, encryption, usage/latency/outcomes. |
| `oron-agent` | common, Hebrew, sessions, secrets, flows | `pipecat-ai` extras, LiveKit API, httpx, GCS, OTel/Phoenix | Voice media/AI runtime. Keep isolated from ordinary web business modules. |
| `oron-dispatcher` | common, agent, sessions, tenancy, secrets | LiveKit API, FastAPI, httpx, multipart, Firebase Admin | LiveKit webhook, outbound calls, admin BFF. Firebase adapter must be removed. |

The `uv.lock` contains 205 package records. High-impact constraints include Pipecat >=1.6, Torch/Torchaudio >=2.2, asyncpg >=0.29, SQLAlchemy >=2, SQLModel >=0.0.22, FastAPI >=0.115, LiveKit API >=0.8, and multiple Google Cloud clients. The optional Krisp SDK is a separately licensed wheel and is not declared as an ordinary index dependency.

## WACRM application

| Area | Checked-in dependencies | Integration decision |
| --- | --- | --- |
| Next application | Next 16.2.12, React/React DOM 19.2.4, next-intl 4.13.5 | Primary shell candidate; read bundled version docs before framework edits. |
| UI | Base UI 1.6, class-variance-authority, clsx, Lucide, Sonner, Tailwind 4, tailwind-merge | Reuse components/tokens selectively; create bounded `packages/ts/ui`. |
| Editors/interactions | XYFlow 12.11.2, Dagre 3.1, DnD Kit | Strong flow/pipeline editor substrate; compare against Or-on console editor behavior. |
| Charts/time | Recharts 3.10.1, date-fns 4.4 | Reuse where compatible. |
| Current data/auth | `@supabase/ssr` 0.12, `@supabase/supabase-js` 2.108.2 | Runtime dependencies must be eliminated. Preserve schema/behavior through BFF and generated clients. |
| Audio messaging | `opus-recorder` 8.0.5 | Retain only if message voice-note parity needs it and browser compatibility tests pass. |
| Development | ESLint 9, Prettier 3.9, TypeScript 6, Vitest 4.1 | Fold into root conventions after framework baseline selection. |
| MCP server | MCP SDK 1.30.0, Zod 3.25.76, TypeScript 5.9.3 | Preserve as a bounded package/service over the unified API. |

The main npm lock contains 803 non-root package records; MCP has 96. These counts include platform-specific packages.

## OpenLive workspace

| Workspace | Important dependencies | Reusable boundary |
| --- | --- | --- |
| `apps/web` | Next 16, React 19, Hugging Face Transformers 4.2, VAD Web, Kokoro, ONNX Runtime Web, TanStack Query, Zustand, GSAP, ws | Live Lab UI and browser-local media/model engine. |
| `services/agent` | Hono/node-server, ws, ACP SDK, MCP SDK, sherpa-onnx-node, Zod, tar/undici | Versioned live-agent/ACP/voice-cloning service. |
| `packages/shared` | Zod | Agent registry, wire protocol, shared types; good contract seed. |
| `packages/harness` | Provider adapters and SDK-facing code | Provider-neutral Anthropic/OpenAI/Chat dialect boundary. |
| `packages/db` | Node built-in SQLite, proper-lockfile | **Do not port as target runtime**; isolate legacy readers/import logic. |
| `apps/desktop` | Electron 43.1.1, electron-builder 25.1.8, updater 6.8.9, esbuild | Optional desktop wrapper retained after web-first integration. |

The pnpm lock contains approximately 765 package keys. The workspace forces one `@huggingface/transformers` 4.2.0 copy to prevent ONNX runtime conflicts and explicitly permits native builds for Electron, esbuild, ONNX Runtime, protobuf, and Sharp. Preserve that constraint until model packaging tests prove a safe change.

## External runtime/provider dependencies

| System | Used by | Role | Target treatment |
| --- | --- | --- | --- |
| PostgreSQL | Or-on; WACRM through Supabase | Business database/RLS | One target PostgreSQL database and one Alembic history. |
| Supabase Auth/Realtime/Storage/PostgREST | WACRM | Auth, browser/server queries, realtime, media | Remove at runtime; translate behavior. |
| SQLite / JSON files | OpenLive | Chats/messages/config/keys/profiles | Import-only readers; never normal target runtime. |
| LiveKit server/SIP/API | Or-on | Media, SIP, rooms, dispatch | Retain bounded infrastructure. |
| Redis | Or-on LiveKit/SIP | LiveKit coordination | Allow only as required/disposable infrastructure. |
| Meta WhatsApp Cloud API | WACRM | Messaging/templates/media/webhooks | Retain behind provider port and simulator/default-off send guard. |
| Telnyx | Or-on | DID/SIP carrier setup | Retain optional adapter; never invoke during normal dev/test. |
| Soniox | Or-on | STT and TTS | Retain optional credentialed adapter with simulator/mocks. |
| Google Vertex/Gemini/TTS | Or-on/OpenLive | LLM/TTS/model provider | Consolidate credential catalog; keep speech-specific adapter where needed. |
| OpenAI/Anthropic and compatible APIs | All three in differing roles | Text/vision/AI replies | Prefer reusable provider harness and stable ports; never expose keys to browser. |
| GCP Secret Manager/KMS/GCS | Or-on | Secrets, encryption, artifacts | Reuse/adapt for target VM; local equivalents must remain safe. |
| Firebase Auth | Or-on | Console identity | Remove. |
| Hugging Face / ONNX model downloads | Or-on/OpenLive | G2P, gender, VAD/STT/TTS/end-turn | Keep model binaries outside PostgreSQL; record licenses/checksums. |
| ACP coding-agent adapters | OpenLive | Local agent processes | Retain with explicit permissions, authentication, and lifecycle isolation. |
| MCP | WACRM/OpenLive | Platform API tools / agent passthrough | Retain both bounded roles; audit actions. |

## Dependency-direction recommendation for Phase 1

```text
domain -> application -> ports -> adapters -> entrypoints

apps/web -> packages/ts/contracts + ui + api-client
services/ts/messaging-worker -> contracts + PostgreSQL/provider adapters
services/ts/live-agent -> OpenLive shared/harness/audio + authenticated contracts
services/py/* -> packages/py/* with Or-on's existing one-way direction
all persistence adapters -> the same PostgreSQL database
```

No cross-language module should import another runtime's implementation. HTTP/WebSocket/events must use versioned language-neutral contracts.
