# ADR 0005: HTTP and event contract architecture

- Status: Accepted
- Date: 2026-08-31
- Owners: Architecture

## Context

Python and TypeScript runtimes need shared payloads. Duplicated handwritten models
will drift, while gRPC is not justified for the current browser/BFF/service shape.

## Decision

FastAPI OpenAPI is authoritative for Python HTTP services and generates the
TypeScript client/types. Versioned JSON Schema is authoritative for platform
events and future OpenLive WebSocket messages. Zod and Pydantic validate language
boundaries against the shared source.

Contracts define stable error envelopes and correlation IDs. Generated code lives
in marked directories and freshness checks fail on drift.

## Consequences

Generation tooling becomes part of normal verification. Breaking wire changes
need a major schema/API version and migration window. OpenLive's full protocol is
adapted later rather than reconstructed in Phase 1.

## Verification

Deterministic generation tests, checked-in client diff, schema fixtures, and a web
consumer of the control-api health contract.
