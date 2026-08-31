# Local Compose topology

`compose.yaml` declares the `core` profile: PostgreSQL 18.6, control-api, and the
unified web shell. All images are version-pinned, services have dependency-aware
health checks, applications run as non-root users, and published ports bind only
to host loopback. PostgreSQL uses a named volume and a private bridge.

The canonical hot-reload workflow starts PostgreSQL through `make bootstrap` and
then coordinates host processes through `make dev`. The full production-shaped
core can instead be validated with:

```bash
docker compose --env-file .env -f infra/compose/compose.yaml --profile core up --build
```

Alembic remains an explicit operator command; application startup never mutates
schema. Local role bootstrap creates a non-superuser `platform_web` login while
`platform_migrator` is reserved for migration and seed operations.

Future `voice`, `integrations`, and `observability` profiles may add retained
engines. Redis may coordinate LiveKit or cache data but never becomes authoritative
application state.
