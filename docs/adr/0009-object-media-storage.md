# ADR 0009: Object and media storage

- Status: Accepted architectural direction; implementation deferred
- Date: 2026-08-31
- Owners: Data architecture

## Context

Recordings, uploads, media attachments, and model assets can be large. Storing
their bytes in ordinary PostgreSQL rows would inflate backups and interfere with
transactional workloads, while storing only filesystem paths would lose
authoritative ownership and retention metadata.

## Decision

PostgreSQL is authoritative for object metadata: object ID, tenant, owner or
reference, MIME type, byte size, checksum, storage key, retention state, and
timestamps. Bytes use a mounted local object directory in local development and a
private Google Cloud Storage bucket in the future GCP development environment.

Access goes through a storage port with tenant authorization. Storage keys are
opaque and non-authoritative; database records govern lifecycle. Supabase Storage
is not a target dependency. Phase 1 does not implement media handling.

## Consequences

Database restores and object restores need a coordinated reconciliation runbook.
Checksums permit integrity checks. Signed access must be brief, scoped, and
audited when later introduced.

## Verification

Future metadata constraints, tenant authorization, checksum, retention, orphan
reconciliation, and backup/restore tests.
