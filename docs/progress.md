# Or-On Platform progress

Last updated: 2026-09-01 (Asia/Jerusalem)

## Current checkpoint

- Phase: Phase 2A — Canonical PostgreSQL Foundation — Offline Implementation
- Branch: `codex/phase-2a-postgres-offline`
- Phase 0 baseline: `93eb808e65f8edb1754c1940afe1949e7e18223a`
- Phase 1 baseline: `20b46159078ec533a9891e6768d47595e35b7a7c`
- Active task: P2A-018 — OpenLive legacy importer foundation
- Latest clean commit before this checkpoint: `20b46159078ec533a9891e6768d47595e35b7a7c`
- Provider safety: no real telephone call, WhatsApp message, webhook mutation, or provider provisioning performed

## Baseline verification

The Phase 1 branch was created from the then-current clean HEAD of
`codex/phase-0-audit`, not from a remembered Phase 0 commit.

| Repository | Expected commit | Verified branch | Result |
| --- | --- | --- | --- |
| Target baseline | `93eb808e65f8edb1754c1940afe1949e7e18223a` | `codex/phase-0-audit` | Clean before branching; `AGENTS.md`, `MASTER_PROMPT.md`, and Phase 0 audit documents tracked. |
| Or-on | `cece174f4d590a1b8a283d539dd66e08cc689aa9` | `master` | Commit matched; worktree clean. |
| WACRM | `98b5bd26e8feacacfd4b74ff58411acb8154d212` | `main` | Commit matched; worktree clean. |
| OpenLive | `849173cd1c8c17a95d600b17b428c301722bf5df` | `main` | Commit matched; worktree clean. |

Phase 0 conclusions were rechecked against instructions, manifests, lockfiles,
Docker/deployment configuration, migration documentation, CI, and current code at
the locked commits. The verified conflicts remain: Firebase console identity in
Or-on, Supabase runtime coupling in WACRM, and SQLite/JSON business persistence in
OpenLive. These are required target adaptations; the surrounding working engines
remain preservation candidates.

## Phase 1 tasks

Status values: `pending`, `active`, `complete`, `blocked`.

