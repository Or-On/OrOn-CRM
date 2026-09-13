# Architecture decision records

ADRs use four-digit sequence numbers and lowercase kebab-case names:
`NNNN-short-decision-title.md`.

Statuses: Proposed, Accepted, Superseded, Rejected. An accepted direction may
state that implementation is deferred; that is not evidence the control exists.

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-modular-monolith-specialized-runtimes.md) | Modular monolith plus specialized runtimes | Accepted |
| [0002](0002-postgresql-only-runtime-persistence.md) | PostgreSQL-only runtime persistence | Accepted |
| [0003](0003-alembic-single-migration-authority.md) | Alembic as single migration authority | Accepted |
| [0004](0004-canonical-identity-and-postgresql-rls.md) | Canonical identity and PostgreSQL RLS direction | Accepted, implementation deferred |
| [0005](0005-http-event-contract-architecture.md) | HTTP and event contract architecture | Accepted |
| [0006](0006-postgresql-durable-jobs.md) | PostgreSQL inbox/outbox/durable jobs | Accepted, implementation deferred |
| [0007](0007-canonical-flow-graph.md) | Canonical flow graph | Accepted, implementation deferred |
| [0008](0008-unified-agent-profile.md) | Unified agent profile | Accepted, implementation deferred |
| [0009](0009-object-media-storage.md) | Object and media storage | Accepted, implementation deferred |
| [0010](0010-portable-single-host-development-target.md) | Portable single-host development target | Accepted |
| [0011](0011-authentication-selection-process.md) | Authentication selection process | Accepted, selection deferred |
| [0012](0012-secrets-management.md) | Secrets management | Accepted |
| [0013](0013-technology-preservation-modernization.md) | Technology preservation and modernization | Accepted |
| [0014](0014-pnpm-workspace-strategy.md) | pnpm workspace strategy | Accepted |
| [0015](0015-ui-design-system.md) | Unified UI design system | Accepted |
| [0016](0016-canonical-application-authentication.md) | Canonical application authentication | Accepted |

## Template

```markdown
# ADR NNNN: Title

- Status: Proposed
- Date: YYYY-MM-DD
- Owners: Architecture

## Context

## Decision

## Consequences

## Verification
```
