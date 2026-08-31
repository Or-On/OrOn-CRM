# Or-On Platform progress

Last updated: 2026-08-31 (Asia/Jerusalem)

## Current checkpoint

- Phase: Phase 1 — Architecture and Monorepo Foundation
- Branch: `codex/phase-1-foundation`
- Phase 0 baseline: `93eb808e65f8edb1754c1940afe1949e7e18223a`
- Active task: P1-004 — Repository hierarchy
- Latest clean commit: `b859efb1da0c96f3c8372623246bb969af063751`
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
| P1-004 | Repository hierarchy | active | — | Layout/ownership check | Create only directories containing Phase 1 code/configuration or an ownership README. |
| P1-005 | pnpm/TypeScript workspace | active | pending workspace commit | pnpm 11.24 lock/install plus initial strict build/typecheck/test passed on Node 24.20 | Add the remaining Phase 1 packages, services, and web app to the workspace. |
| P1-006 | uv/Python workspace | active | pending workspace commit | uv 0.12.7 sync, package import, Ruff, Pyrefly, and pytest passed on Python 3.14.7 | Add the three minimal service members and re-run the workspace-wide gate. |
| P1-007 | Typed configuration | complete | pending workspace commit | TypeScript/Python validation, PostgreSQL-only URL checks, redaction, and default-off provider tests passed | Entrypoints must inject these settings rather than reading environment variables in business code. |
| P1-008 | PostgreSQL local infrastructure | pending | — | Container health/readiness | — |
| P1-009 | Alembic foundation | pending | — | Upgrade/current/heads/check | — |
| P1-010 | Contract architecture/proof | pending | — | Deterministic OpenAPI/client generation | — |
| P1-011 | Unified web shell | pending | — | Render tests and production build | — |
| P1-012 | Python service foundations | pending | — | Imports, lifecycle, health/readiness tests | — |
| P1-013 | TypeScript service foundations | pending | — | Build/typecheck/unit tests | — |
| P1-014 | Design-system foundation | pending | — | Component tests, theme/accessibility checks | — |
| P1-015 | Makefile developer workflow | pending | — | Doctor/bootstrap/dev/verification command checks | — |
| P1-016 | Observability foundation | pending | — | Structured logging/redaction tests | — |
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

Commit the pnpm/uv workspace and shared typed-configuration foundation, then add
PostgreSQL/Alembic infrastructure and minimal service entrypoints.
