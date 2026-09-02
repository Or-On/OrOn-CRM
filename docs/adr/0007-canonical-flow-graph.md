# ADR 0007: Canonical flow graph

- Status: Accepted; Phase 6 foundation implemented
- Date: 2026-08-31
- Owners: Product architecture

## Context

Or-on has a mature typed Pipecat voice-flow runtime/editor. WACRM has mature
messaging automation and flow runtimes/editors. Replacing either would risk working
behavior; presenting both definitions would fragment the product.

## Decision

Expose one user-facing versioned flow graph with schema version, typed nodes and
ports, typed edges, validation, drafts, immutable published versions, execution
traces, retry/error policy, and channel capabilities. Compile/adapt the canonical
graph to retained Or-on voice and WACRM messaging runtimes.

Do not delete or rewrite either engine until parity fixtures prove the canonical
contract covers its supported behavior.

## Consequences

Phase 6 persists the canonical contract and deterministic compiled adapters in
the existing Alembic-owned `automation.flow_*` lineage. The retained engines
remain execution authorities. A richer visual editor is deferred; Phase 6 ships
a bounded authoring template and validation API rather than rewriting either
source editor.

## Verification

TypeScript and Python contract fixtures, immutable PostgreSQL versions, replay
tests, simulator workflows, and the generated OpenAPI client are required gates.
