# ADR 0014: pnpm workspace strategy

- Status: Accepted
- Date: 2026-08-31
- Owners: Developer experience

## Context

OpenLive already uses a pnpm-compatible multi-package shape while WACRM uses npm.
The unified target needs one deterministic JavaScript dependency graph without
maintaining competing lockfiles. It does not yet have measured orchestration or
remote-cache pressure.

## Decision

Use pnpm as the sole target JavaScript/TypeScript package manager and commit one
`pnpm-lock.yaml`. Define packages through `pnpm-workspace.yaml`; use strict
TypeScript project/package boundaries and explicit scripts. WACRM will later be
adapted to this workspace without rewriting its behavior.

Do not introduce npm, Yarn, or Bun as another target package manager. Do not make
Turborepo mandatory in Phase 1. If repository scale later demonstrates a caching
or orchestration need, evaluate Turborepo with measurements and a separate ADR.

## Consequences

CI uses frozen pnpm installs and developers require the selected pnpm version.
Workspace-native commands remain transparent at current scale.

## Verification

Frozen install, lockfile freshness, recursive build/lint/typecheck/test, and
sibling-independence checks.
