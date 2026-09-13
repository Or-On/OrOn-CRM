# Portable development deployment target

## Decision

The deployment contract is provider-neutral. The repository builds immutable
OCI images and supplies a hardened Docker Compose topology for a single Linux
host. The selected hosting provider, project/account identifiers, registry,
DNS, firewall, secret store, and backup destination are operator concerns and
are intentionally absent from application source.

The deployable runtime contains:

- Caddy as the only public HTTP/TLS edge;
- the Next.js web/BFF service;
- the FastAPI control API;
- PostgreSQL 18.6 as the only runtime database;
- a one-shot Alembic migrator;
- the durable messaging worker, enabled as an explicit profile;
- the voice dispatcher, enabled as an explicit profile when its external
  LiveKit/SIP/provider configuration is complete.

## Portability boundary

Deployment consumes standard inputs only: an HTTPS origin, TLS contact email,
absolute host paths, private environment files, and immutable OCI digest
references. No provider CLI, provider IAM resource, account identifier, or
infrastructure-as-code implementation is required by the repository.

Optional product integrations may still use named third-party APIs. Those are
runtime adapters behind configuration boundaries, not assumptions about where
the platform is hosted.

## Security defaults

- Every real-provider flag defaults to `false`.
- PostgreSQL is reachable only on the private Compose network.
- Application containers run without added privileges, with dropped Linux
  capabilities, read-only filesystems, bounded resources, and rotated logs.
- Secrets are mounted from an operator-owned directory and never stored in
  Compose, image layers, CI artifacts, or source control.
- Schema changes run once through the migrator before application rollout.
- Simulator routes are denied at the public edge outside local development.
- Web and API health checks gate dependent service startup.

## Deployment authority

The repository prepares and verifies artifacts but does not provision a cloud
account, create billable resources, upload secrets, publish images, alter DNS,
or deploy a host. Those actions require a separately reviewed operator plan and
explicit authorization for the selected environment.