| ID | Task | Status | Commit | Verification | Notes / next exact task |
| --- | --- | --- | --- | --- | --- |
| P1-001 | Baseline verification | complete | `b859efb` | Clean target baseline; exact upstream SHAs and clean worktrees verified | Baseline recorded above. |
| P1-002 | Technology baseline discovery | complete | `b859efb` | Official registries/docs; Node/pnpm, Python core, and Python voice/native compatibility gates | Baseline selects Node 24 LTS, pnpm 11, Python 3.14, PostgreSQL 18, patched Next/React, and a documented TypeScript 6 fallback. |
| P1-003 | Architecture and ADR framework | complete | `b859efb` | Required architecture documents and ADRs 0001–0015 reviewed; relative-link and sequence checks passed | Accepted decisions distinguish implemented controls from deferred direction. |
| P1-004 | Repository hierarchy | complete | `d380bf8` | Intended roots contain real code/config or a concise ownership README; no empty enterprise scaffold was created | Future directories require real ownership and content. |
| P1-005 | pnpm/TypeScript workspace | complete | `a788acd` | Node 24.20, pnpm 11.24 frozen workspace; strict typecheck, 15 tests, all package builds, and Next production build pass | Keep pnpm as the sole target JS package manager. |
| P1-006 | uv/Python workspace | complete | `30635b9` | uv 0.12.7 sync, all four packages imported/built; Ruff, Pyrefly, and 8 pytest tests passed on Python 3.14.7 | Preserve this runtime boundary when Or-on packages are imported later. |
| P1-007 | Typed configuration | complete | `e616fac` | TypeScript/Python validation, PostgreSQL-only URL checks, redaction, and default-off provider tests passed | Entrypoints inject these settings rather than reading environment variables in business code. |
| P1-008 | PostgreSQL local infrastructure | blocked | `5885b98` | Pinned Compose core, named volume, loopback mapping, role split, health checks, and app containers exist; Docker CLI/daemon unavailable | Install/start Docker and prove PostgreSQL 18.6 healthy without changing repository design. |
| P1-009 | Alembic foundation | blocked | `30635b9` | Exactly one head and deterministic offline PostgreSQL SQL generation passed; no local PostgreSQL daemon exists | Run upgrade/current/`--check-heads` against the Compose database. |
| P1-010 | Contract architecture/proof | complete | `a788acd` | Deterministic FastAPI OpenAPI, generated TypeScript client, versioned JSON Schema event contract, validation tests, and freshness workflow pass | Expand only through versioned language-neutral contracts. |
| P1-011 | Unified web shell | complete | `a788acd` | Next 16.3 production build, render tests, and live browser QA passed; readiness UI reports PostgreSQL outage honestly | Product modules remain clearly marked planned. |
| P1-012 | Python service foundations | complete | `30635b9` | Control API lifecycle/liveness/readiness tests pass; dispatcher and voice entrypoints import with dependency-safe/default-off lifecycle | Later phases integrate retained Or-on packages into these boundaries. |
| P1-013 | TypeScript service foundations | complete | `a788acd` | Live-agent HTTP health/readiness and messaging-worker equivalent health lifecycle build, typecheck, and tests pass | No OpenLive/WACRM business behavior has been ported. |
| P1-014 | Design-system foundation | complete | `a788acd` | Tokens, two themes, focus/reduced-motion rules, eight primitives, and render tests pass | Extend incrementally when real source screens are integrated. |
| P1-015 | Makefile developer workflow | complete | `5885b98` | All required targets route through one cross-platform, provider-safe runner; lint/typecheck/test pass by direct invocation | GNU Make/Docker are absent on this host, so the literal acceptance invocations remain P1-022-blocked. |
| P1-016 | Observability foundation | complete | `a788acd` | Shared structured JSON logging, recursive secret redaction, service/environment fields, and safe health logging conventions pass tests | OpenTelemetry transport/export remains deferred. |
| P1-017 | Security foundation | complete | `d380bf8` | Threat model explicitly separates implemented and planned controls; provider, config-redaction, secret-scan, DB-role, and dependency controls have tests/checks | Re-review before each deferred public/provider/auth capability ships. |
| P1-018 | CI foundation | complete | `5885b98` | Target-only jobs cover frozen TS/Python installs, database migration, contracts, architecture/security, audits, production build, and containers | CI requires no sibling repository or provider/GCP credential. |
| P1-019 | Dependency/prohibited-runtime guards | complete | `5885b98` | 15 Python tests plus repository, secret, and documentation scans pass; package cycles/directions, runtime imports, database images, migration authorities, and sibling references are checked | Audit docs and future one-time importers are deliberately excluded from runtime-import rejection. |
| P1-020 | GCP development architecture | complete | `d380bf8` | One-VM resource contract, Terraform/core-provider constraints, Caddy edge direction, identity/secrets/backup design; no credentials or apply | Resource implementation and cost-bearing actions remain deferred. |
| P1-021 | Documentation consolidation | complete | `d380bf8` | Required documents, relative links, README/runbooks, ADR index, threat model, and Phase 2 entry plan pass automated validation | Keep status claims aligned with implemented controls. |
| P1-022 | Full verification | blocked | — | All non-daemon gates pass; `doctor` accurately fails for missing Docker/Compose/Make and incompatible global Node/pnpm | Install compatible tools/start Docker, then run the literal acceptance sequence and container/database gates. |

## Latest verification snapshot

- Passed on the ignored selected toolchain: Node 24.20.0, pnpm 11.24.0,
  TypeScript strict checks, 15 TypeScript tests, package/service builds, Next.js
  16.3.3 production build, peer check, and zero known pnpm vulnerabilities.
- Passed on uv/Python 3.14.7: Ruff format/lint, Pyrefly, 15 pytest tests,
  deterministic offline migration graph/SQL, and zero known audited Python
  vulnerabilities (local workspace distributions correctly skipped by PyPI audit).
- Passed: contract generation/freshness, browser shell/theme/command/health QA,
  repository/prohibited-dependency scan, secret scan, documentation/link scan, and
  sibling-independence check.
- Blocked: PostgreSQL container health, live Alembic upgrade/current, full Compose
  app health, Dockerfile builds, and literal `make ...` acceptance commands.
- With the ignored compatibility toolchain on `PATH`, `doctor` passed Git 2.54,
  Node 24.20.0, pnpm 11.24.0, uv 0.12.7, and Python 3.14.7. It correctly failed
  only for absent Docker/Compose/daemon and GNU Make. The ordinary global
  Node 25.9.0/pnpm 11.19.0 pair remains outside the selected baseline.

