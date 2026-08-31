# ADR 0006: PostgreSQL inbox, outbox, and durable jobs

- Status: Accepted architectural direction; implementation deferred
- Date: 2026-08-31
- Owners: Architecture and SRE

## Context

WACRM mixes request-time/background/cron work, Or-on has campaign claiming, and
OpenLive holds interactive process state. Provider actions require durability and
idempotency, but the development topology does not justify Kafka or RabbitMQ.

## Decision

Use PostgreSQL inbox, outbox, and job tables with provider-event uniqueness,
idempotency keys, `SKIP LOCKED`, leases, retry counts, exponential backoff with
jitter, next-attempt timestamps, terminal/dead-letter state, and trace IDs.
Advisory locks may protect singleton schedules. `LISTEN/NOTIFY` may wake workers
but is never the durable record.

## Consequences

Messaging and automation work survives process restarts and shares transactions
with business changes. Database load and worker concurrency must be measured.
Redis remains non-authoritative.

## Verification

Phase 2/4 concurrency, crash, idempotency, replay, retry, and dead-letter tests.
