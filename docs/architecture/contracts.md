# Contract architecture

## Principles

Cross-language payloads have one authoritative, versioned representation.
Handwritten Python and TypeScript models cannot independently define the same wire
shape.

## HTTP contracts

FastAPI's generated OpenAPI document is authoritative for Python HTTP APIs. The
control API emits a deterministic `openapi.json`; a pinned generator creates the
TypeScript client below `packages/ts/api-client/src/generated/`. CI regenerates to
a temporary path and fails on a diff.

Phase 1 proves:

```text
control-api implementation
  -> deterministic OpenAPI JSON
  -> deterministic generated TypeScript types/client
  -> web system-health consumer
```

The initial contract contains liveness/readiness and version metadata only. It is
not a placeholder CRM API.

HTTP errors use an envelope with a stable code, human message, request ID, and
optional validated details. Internal stack traces and secrets never cross the
boundary.

## Events and WebSocket contracts

Versioned JSON Schema files under `packages/ts/contracts/schemas/` are the
language-neutral source for platform events and future OpenLive live-session
messages. Schema IDs include a stable namespace and major version.

```json
{
  "schema_version": 1,
  "event_id": "uuid",
  "event_type": "platform.system.probe",
  "occurred_at": "RFC3339 timestamp",
  "trace_id": "opaque correlation id",
  "tenant_id": "optional UUID",
  "payload": {}
}
```

Zod validates TypeScript boundaries. Python validates against the same JSON Schema
and may expose generated or thin Pydantic views. The schema, not either language
view, is authoritative.

OpenLive's full discriminated WebSocket protocol is not ported in Phase 1. Later
work versions its verified text/control/frame semantics and preserves the invariant
that raw microphone audio does not cross the socket.

## Compatibility policy

- Additive optional fields are backward-compatible within a major schema version.
- Removing/renaming fields or changing meaning requires a new major version.
- Producers publish a known schema version; consumers reject unsupported majors
  with an actionable error.
- Contract fixtures cover canonical serialization, invalid payloads, and forward
  compatibility.
- Generated code is clearly marked and never manually edited.

## Database consumer contract

`db/contracts/schema-manifest.json` is a deterministic catalog expectation for
tests and non-migration consumers. It records the sole Alembic head, required
schemas/tables/functions/indexes, tenant RLS tables, runtime roles, and extension
classification. `scripts/db_verify.py` compares it to Alembic metadata and
rendered PostgreSQL SQL.

The manifest does not create schema and is not an ORM migration source. No
TypeScript database model is generated in Phase 2A because no TypeScript
repository adapter consumes these tables yet. When one does, generated types
will consume this Alembic-owned schema and receive a freshness check; they will
not gain migration authority.
