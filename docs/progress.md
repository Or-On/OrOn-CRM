# Or-On Platform progress

Last updated: 2026-09-01 (Asia/Jerusalem)

## Current checkpoint

- Phase: Phase 2B — Canonical PostgreSQL Foundation — Live Validation
- Branch: `codex/phase-2b-postgres-live`
- Phase 0 baseline: `93eb808e65f8edb1754c1940afe1949e7e18223a`
- Phase 1 baseline: `20b46159078ec533a9891e6768d47595e35b7a7c`
- Phase 2A status: **OFFLINE IMPLEMENTATION COMPLETE**
- Live status: **PHASE 2B AUTOMATED CORE GATE PASSED — EXTENDED VALIDATION IN PROGRESS**
- Active task: P2B-008 — extended downgrade/backfill/import/constraint validation
- Phase 2B clean baseline commit: `830a8371836ea7922fca5c320624bf3bd32ec229`
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
| P1-008 | PostgreSQL local infrastructure | complete | `009357e` | PostgreSQL 18.6 named volume, loopback mapping, role bootstrap, health check, control API, and web Compose chain are healthy | Preserve the named development volume; use separate disposable databases for integration tests. |
| P1-009 | Alembic foundation | complete | `009357e` | Fresh PostgreSQL upgrade of all 27 revisions and `current --check-heads` pass at sole head `f5e8b540dfeb` | Extended downgrade and non-empty historical backfill validation remains Phase 2B work. |
| P1-010 | Contract architecture/proof | complete | `a788acd` | Deterministic FastAPI OpenAPI, generated TypeScript client, versioned JSON Schema event contract, validation tests, and freshness workflow pass | Expand only through versioned language-neutral contracts. |
| P1-011 | Unified web shell | complete | `a788acd` | Next 16.3 production build, render tests, and live browser QA passed; readiness UI reports PostgreSQL outage honestly | Product modules remain clearly marked planned. |
| P1-012 | Python service foundations | complete | `30635b9` | Control API lifecycle/liveness/readiness tests pass; dispatcher and voice entrypoints import with dependency-safe/default-off lifecycle | Later phases integrate retained Or-on packages into these boundaries. |
| P1-013 | TypeScript service foundations | complete | `a788acd` | Live-agent HTTP health/readiness and messaging-worker equivalent health lifecycle build, typecheck, and tests pass | No OpenLive/WACRM business behavior has been ported. |
| P1-014 | Design-system foundation | complete | `a788acd` | Tokens, two themes, focus/reduced-motion rules, eight primitives, and render tests pass | Extend incrementally when real source screens are integrated. |
| P1-015 | Makefile developer workflow | complete | `009357e` | All targets route through one provider-safe runner; bootstrap, migration, live DB, verify, Compose, and container paths pass through the underlying runner | GNU Make remains absent, so literal `make ...` spelling is the only outstanding command-surface check. |
| P1-016 | Observability foundation | complete | `a788acd` | Shared structured JSON logging, recursive secret redaction, service/environment fields, and safe health logging conventions pass tests | OpenTelemetry transport/export remains deferred. |
| P1-017 | Security foundation | complete | `d380bf8` | Threat model explicitly separates implemented and planned controls; provider, config-redaction, secret-scan, DB-role, and dependency controls have tests/checks | Re-review before each deferred public/provider/auth capability ships. |
| P1-018 | CI foundation | complete | `5885b98` | Target-only jobs cover frozen TS/Python installs, database migration, contracts, architecture/security, audits, production build, and containers | CI requires no sibling repository or provider/GCP credential. |
| P1-019 | Dependency/prohibited-runtime guards | complete | `5885b98` | 15 Python tests plus repository, secret, and documentation scans pass; package cycles/directions, runtime imports, database images, migration authorities, and sibling references are checked | Audit docs and future one-time importers are deliberately excluded from runtime-import rejection. |
| P1-020 | GCP development architecture | complete | `d380bf8` | One-VM resource contract, Terraform/core-provider constraints, Caddy edge direction, identity/secrets/backup design; no credentials or apply | Resource implementation and cost-bearing actions remain deferred. |
| P1-021 | Documentation consolidation | complete | `d380bf8` | Required documents, relative links, README/runbooks, ADR index, threat model, and Phase 2 entry plan pass automated validation | Keep status claims aligned with implemented controls. |
| P1-022 | Full verification | blocked | `009357e` | Runtime/database/container gates and consolidated verification pass; doctor passes Docker/daemon and accepts Compose 5 after a compatibility fix | Install GNU Make and run the literal `make ...` sequence; selected Node/pnpm remain repository-local. |

