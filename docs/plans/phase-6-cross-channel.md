# Phase 6 — Cross-channel platform

Status: approved scope; implementation starting

Baseline: Phase 5 clean head `946b08a1c418567f56df87cbe17a97b143596a01`

Branch: `codex/phase-6-cross-channel`

## Product outcome

Phase 6 turns the implemented CRM, messaging, automation, and voice foundations
into one governed cross-channel product. An operator can publish a reusable agent
version and canonical flow, execute it through retained voice or messaging
adapters, hand work to a human, and inspect one contact activity and cost trail.

OpenLive, Live Lab, browser-local media, vision, WebGPU models, ACP, and the
desktop wrapper are explicitly deferred to the final integration phase. Phase 6
must not import or implement them. Schema/contracts may reserve a disabled
`openlive` capability identifier, but no executable OpenLive path is permitted.

## Architecture boundaries

- PostgreSQL remains the sole runtime authority; Alembic remains the sole
  migration authority.
- Published agent and flow versions are immutable. Drafts are mutable only
  through authorized, audited commands.
- Provider credentials are opaque references, never profile or flow payloads.
- Canonical graphs compile through thin adapters to retained Or-on voice flows
  and WACRM messaging automations; neither engine is replaced.
- Domain records remain authoritative. A unified activity projection/query does
  not replace messages, calls, deals, campaigns, or automation runs.
- Cross-channel work uses PostgreSQL inbox/outbox/jobs and idempotency keys.
- Real telephone and WhatsApp actions stay disabled. Every acceptance path uses
  the existing simulators.

## Work plan

| ID | Deliverable | Initial status |
| --- | --- | --- |
| P6-001 | Baseline, instruction, upstream-integrity, and scope verification | complete |
| P6-002 | Canonical agent/profile and flow source-parity inventory | active |
| P6-003 | Agent profile/version/channel-capability Alembic model | pending |
| P6-004 | Agent profile validation, publish, RBAC, RLS, and audit | pending |
| P6-005 | Canonical flow draft/version/node/edge contract | pending |
| P6-006 | Flow validation, publishing, immutability, and compatibility checks | pending |
| P6-007 | Or-on voice-flow compiler/adapter | pending |
| P6-008 | WACRM messaging-automation compiler/adapter | pending |
| P6-009 | Cross-channel trigger and execution coordinator | pending |
| P6-010 | Call-outcome-to-WhatsApp simulator workflow | pending |
| P6-011 | WhatsApp-to-CRM-to-call simulator workflow | pending |
| P6-012 | Human handoff and ownership/escalation state | pending |
| P6-013 | Unified contact activity query/projection | pending |
| P6-014 | Unified audit, usage, latency, and cost views | pending |
| P6-015 | Control API and generated TypeScript contracts | pending |
| P6-016 | Unified agent/flow/activity web surfaces | pending |
| P6-017 | Accessibility, Hebrew/RTL, responsive, and keyboard verification | pending |
| P6-018 | PostgreSQL, RLS, idempotency, concurrency, and adapter tests | pending |
| P6-019 | Simulator cross-channel end-to-end acceptance | pending |
| P6-020 | Architecture, provenance, threat model, and runbooks | pending |
| P6-021 | Full verification and clean checkpoint | pending |

## Acceptance gate

Phase 6 is complete only when:

1. One tenant-scoped agent profile can publish immutable versions with explicit
   voice and messaging capabilities.
2. One canonical graph validates and compiles deterministically to both retained
   runtime adapter contracts where its nodes are supported.
3. Unsupported channel nodes fail before publication/execution.
4. Simulated call outcomes can enqueue an idempotent simulated WhatsApp action.
5. A simulated inbound WhatsApp event can update CRM state and enqueue a
   consent/policy-eligible simulated call.
6. Human handoff is authorized, durable, auditable, and race-safe.
7. One contact timeline returns stable cursor-ordered voice, messaging, CRM,
   campaign, automation, and handoff activity without replacing source tables.
8. Usage/cost aggregation is tenant-isolated and excludes secrets/content.
9. Fresh PostgreSQL migration, RLS, constraint, concurrency, and replay tests
   pass; exactly one Alembic head exists.
10. Contracts are deterministic; strict typing, lint, tests, production builds,
    containers, audits, and sibling-independence checks pass.

## Explicit non-goals

- Any OpenLive/Live Lab/visual-agent/browser-media/desktop implementation.
- Real carrier calls, Meta WhatsApp delivery, provider provisioning, or webhook
  mutation.
- Replacing Pipecat, LiveKit, SIP, the Or-on flow engine, or WACRM automation
  behavior.
- GCP deployment, Terraform apply, or production-readiness claims.

