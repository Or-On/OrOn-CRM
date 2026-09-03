# Local development runbook

## Isolated UI review (Phase 7)

Use this when the developer `.env` enables real providers. Run from the repository
root with the pinned Node/pnpm toolchain available and localhost PostgreSQL running:

```powershell
uv run --no-sync python scripts/preview_ui.py
```

Open `http://127.0.0.1:3100`. The temporary fictional login is in ignored
`.artifacts/phase7-preview-login.json`; do not share or commit it. This is **not**
your usual port-3000 server or its login. The tool reads only the localhost
migration connection from `.env`, creates an owned UUID-named database and a
non-superuser login inheriting `platform_web`, applies migrations and fictional
seeds there, then starts only the web process. Real-provider flags are false,
provider credentials are not forwarded, and no messaging/voice consumer starts.
Queued simulator replies therefore stay queued; this does not prove delivery.
Stop with Ctrl+C to remove the owned database/login and temporary login file.
The developer database, existing login passwords, `.env`, and queues are untouched.
Do not force-kill the runner if graceful cleanup is possible.

Public product pages are `/en` and `/he`; the authenticated Overview remains `/`.
Language controls switch EN/HE and actual document direction. Workspace switches
refresh in place to preserve reply drafts; public switches use a document
navigation and retain the URL query/fragment. `/start` provides a guided route
through the implemented product. Public canonical/social metadata uses optional
`PUBLIC_SITE_URL` (documented in `.env.example`); no real credentials are needed.

To inspect the built application instead of hot reload, first stop the preview,
run `pnpm build`, then run:

```powershell
uv run --no-sync python scripts/preview_ui.py --production
```

This web-only preview deliberately cannot contact a developer control API;
voice and system health show unavailable. Use a separately owned complete
simulator stack for end-to-end voice acceptance, not a real-provider runner.
New temporary login files also record the exact owned database/login role for
recovery if a forced process termination bypasses cleanup. Do not use prefix-wide
deletion. See [executed checks and remaining acceptance](bilingual-ui-acceptance.md).

For the new history/Overview SQL regression test, without starting web:

```powershell
uv run --no-sync python scripts/preview_ui.py --check-db
```

This creates and removes a separate database; the new test refuses ordinary
developer database names. It exercises 303 fictional messages, microsecond/tied
timestamp pagination, current-sender projection, role-scoped reads and missing/
other-tenant isolation. Existing cross-channel CRM/worker integration suites need
their dedicated voice fixtures and are not replaced by this focused check.

If your machine has another Node/pnpm on PATH, use the versions in the root
manifest. Existing local `.artifacts/toolchains/` installations can be prepended
for the shell session. No upstream dependency installation is necessary.

## Normal workflow

For a provider-free check of the Inbox's new failure diagnostics:

```powershell
uv run --no-sync python scripts/preview_ui.py --check-messaging
```

This uses an owned fictional PostgreSQL database and mocked Meta HTTP; it does
not start the development worker or consume its queues. See the
[diagnostic behavior and restart precautions](whatsapp-cloud-api.md#send-diagnostics-in-the-inbox).

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

Bootstrap, verification, tests, and CI refuse non-false provider flags. `make dev`
may accept an explicitly enabled real WhatsApp flag for the gated Phase 6 path;
telephony and AI provider flags remain refused. Follow the
[real WhatsApp runbook](whatsapp-cloud-api.md) and keep provider secrets only in
the ignored `.env`.

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
