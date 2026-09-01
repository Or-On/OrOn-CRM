# PostgreSQL durable eventing and jobs

```mermaid
flowchart LR
  Provider --> Inbox[ops.inbound_events]
  Inbox --> Domain[domain transaction]
  Domain --> Outbox[ops.outbox_events]
  Outbox --> Delivery[worker / WebSocket / webhook adapter]
  Scheduler --> Jobs[ops.jobs]
  Jobs --> Claim[FOR UPDATE SKIP LOCKED]
  Claim --> Domain
```

Inbound provider events are deduplicated by provider/account/event identifiers
before effects. Domain mutations and outbox insertion share one transaction.
Outbox rows are durable; `LISTEN/NOTIFY` may wake a worker but is never the source
of truth. `ops.idempotency_keys` records request scope, request hash, status, and
safe response metadata.

Jobs have bounded attempts, `available_at`, lease owner/time, safe last error,
completion time, and terminal failure state. Claiming is an atomic PostgreSQL
operation using `FOR UPDATE SKIP LOCKED`; stale leases become eligible after the
configured timeout. Retry delay is exponential backoff with bounded jitter and a
maximum attempt count. No infinite retry exists.

Claims and failures require the transaction-local tenant context even though the
functions execute with narrowly scoped definer rights. A missing tenant claims
nothing; a worker cannot claim a different tenant in the same transaction.
Global/null-tenant maintenance work needs a future separately reviewed operator
path and is not claimable through the tenant worker function.

Payloads are JSONB because event/job bodies are versioned, but tenant, type,
status, aggregate/reference IDs, idempotency/provider IDs, and scheduling fields
are normalized and indexed. Secrets and raw credentials are prohibited.

Phase 2B live tests prove atomic claims, concurrent `SKIP LOCKED` workers without
double claims, stale-lease recovery, bounded retry/backoff, terminal failure,
provider/event deduplication, and domain-mutation/outbox rollback atomicity on
PostgreSQL 18.6.
