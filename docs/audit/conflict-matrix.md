# Conflict matrix

| ID | Conflict | Verified source evidence | Target decision / Phase 1 question | Severity |
| --- | --- | --- | --- | --- |
| C-01 | Three incompatible identity systems | Or-on verifies Firebase UIDs; WACRM uses Supabase Auth `auth.users`/`auth.uid()`; OpenLive has no user/tenant identity. | Select one PostgreSQL-backed auth/session implementation. Import external subject IDs as legacy identities; remove Firebase/Supabase runtime dependencies. | Critical |
| C-02 | Tenant models disagree | Or-on has users-to-tenants memberships; WACRM deliberately enforces one account per profile; OpenLive is single-user. | Canonical many-to-many memberships with role bindings. Map WACRM account/profile rows and tenant-scope every OpenLive record. | High |
| C-03 | Migration authorities conflict | Or-on root Alembic (22 revisions, one head); WACRM 39 Supabase SQL migrations; OpenLive creates SQLite schema on process boot. | Preserve Or-on history as the only authority. Convert required WACRM SQL to generated Alembic revisions; create PostgreSQL models/importers for OpenLive. | Critical |
| C-04 | Runtime databases violate target | WACRM requires Supabase services; OpenLive uses SQLite/JSON/localStorage; Or-on uses PostgreSQL. | PostgreSQL is the only runtime business database. SQLite is allowed only in an isolated one-time OpenLive importer. | Critical |
| C-05 | Duplicate “flow” concepts and tables | Or-on `flows` stores typed voice compositions; WACRM has automations, flow nodes/runs/events and two editors. | Canonical versioned flow graph plus voice/messaging adapters. Retain both runtime engines until parity tests pass. | Critical |
| C-06 | Duplicate “agent” definitions | Or-on per-flow voice/provider settings; WACRM AI configs/handoff/knowledge; OpenLive coding-agent/provider/pipeline registries. | Canonical immutable agent-profile versions with channel capabilities and credential references. | High |
| C-07 | Duplicate conversations/messages/sessions | WACRM WhatsApp conversations/messages; OpenLive chats/messages; Or-on sessions/transcripts. | Keep specialized tables and expose one timeline projection. Establish explicit cross-channel link records. | High |
| C-08 | Contact identity duplication | WACRM contacts use phone data; Or-on campaign contacts and sessions store encrypted/blind-indexed phone numbers; OpenLive has no CRM contact. | Canonical contact + channel identity + protected phone model; import campaign rows with explicit mapping and consent status. | High |
| C-09 | Overlapping campaign models | Or-on voice campaigns/contact retry scheduler; WACRM broadcasts/recipients/audiences. | Canonical campaign metadata/audience/consent; channel-specific execution detail remains specialized. | High |
| C-10 | API route and namespace overlap | All three expose `/api`, `/health`, `/flows`, `/sessions`-like surfaces; dispatcher and Next BFF both act as facades. | One public origin, route registry, versioned internal APIs, generated clients, correlation/error envelope. | Medium |
| C-11 | Development port collision | WACRM web and OpenLive web both default to 3000. Or-on example LiveKit playground also publishes 3000. Or-on dispatcher 8080 can collide with generic web host choices. | Central port registry; unified web owns public app port. Assign internal live-agent and Python services stable non-overlapping ports. | High |
| C-12 | Node/package-manager mismatch | WACRM Node >=20/npm 10.9.9/TS 6; OpenLive Node >=22.13/pnpm 11.5.2/TS 5.7; Or-on console uses Node 22/npm. | Target Node >=22.13 and pnpm/Turbo after compatibility checks. Preserve lock provenance during migration; do not mix npm workspace packages. | High |
| C-13 | Framework version behavior | Both WACRM/OpenLive use Next 16, but exact versions and TypeScript majors differ. WACRM explicitly requires reading bundled Next docs before framework edits. | Select one pinned Next/React/TS baseline only after Phase 1 build experiments; retain scoped behavior tests. | Medium |
| C-14 | Realtime mechanisms differ | WACRM Supabase Realtime; OpenLive WebSocket; LiveKit event/webhook path. | Replace Supabase Realtime with authenticated same-origin app events. Keep OpenLive protocol and LiveKit events as bounded contracts. | High |
| C-15 | Credential storage differs | Or-on Secret Manager/KMS/env references; WACRM encrypted DB columns; OpenLive encrypted JSON plus file master key. | Encrypted PostgreSQL credential records, key versions, external master key, no credential material in profiles or browser. | Critical |
| C-16 | Object/media storage differs | Or-on GCS/local artifacts; WACRM public Supabase buckets; OpenLive local files/browser cache. | Local mounted object directory in dev, GCS on VM, PostgreSQL metadata. Model cache may remain disposable and client-local. | High |
| C-17 | Real-world action safety is inconsistent | WACRM MCP is safely read-only by default, but application send routes are normal live integrations; Or-on dispatcher can place calls when configured. | Global `ENABLE_REAL_WHATSAPP=false` and `ENABLE_REAL_TELEPHONY=false`, enforced in adapters and E2E. Simulators are default. | Critical |
| C-18 | RLS trust models differ | Or-on uses transaction-local `app.current_tenant`; WACRM uses Supabase JWT `auth.uid()` and SECURITY DEFINER helpers; OpenLive has none. | Extend Or-on-style transaction-local context and forced RLS. Translate WACRM policies; add role and fail-closed tests. | Critical |
| C-19 | PostgreSQL extensions differ | Or-on uses `citext`; WACRM uses `uuid-ossp` and `vector`. | Audit extension availability on PostgreSQL 16/18; prefer native UUID generation where feasible; retain pgvector only for verified knowledge search. | Medium |
| C-20 | Deployment topology conflicts | Or-on includes GKE/Cloud Build and a multi-service host-network-like Compose; WACRM assumes managed Node + external Supabase; OpenLive is desktop/local. | One GCP VM, private Compose networks, Caddy, PostgreSQL on attached disk, GCS objects/backups. No GKE/Supabase runtime. | High |
| C-21 | Service lifecycle mismatch | Telephony workers are per-call/long-lived; WACRM work is web-request/cron based; OpenLive child processes and WS sessions are user-interactive. | Preserve bounded services by lifecycle. Use a modular web/BFF plus Python voice services, messaging worker, and live-agent service. | Medium |
| C-22 | Local business persistence in browser | OpenLive stores pipeline and per-chat binding/model/folder/session choices in localStorage; Or-on stores unsaved flow drafts locally. | Define authoritative vs device-only state. Published/durable business config goes to PostgreSQL; disposable drafts/UI state may remain locally with clear semantics. | High |
| C-23 | Internationalization mismatch | WACRM ships English/Korean; Or-on voice is Hebrew-first and console has Hebrew labels; OpenLive has no verified i18n. | Unified English/Hebrew/RTL system; port functionality before visual parity is declared. | Medium |
| C-24 | Licensing/provenance asymmetry | WACRM/OpenLive are MIT; Or-on has no repository license; models/assets include additional licenses. | Preserve MIT notices and commit provenance. Keep target private/proprietary unless owner instructs otherwise. Resolve model/icon/font notices before distribution. | High |
| C-25 | Documentation drift | OpenLive README/architecture says conversations are JSON; code uses SQLite. Or-on architecture is partly in an external Obsidian vault. | Code/migrations/tests are evidence; migrate authoritative architecture/status docs into target. | Medium |
| C-26 | Test infrastructure has destructive or external prerequisites | Or-on DB fixtures reset schemas and SIP tests require full control plane; WACRM migration CI boots Supabase; OpenLive desktop builds native modules. | Build isolated PostgreSQL integration fixtures and simulators. Never point upstream or developer data at tests. | High |
| C-27 | Docker reproducibility gaps | Or-on uses `livekit/*:latest`, `caddy:2-alpine`, `nginx:alpine`; WACRM bases are major-tagged Node Alpine. | Pin versions/digests during Phase 1/9. Preserve known working versions through controlled compatibility tests. | Medium |
| C-28 | OpenLive service authentication is not product authentication | Shared secret is optional on loopback and query-token is supported for desktop WebSocket. | Same-origin BFF must mint short-lived authenticated session credentials with user/tenant context; avoid long-lived query credentials. | Critical |
| C-29 | Outbox/dedup guarantees are uneven | WACRM has provider IDs and reliability migrations but executes much work inline/cron; Or-on has campaign claiming; OpenLive uses local process state. | Canonical PostgreSQL inbox/outbox/jobs with idempotency, SKIP LOCKED, retries, DLQ, and trace IDs. | High |
| C-30 | Warm transfer parity is unverified | Or-on README explicitly marks warm transfer unimplemented while the target requires human handoff. | Keep parity item open; design and test a safe channel-specific handoff instead of claiming it exists. | High |