## Known blockers and risks

- Or-on repository licensing/ownership is not recorded in a repository license;
  the target remains private and no Or-on source is imported in Phase 1.
- Several speech/model assets have unresolved redistribution conditions; none are
  downloaded or bundled in Phase 1.
- Docker Engine/Compose and GNU Make are unavailable on this host. Global Node
  25.9.0 and pnpm 11.19.0 are outside the selected Node 24.20/pnpm 11.24 baseline;
  repository-local compatibility runs use ignored pinned toolchains.
- Real provider operations remain prohibited and default-off.

## Next exact task

Mechanically inspect the target and complete locked Or-on Alembic graphs, prove
that the Phase 1 bootstrap revision was never live-applied, and reconcile them
into one canonical lineage before adding any WACRM- or OpenLive-derived schema.

## Phase 2A starting state

Phase 2A began from the current clean Phase 1 HEAD, not from a remembered short
SHA. Docker Engine, Docker Compose, GNU Make, and a live PostgreSQL 18.6 server
remain unavailable. Repository-controlled checks will run offline; all execution
claims that require PostgreSQL remain **PENDING LIVE POSTGRESQL VALIDATION — PHASE
2B**.

| Repository | Expected commit | Verified branch | Result |
| --- | --- | --- | --- |
| Target baseline | `20b46159078ec533a9891e6768d47595e35b7a7c` | `codex/phase-1-foundation` | Clean before branching; Phase 2A branch created from this exact commit. |
| Or-on | `cece174f4d590a1b8a283d539dd66e08cc689aa9` | `master` | Commit matched; worktree clean. |
| WACRM | `98b5bd26e8feacacfd4b74ff58411acb8154d212` | `main` | Commit matched; worktree clean. |
| OpenLive | `849173cd1c8c17a95d600b17b428c301722bf5df` | `main` | Commit matched; worktree clean. |

## Phase 2A tasks

Status values: `pending`, `active`, `complete`, `blocked`.

