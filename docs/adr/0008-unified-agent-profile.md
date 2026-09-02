# ADR 0008: Unified agent profile

- Status: Accepted; Phase 6 foundation implemented
- Date: 2026-08-31
- Owners: Product architecture

## Context

The three sources describe agents with different configuration shapes and
channel-specific assumptions. Keeping unrelated top-level agent records would
fragment identity, governance, publishing, and audit history. Flattening all
channel behavior into one mutable JSON document would make safe evolution equally
difficult.

## Decision

Define a canonical Agent Profile with immutable Agent Profile Versions and explicit
Channel Capabilities. A version may reference prompts, models, tool permissions,
knowledge, locale, voice, WhatsApp, telephony, OpenLive, and escalation behavior.
Provider credentials are referenced by opaque secret IDs and never embedded in a
profile document.

Retained voice and messaging engines receive thin adapters from a published
profile version in Phase 6. OpenLive receives its adapter only in the final
integration phase. Phase 1 defined the direction only; it did not create the
final persistence schema or replace source agent implementations.

## Consequences

Published executions can be reproduced against immutable configuration while
channel adapters retain proven behavior. Capability validation must reject a
profile whose requested behavior is unsupported by a channel.

## Verification

Phase 6 live PostgreSQL tests cover tenant RLS, channel constraints, and
published-version immutability. Cross-channel compiler tests prove the voice and
messaging adapter shapes. OpenLive capability and execution remain deferred.