## Phase 1 runtime verification snapshot

- Passed on the ignored selected toolchain: Node 24.20.0, pnpm 11.24.0,
  TypeScript strict checks, 15 TypeScript tests, package/service builds, Next.js
  16.3.3 production build, peer check, and zero known pnpm vulnerabilities.
- Passed on uv/Python 3.14.7: Ruff format/lint, Pyrefly, 15 pytest tests,
  deterministic offline migration graph/SQL, and zero known audited Python
  vulnerabilities (local workspace distributions correctly skipped by PyPI audit).
- Passed: contract generation/freshness, browser shell/theme/command/health QA,
  repository/prohibited-dependency scan, secret scan, documentation/link scan, and
  sibling-independence check.
- Passed with Docker Desktop 4.89.0 / Engine 29.7.2 / Compose 5.5.0:
  PostgreSQL 18.6 health, live Alembic upgrade/current, idempotent seed,
  control-api readiness, both production Dockerfiles, and the full Compose core
  health chain including web-to-control-api calls.
- With the ignored compatibility toolchain on `PATH`, `doctor` passed Git 2.54,
  Docker/daemon, Node 24.20.0, pnpm 11.24.0, uv 0.12.7, and Python 3.14.7.
  Compose 5 is accepted as compatible with the v2-or-newer command surface.
  It correctly fails only for absent GNU Make. The ordinary global
  Node 25.9.0/pnpm 11.19.0 pair remains outside the selected baseline.

## Known blockers and risks

- Or-on repository licensing/ownership is not recorded in a repository license;
  the target remains private and no Or-on source is imported in Phase 1.
- Several speech/model assets have unresolved redistribution conditions; none are
  downloaded or bundled in Phase 1.
- GNU Make is unavailable on this host. Docker Engine/Compose are healthy.
  Global Node 25.9.0 and pnpm 11.19.0 are outside the selected Node 24.20/pnpm
  11.24 baseline; repository-local compatibility runs use ignored pinned
  toolchains.
- Real provider operations remain prohibited and default-off.

