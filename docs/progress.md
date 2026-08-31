# Or-On Platform progress

Last updated: 2026-08-31 (Asia/Jerusalem)

## Current checkpoint

- Phase: Phase 1 — Architecture and Monorepo Foundation
- Branch: `codex/phase-1-foundation`
- Phase 0 baseline: `93eb808e65f8edb1754c1940afe1949e7e18223a`
- Active task: P1-015 — Makefile developer workflow
- Latest clean commit: `30635b980b4e3abb97a714ec8d17ab21525804bf`
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
| P1-004 | Repository hierarchy | active | `e616fac` | Layout/ownership check begun; no empty placeholder tree created | Complete scripts, CI, security, runbook, and Terraform-owned paths. |
| P1-005 | pnpm/TypeScript workspace | complete | pending web/services commit | Node 24.20, pnpm 11.24 frozen workspace; strict typecheck, 14 tests, all package builds, and Next production build pass | Keep pnpm as the sole target JS package manager. |
| P1-006 | uv/Python workspace | complete | `30635b9` | uv 0.12.7 sync, all four packages imported/built; Ruff, Pyrefly, and 8 pytest tests passed on Python 3.14.7 | Preserve this runtime boundary when Or-on packages are imported later. |
| P1-007 | Typed configuration | complete | `e616fac` | TypeScript/Python validation, PostgreSQL-only URL checks, redaction, and default-off provider tests passed | Entrypoints inject these settings rather than reading environment variables in business code. |
| P1-008 | PostgreSQL local infrastructure | active | `30635b9` | Compose definition and health check added; Docker CLI/daemon unavailable on this host | Complete daemon-backed PostgreSQL 18.6 health proof when Docker is installed. |
| P1-009 | Alembic foundation | active | `30635b9` | Exactly one head and deterministic offline PostgreSQL SQL generation passed | Run upgrade/current/check against the Compose PostgreSQL instance. |
| P1-010 | Contract architecture/proof | complete | pending web/services commit | Deterministic FastAPI OpenAPI, generated TypeScript client, versioned JSON Schema event contract, validation tests, and freshness workflow pass | Expand only through versioned language-neutral contracts. |
| P1-011 | Unified web shell | complete | pending web/services commit | Next 16.3 production build, render tests, and live browser QA passed; readiness UI reports PostgreSQL outage honestly | Product modules remain clearly marked planned. |
| P1-012 | Python service foundations | complete | `30635b9` | Control API lifecycle/liveness/readiness tests pass; dispatcher and voice entrypoints import with dependency-safe/default-off lifecycle | Later phases integrate retained Or-on packages into these boundaries. |
| P1-013 | TypeScript service foundations | complete | pending web/services commit | Live-agent HTTP health/readiness and messaging-worker equivalent health lifecycle build, typecheck, and tests pass | No OpenLive/WACRM business behavior has been ported. |
| P1-014 | Design-system foundation | complete | pending web/services commit | Tokens, two themes, focus/reduced-motion rules, eight primitives, and render tests pass | Extend incrementally when real source screens are integrated. |
| P1-015 | Makefile developer workflow | pending | — | Doctor/bootstrap/dev/verification command checks | — |
| P1-016 | Observability foundation | complete | pending web/services commit | Shared structured JSON logging, recursive secret redaction, service/environment fields, and safe health logging conventions pass tests | OpenTelemetry transport/export remains deferred. |
| P1-017 | Security foundation | pending | — | Threat model and implemented-control tests | — |
| P1-018 | CI foundation | pending | — | Workflow/static validation | — |
| P1-019 | Dependency/prohibited-runtime guards | pending | — | Guard fixtures and repository scan | — |
| P1-020 | GCP development architecture | pending | — | Terraform format/validate where available; no apply | — |
| P1-021 | Documentation consolidation | pending | — | Link/content/command review | — |
| P1-022 | Full verification | pending | — | Complete Phase 1 acceptance gate | — |

## Known blockers and risks

- Or-on repository licensing/ownership is not recorded in a repository license;
  the target remains private and no Or-on source is imported in Phase 1.
- Several speech/model assets have unresolved redistribution conditions; none are
  downloaded or bundled in Phase 1.
- Real provider operations remain prohibited and default-off.

## Next exact task

Commit the contract/service/web foundation, then implement the idempotent Makefile
workflow, repository guards, CI, security documentation, and final runbooks.
