# ADR 0008: Unified agent profile

- Status: Accepted architectural direction; implementation deferred
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

Retained voice, messaging, and live-agent engines receive thin adapters from a
published profile version. Phase 1 defines the direction only; it does not create
the final persistence schema or replace source agent implementations.

## Consequences

Published executions can be reproduced against immutable configuration while
channel adapters retain proven behavior. Capability validation must reject a
profile whose requested behavior is unsupported by a channel.

## Verification

Future schema-version, immutability, capability-validation, secret-reference, and
adapter parity tests.
