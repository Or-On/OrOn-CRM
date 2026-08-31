# ADR 0010: Single GCP VM development target

- Status: Accepted architectural direction; implementation deferred
- Date: 2026-08-31
- Owners: Platform engineering

## Context

The development environment needs realistic networking, persistent PostgreSQL,
provider callback routing, and reproducible deployment without premature cluster
operations. Kubernetes, GKE, Cloud Run, service mesh, or multiple application VMs
would add cost and operational surfaces before scale requires them.

## Decision

Target one Google Compute Engine VM running Docker Compose, with a reserved IP,
persistent SSD for PostgreSQL, Artifact Registry, private GCS object and backup
buckets, Secret Manager, a least-privilege VM identity, and Workload Identity
Federation for CI. Caddy is the candidate single public TLS origin and HTTP/
WebSocket reverse proxy. Cloud SQL is a documented future migration option, not a
Phase 1 dependency.

Terraform in Phase 1 supplies constraints, structure, and documentation only.
`terraform apply` is prohibited during this phase and verification requires no
GCP credentials.

## Consequences

The target is intentionally a development topology, not a high-availability
production claim. VM loss, persistent-disk recovery, PostgreSQL backup restore,
and secret rotation require runbooks before external use.

## Verification

Static Terraform formatting/validation where tooling is available, Compose
configuration validation, and an explicit no-apply record.