| ID | Task | Status | Commit | Evidence | Pending live validation / next exact task |
| --- | --- | --- | --- | --- | --- |
| P2A-001 | Baseline and upstream verification | complete | `109bf9e` | Mandatory target, audit, architecture, ADR, target migration, Or-on lineage, WACRM SQL/runtime, and OpenLive persistence sources read; exact clean SHAs verified | No live validation needed; baseline is fixed at Phase 1 `20b4615`. |
| P2A-002 | Inspect target + Or-on Alembic graphs | complete | `4d9a219` | Mechanical metadata: 22 revisions, root `0001`, branch `8eda5976c920`, merge `8aa960fd77ec`, head `a41d2f6c2925` | Continue successors from the preserved head. |
| P2A-003 | Reconcile Phase 1 bootstrap migration | complete | `d67f8f7` | Phase 1 progress proves live upgrade/current were blocked; old revision retained outside active versions and content recreated at generated successor `34376836baf5` | Live upgrade remains pending Phase 2B. |
| P2A-004 | Import/preserve complete Or-on Alembic lineage | complete | `4d9a219` | All 22 revisions imported; IDs/parents/branch/merge/order preserved; three import paths and one offline-only guard documented | Live historical backfill remains pending Phase 2B. |
| P2A-005 | Verify one canonical offline Alembic graph/head | active | pending | Alembic heads/history/branches and deterministic offline SQL pass at generated head `f5e8b540dfeb` | Repeat at final head and record the final SQL digest. |
| P2A-006 | Canonical tenant/identity mapping | complete | `d67f8f7` | Or-on tenant/user/membership preserved; provider-neutral identity bindings and tenant invitations created | RLS/membership execution pending Phase 2B. |
| P2A-007 | Database schema/ownership architecture | complete | `109bf9e` | Historical Or-on tables stay in place; bounded new schemas and owners documented | Catalog execution pending Phase 2B. |
| P2A-008 | WACRM migration inventory | complete | `109bf9e` | All 39 source SQL migrations have explicit disposition; zero unexplained | Keep mapping aligned with generated revisions. |
| P2A-009 | Translate WACRM identity/account semantics | complete | `d67f8f7` | Account→tenant, profile→user, member→membership, provider-neutral bindings/invitations | Membership/RLS execution pending Phase 2B. |
| P2A-010 | Translate WACRM CRM schema | complete | `69004e9` | Generated `a929e3f55c7a`: contacts/identities/tags/fields/notes/pipelines/stages/deals with composite tenant FKs | Constraints/indexes/RLS pending Phase 2B. |
| P2A-011 | Translate WACRM messaging schema | complete | `69004e9` | Generated `2ef8ecd10c3d`: channels/conversations/messages/delivery/reactions/templates/quick replies/broadcasts | Triggers/idempotency/RLS pending Phase 2B. |
| P2A-012 | Translate WACRM pipeline/campaign schema | complete | `69004e9` | Canonical campaign parent coexists with preserved Or-on voice campaigns; messaging broadcast projection references parent | Live claim/aggregate behavior pending Phase 2B. |
| P2A-013 | Translate WACRM automation/flow schema | complete | pending | Generated `cebe5f87cf18`: definitions, immutable published versions, runs, step runs, validation and retry/error metadata | Trigger and RLS execution pending Phase 2B. |
| P2A-014 | Translate WACRM AI/knowledge/database semantics | complete | pending | Generated `cebe5f87cf18`: model metadata, sources/documents/chunks, PostgreSQL FTS GIN, usage records; pgvector is not required | FTS generation/query behavior pending Phase 2B. |
| P2A-015 | Supabase Auth/Realtime/Storage/RPC removal mapping | complete | `109bf9e` | Auth/context, Realtime, Storage, service-role, and every RPC classified | Application adapters remain later-phase work. |
| P2A-016 | OpenLive persistence inventory | complete | pending | Actual SQLite schema/query code, legacy conversation migration, encrypted JSON stores, settings APIs, voice-profile files, browser-local keys, and ACP session references mapped | Keep map aligned with importer coverage. |
| P2A-017 | OpenLive PostgreSQL target schema | complete | pending | Generated `f5e8b540dfeb`: tenant/user-scoped chats, ordered messages, preferences, credential-referenced providers, object-backed voice profiles, and sessions | Constraints/RLS/grants pending Phase 2B. |
| P2A-018 | OpenLive legacy importer foundation | pending | — | — | Offline parser/dry-run/idempotency/checksum tests; writes pending Phase 2B. |
| P2A-019 | Canonical RLS policies for new tenant data | complete | pending | Static fail-closed FORCE RLS policies exist for identity, CRM, messaging, automation, agents, objects, ops, audit, and live tables | **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-020 | Unified runtime roles/grants successor migration | complete | `d67f8f7` | Generated successor defines six roles without privileged attributes and preserves legacy Or-on roles | **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-021 | Inbox/outbox/idempotency foundation | complete | pending | Generated `cebe5f87cf18`: inbound/outbox events and scoped idempotency keys with explicit uniqueness and schedules | Atomicity/deduplication execution pending Phase 2B. |
| P2A-022 | PostgreSQL durable-job foundation | complete | pending | Generated `cebe5f87cf18`: leases, bounded attempts, ready indexes, `SKIP LOCKED` claim, capped retry scheduling, terminal failure | Concurrency/stale lease/retry behavior pending Phase 2B. |
| P2A-023 | Audit/object metadata foundation | complete | pending | Generated `cebe5f87cf18`: metadata-only object records and append-oriented audit records without runtime update/delete grants | Privilege/immutability behavior pending Phase 2B. |
| P2A-024 | Index/constraint/pagination review | active | pending | CRM/messaging query indexes, composite tenant FKs, idempotency uniqueness, and chronological keyset keys defined | Review automation/live/ops additions and validate catalog in Phase 2B. |
| P2A-025 | Type/contract generation updates | pending | — | — | Deterministic consumer-only contracts; no second migration authority. |
| P2A-026 | Offline migration/security guards | pending | — | — | Precise target-SQL and prohibited-runtime dependency checks. |
| P2A-027 | Prepare Phase 2B live PostgreSQL tests | pending | — | — | Collect tests without reporting them as passed. |
| P2A-028 | Database architecture/migration documentation | pending | — | — | Complete data, security, roles, eventing, lineage, and migration maps. |
| P2A-029 | Full offline verification | pending | — | — | Run every repository-controlled check and re-verify upstream integrity. |
