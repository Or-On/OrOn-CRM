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

The opt-in `voice` profile adds digest-pinned Redis 8.10.1, LiveKit Server
v1.13.6, and LiveKit SIP v1.13.0. Redis and SIP publish no host ports; LiveKit's
control endpoint binds only to loopback. Redis is disposable coordination state
and never authoritative application persistence. `voice-up` waits for all three
health checks and then lists SIP resources through the read-only SDK surface;
it creates no trunk, dispatch rule, participant, DID, or call. See the
[voice control-plane runbook](../../docs/runbooks/voice-control-plane.md).

Future `integrations` and `observability` profiles may add retained engines.
