# Infrastructure scope

- Local core is PostgreSQL plus implemented app services; optional profiles must
  not become authoritative state stores.
- Pin images, use health checks, private networks, named volumes, loopback-only
  database ports, non-root app containers where practical, and graceful shutdown.
- Never bake secrets into images or publish PostgreSQL publicly.
- The GCP development target is one Compute Engine VM with Docker Compose.
- Terraform is structure and validation only in Phase 1. Never run `terraform
  apply`, require GCP credentials, or create billable resources.
