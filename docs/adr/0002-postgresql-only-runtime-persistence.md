# ADR 0002: PostgreSQL-only runtime persistence

- Status: Accepted
- Date: 2026-08-31
- Owners: Database architecture

## Context

Or-on uses PostgreSQL, WACRM depends on Supabase's PostgreSQL services, and
OpenLive persists business state in SQLite/JSON/browser storage. Multiple runtime
stores would prevent canonical tenancy, transactions, audit, backup, and RLS.

## Decision

PostgreSQL is the only authoritative target runtime database for all application
state. WACRM's valid PostgreSQL concepts are adapted without Supabase runtime
services. OpenLive persistence moves behind PostgreSQL adapters. SQLite may exist
only in a future one-time importer dependency graph.

Object bytes and model caches are not business databases: bytes use local/GCS
storage with PostgreSQL metadata; disposable browser model caches may remain local.
Redis is LiveKit infrastructure or cache only.

## Consequences

Every service shares one cluster/database through least-privilege roles. Imports
must be idempotent and source-aware. Runtime dependency guards reject alternate
database clients while allowing audited docs and isolated importer code.

## Verification

Manifest/import guard, one `DATABASE_URL` architecture check, Compose inspection,
and later PostgreSQL integration/RLS tests.
