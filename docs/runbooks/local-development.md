# Local development runbook

## Normal workflow

```bash
make doctor
make bootstrap
make dev
```

`doctor` reports every required tool/version and port without installing or
changing anything. `bootstrap` creates ignored `.env` only when absent, syncs the
frozen pnpm/uv workspaces, starts PostgreSQL, bootstraps local roles, migrates,
generates contracts, applies fictional idempotent seed data, and verifies live and
ready health. It never overwrites an existing `.env`.

`dev` keeps PostgreSQL in Compose and runs web, control-api, live-agent, and
messaging-worker with host hot reload. Stop foreground processes with Ctrl+C; use
`make stop` to stop Compose without deleting the named database volume.

## Safety checks

- `ENABLE_REAL_TELEPHONY=false`
- `ENABLE_REAL_WHATSAPP=false`
- `DATABASE_URL` uses `platform_web`
- `MIGRATION_DATABASE_URL` uses `platform_migrator` only for operator commands
- all published ports bind to `127.0.0.1`

The runner refuses non-false provider flags. Do not add real secrets to `.env` for
Phase 1 verification.

## Useful commands

```bash
make ps
make logs
make migrate
make migration-check
make seed
make lint
make typecheck
make test
make verify
```

If readiness is unavailable, inspect PostgreSQL first with `make ps` and
`make logs`. Liveness may remain healthy while readiness is correctly unhealthy.
Do not weaken readiness or replace the PostgreSQL URL with SQLite to bypass a
local database problem.

## Full container-shaped core

After bootstrap has migrated the database:

```bash
docker compose --env-file .env -f infra/compose/compose.yaml --profile core up --build
```

This starts PostgreSQL, control-api, and web with dependency-aware health checks.
The normal hot-reload path remains preferred for development.

## Recoverability

`make stop` is non-destructive. There is intentionally no ordinary reset target.
Never remove the named volume unless its exact development-only identity has been
verified and the loss is explicitly intended.