## Phase 1 handoff completed by Phase 2A

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
| P2A-005 | Verify one canonical offline Alembic graph/head | complete | `363189f` | 27 revisions; sole root `0001`, branch point `8eda5976c920`, sole head `f5e8b540dfeb`; deterministic SQL/static contract pass | Fresh live upgrade/current **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-006 | Canonical tenant/identity mapping | complete | `d67f8f7` | Or-on tenant/user/membership preserved; provider-neutral identity bindings and tenant invitations created | RLS/membership execution pending Phase 2B. |
| P2A-007 | Database schema/ownership architecture | complete | `109bf9e` | Historical Or-on tables stay in place; bounded new schemas and owners documented | Catalog execution pending Phase 2B. |
| P2A-008 | WACRM migration inventory | complete | `109bf9e` | All 39 source SQL migrations have explicit disposition; zero unexplained | Keep mapping aligned with generated revisions. |
| P2A-009 | Translate WACRM identity/account semantics | complete | `d67f8f7` | Account→tenant, profile→user, member→membership, provider-neutral bindings/invitations | Membership/RLS execution pending Phase 2B. |
| P2A-010 | Translate WACRM CRM schema | complete | `69004e9` | Generated `a929e3f55c7a`: contacts/identities/tags/fields/notes/pipelines/stages/deals with composite tenant FKs | Constraints/indexes/RLS pending Phase 2B. |
| P2A-011 | Translate WACRM messaging schema | complete | `69004e9` | Generated `2ef8ecd10c3d`: channels/conversations/messages/delivery/reactions/templates/quick replies/broadcasts | Triggers/idempotency/RLS pending Phase 2B. |
| P2A-012 | Translate WACRM pipeline/campaign schema | complete | `69004e9` | Canonical campaign parent coexists with preserved Or-on voice campaigns; messaging broadcast projection references parent | Live claim/aggregate behavior pending Phase 2B. |
| P2A-013 | Translate WACRM automation/flow schema | complete | `42c21ad` | Generated `cebe5f87cf18`: definitions, immutable published versions, runs, step runs, validation and retry/error metadata | Trigger and RLS execution pending Phase 2B. |
| P2A-014 | Translate WACRM AI/knowledge/database semantics | complete | `42c21ad` | Generated `cebe5f87cf18`: model metadata, sources/documents/chunks, PostgreSQL FTS GIN, usage records; pgvector is not required | FTS generation/query behavior pending Phase 2B. |
| P2A-015 | Supabase Auth/Realtime/Storage/RPC removal mapping | complete | `109bf9e` | Auth/context, Realtime, Storage, service-role, and every RPC classified | Application adapters remain later-phase work. |
| P2A-016 | OpenLive persistence inventory | complete | `75aa1a2` | Actual SQLite schema/query code, legacy conversation migration, encrypted JSON stores, settings APIs, voice-profile files, browser-local keys, and ACP session references mapped | Keep map aligned with importer coverage. |
| P2A-017 | OpenLive PostgreSQL target schema | complete | `75aa1a2` | Generated `f5e8b540dfeb`: tenant/user-scoped chats, ordered messages, preferences, credential-referenced providers, object-backed voice profiles, and sessions | Constraints/RLS/grants pending Phase 2B. |
| P2A-018 | OpenLive legacy importer foundation | complete | `55bdd64` | Explicit SQLite/JSON sources; deterministic UUID mapping/checksums, duplicate/conflict handling, secret-safe dry-run, canonical PostgreSQL writer, six fixture/unit tests | Importer writes/idempotency ledger execution **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-019 | Canonical RLS policies for new tenant data | complete | `75aa1a2` | Static fail-closed FORCE RLS policies exist for identity, CRM, messaging, automation, agents, objects, ops, audit, and live tables | **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-020 | Unified runtime roles/grants successor migration | complete | `d67f8f7` | Generated successor defines six roles without privileged attributes and preserves legacy Or-on roles | **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-021 | Inbox/outbox/idempotency foundation | complete | `42c21ad` | Generated `cebe5f87cf18`: inbound/outbox events and scoped idempotency keys with explicit uniqueness and schedules | Atomicity/deduplication execution pending Phase 2B. |
| P2A-022 | PostgreSQL durable-job foundation | complete | `363189f` | Generated `cebe5f87cf18`: tenant-bound SECURITY DEFINER claims, leases, bounded attempts, `SKIP LOCKED`, exponential backoff+jitter, terminal failure | Concurrency/stale lease/retry behavior pending Phase 2B. |
| P2A-023 | Audit/object metadata foundation | complete | `42c21ad` | Generated `cebe5f87cf18`: metadata-only object records and append-oriented audit records without runtime update/delete grants | Privilege/immutability behavior pending Phase 2B. |
| P2A-024 | Index/constraint/pagination review | complete | `363189f` | Manifest checks 14 critical indexes; migrations define composite tenant FKs, E.164/provider/idempotency uniqueness, explicit deletes, and chronological keyset indexes | Constraint/index catalog and query-plan behavior pending Phase 2B. |
| P2A-025 | Type/contract generation updates | complete | `363189f` | `db/contracts/schema-manifest.json` is a checked consumer catalog at head `f5e8b540dfeb`; existing OpenAPI/event generation remains fresh; no TS migration authority added | Generate DB types only when a real TS repository consumes them. |
| P2A-026 | Offline migration/security guards | complete | `363189f` | Graph/parent/one-head, deterministic SQL, RLS/FORCE/policy, index, extension, definer search-path, Supabase/public/privileged-role guards | Live catalog behavior pending Phase 2B. |
| P2A-027 | Prepare Phase 2B live PostgreSQL tests | complete | `363189f` | 18 collected PostgreSQL tests cover version/head/catalog/roles/RLS/tenant CRUD/domain grants/DDL/idempotency/FK/outbox/flows/FTS/jobs/importer/seed | All 18 are **PENDING LIVE POSTGRESQL VALIDATION — PHASE 2B**. |
| P2A-028 | Database architecture/migration documentation | complete | `a311371` | Required architecture, lineage, WACRM/OpenLive maps, schema ownership, extension inventory, notices, and Phase 2B runbook pass the documentation/link guard | Maintain claims as Phase 2B evidence arrives. |
| P2A-029 | Full offline verification | complete | `a311371` | Dedicated offline gate, all Python/TS checks/tests/build, contracts, repository/secret/docs guards, and final upstream integrity pass | Live/database execution checks remain Phase 2B only. |

## Phase 2A final offline verification snapshot

- Alembic: 27 active revisions, sole root `0001`, preserved Or-on branch point
  `8eda5976c920`, merge `8aa960fd77ec`, sole head `f5e8b540dfeb`.
- Deterministic PostgreSQL SQL: 93,287 UTF-8 bytes, SHA-256
  `3d20637313b3471050fe5818949f349a65e97297bc8f380a3a3ead2c22574778`.
- Dedicated `db-verify-offline`: 15/15 focused graph/importer/static-contract
  tests passed, repository dependency guard passed, wire contracts fresh.
