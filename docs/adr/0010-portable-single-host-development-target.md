# ADR 0010: Portable single-host development target

- Status: accepted; supersedes the earlier provider-specific deployment target
- Date: 2026-09-13

## Context

The platform needs a production-shaped development environment without making
the application repository depend on the eventual hosting account or provider.

## Decision

Build standard OCI images and run the first development deployment on one Linux
host with Docker Compose, Caddy, PostgreSQL 18.6, the web and API services, and
explicit worker/voice profiles. Deployment accepts immutable image digests,
absolute persistent paths, an HTTPS origin, and private external configuration.

Hosting IAM, registry configuration, DNS, firewalls, secret delivery, backups,
and resource provisioning stay outside the application source and require a
separate operator plan.

## Consequences

- The same release artifacts can run on any compatible container host.
- Application verification does not require hosting credentials.
- Optional product provider adapters remain available but cannot determine the
  platform's hosting topology.
- A live environment is not considered accepted until its own TLS, backup,
  restore, monitoring, provider, RBAC, and tenant-isolation checks pass.
