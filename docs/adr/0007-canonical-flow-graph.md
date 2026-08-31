# ADR 0007: Canonical flow graph

- Status: Accepted architectural direction; implementation deferred
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

Phase 1 defines direction only. Phase 7 owns the complete model/adapters. UI editor
selection remains evidence-based and can reuse both source component sets.

## Verification

Future source fixture compilers, graph validation tests, and cross-channel E2E.