- Full Python: Ruff format/lint passed; Pyrefly passed for current packages,
  services, importers, tests, Alembic environment/compatibility code, seeds, and
  scripts; 29 tests passed and 18 PostgreSQL tests were correctly skipped with
  the Phase 2B status.
- Full TypeScript: format/lint/strict typecheck passed; 15 tests passed; all
  packages/services and the Next.js 16.3.3 production application built.
- Security/architecture: tracked-file secret scan, prohibited runtime database
  scan, sibling-independence scan, documentation/link scan, and peer dependency
  check passed.
- Vulnerability registry refresh: npm and PyPI advisory endpoints were blocked by
  this sandbox. Phase 2A changed no dependency manifest or lock version; the last
  Phase 1 scans were clean. CI retains both scans, so no fresh clean result is
  claimed for this run.
- Provider/cloud safety: no WhatsApp message, telephone call, provider webhook
  mutation, provider provisioning, customer-data access, or `terraform apply`.
- Final upstream check: Or-on, WACRM, and OpenLive remained clean at their locked
  SHAs.

At the Phase 2A checkpoint every server-executed item in
[`docs/migration/phase-2b-live-validation.md`](migration/phase-2b-live-validation.md)
was pending. The Phase 2B evidence below supersedes that historical status.

## Phase 2B live validation

Phase 2B branched from the clean Phase 2A head
`830a8371836ea7922fca5c320624bf3bd32ec229`. Validation used Docker Desktop
4.89.0, Engine 29.7.2, Compose 5.5.0, and the pinned PostgreSQL 18.6 Bookworm
image. The development database remains on its named volume; integration runs
used separate disposable databases.

| ID | Task | Status | Commit | Evidence | Remaining work |
| --- | --- | --- | --- | --- | --- |
| P2B-001 | Docker/toolchain readiness | complete | `009357e` | Engine/daemon and ports passed; doctor now accepts the Compose v2-or-newer command surface, including installed Compose 5.5 | Install GNU Make for literal `make ...` acceptance spelling. |
| P2B-002 | Fresh migration and catalog | complete | `009357e` | Multiple empty PostgreSQL 18.6 databases upgraded through all 27 revisions to sole head `f5e8b540dfeb`; catalog/extensions/functions/indexes checked | Downgrade and non-empty `0004` backfill remain P2B-008. |
| P2B-003 | Seed and readiness | complete | `009357e` | JSONB seed fixed and proven idempotent; least-privilege `platform_web` readiness succeeds | None for the implemented seed. |
| P2B-004 | Roles and RLS automated suite | complete | `009357e` | Runtime attributes, FORCE RLS, missing context, cross-tenant CRUD, membership, `SET LOCAL`, role separation, DDL denial, and audit immutability passed | Broaden policy fixtures as new domain operations arrive. |
| P2B-005 | Integrity/concurrency/importer suite | complete | `009357e` | Provider/message/E.164 idempotency, FK restrict/cascade, outbox rollback, immutable flow versions, FTS, concurrent `SKIP LOCKED`, lease recovery/retry/dead state, seed, and OpenLive JSON import passed | SQLite write path, WACRM import, full constraint matrix, and keyset query execution remain P2B-008. |
| P2B-006 | Full core runtime | complete | `009357e` | PostgreSQL, control API, and web containers are healthy; host API and web BFF both report PostgreSQL ready; all ports are loopback-bound | GNU Make remains a host-tool gap only. |
| P2B-007 | Consolidated verification | complete | `009357e` | Format, lint, strict typing, 31 offline tests, 18 live PostgreSQL tests, 15 TS tests, contracts, production builds, container builds, guards, peer check, pnpm audit, and pip-audit passed | Keep CI evidence separate until the remote workflow runs. |
| P2B-008 | Extended database acceptance | active | pending | Automated core gate is green | Execute supported downgrade/re-upgrade boundaries, non-empty encrypted `0004` backfill, complete constraint/delete matrix, keyset pagination, SQLite importer writes, and WACRM importer idempotency. |

Live validation exposed and fixed four real integration issues: the seed passed
an invalid JSONB literal, the legacy importer passed timestamp strings instead
of timezone-aware values, the control API bound only to container loopback, and
the local runner allowed an unrelated ambient `DATABASE_URL` to override the
repository `.env`. The unsafe ambient endpoint returned unavailable; no external
schema or data mutation was performed. The runner now gives the explicit local
file precedence and provider flags remain false.

## Next exact task

Complete P2B-008 against disposable PostgreSQL databases, then install GNU Make
and execute the literal Phase 1 command surface. Do not begin Phase 3 until the
remaining Phase 2B items are either passed or explicitly deferred with evidence.
