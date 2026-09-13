# Infrastructure scope

- Local core is PostgreSQL plus implemented app services; optional profiles must
  not become authoritative state stores.
- Pin images, use health checks, private networks, named volumes, loopback-only
  database ports, non-root app containers where practical, and graceful shutdown.
- Never bake secrets into images or publish PostgreSQL publicly.
- Deployment artifacts must remain hosting-provider neutral: standard OCI
  images, Docker Compose, HTTPS, PostgreSQL, and externally supplied secrets.
- Never provision infrastructure, publish images, alter DNS, or create billable
  resources without a separately reviewed plan and explicit authorization.