## Port inventory

| Port(s) | Existing claimant | Conflict / target note |
| --- | --- | --- |
| 3000 | WACRM web; OpenLive web; Or-on LiveKit playground example | Direct collision. Unified web should own the developer-facing web port. |
| 5173 | Or-on Vite console | Retire only after unified parity; may be temporary during migration. |
| 8080 | Or-on dispatcher/webhook/admin | Preserve internal service port or remap centrally. |
| 8081 | Or-on deployed sessions API | Preserve as private internal port or remap centrally. |
| 8098 | Or-on console `real_stack` embedded sessions API | Development helper only; not target topology. |
| 8787 | OpenLive agent HTTP/WS | Candidate live-agent private port, subject to central registry. |
| 47823/47824 | OpenLive packaged desktop agent/web | Retain desktop-specific ports if desktop stays bundled. |
| 9333 | Electron remote debugging | Development only; never expose. |
| 5432/5433 | PostgreSQL container/host mapping | One target database; never public on VM. |
| 6379 | Redis | LiveKit/SIP infrastructure only. |
| 7880/7881/7882 UDP | LiveKit | Required verified signaling/media exposure. |
| 5060 UDP, 10000-10100 UDP | LiveKit SIP/media | Restrict firewall and SIP ACL. |
| 4317, 6006 | OTLP/Phoenix | Optional observability, private/IAP. |
