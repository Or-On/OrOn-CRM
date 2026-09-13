# Portable development deployment runbook

This runbook prepares a development deployment without coupling the source tree
to a hosting provider. It does not authorize a deployment or any provider
action.

## 1. Verify the source candidate

Use Node 24.20, pnpm 11.24, Python 3.14.7, uv 0.12.7, Docker Compose v2, and a
running PostgreSQL 18.6 instance. From a clean commit run:

```bash
uv sync --all-packages --locked --group voice
pnpm install --frozen-lockfile
make verify
```

Real WhatsApp, telephony, voice-provider, automatic-callback, and billing flags
must remain `false` during verification.

## 2. Build immutable images

Build the five repository images from the same reviewed commit:

```bash
docker build -f apps/web/Dockerfile -t oron/web:COMMIT .
docker build -f services/py/control-api/Dockerfile -t oron/control-api:COMMIT .
docker build -f infra/images/messaging-worker.Dockerfile -t oron/messaging-worker:COMMIT .
docker build -f infra/images/dispatcher.Dockerfile -t oron/dispatcher:COMMIT .
docker build -f infra/images/migrator.Dockerfile -t oron/migrator:COMMIT .
```

Scan each final image and retain an SBOM. A deployment manifest must reference
registry digests (`name@sha256:...`), never mutable tags.

## 3. Prepare the host

Create two absolute, operator-owned directories outside the repository:

- a persistent data directory for PostgreSQL and Caddy state;
- a private configuration directory readable only by the deployment operator.

Copy the templates from `infra/deployment/config` into the private directory,
replace every `REPLACE_...` value, and set file permissions to `0600`. Generate
independent PostgreSQL role passwords, authentication secrets, encryption keys,
and webhook/provider secrets. Never copy a developer `.env` or local database
into the deployment.

## 4. Render before mutating

Set `DEPLOYMENT_DATA_DIR`, `DEPLOYMENT_CONFIG_DIR`, `PLATFORM_ORIGIN`,
`TLS_CONTACT_EMAIL`, and all five image variables to immutable digests. Then
render the topology without starting it:

```bash
docker compose --env-file /private/path/deployment.env \
  -f infra/compose/deployment.yaml config --quiet
```

Add `--profile workers` only after the real messaging configuration and queued
work have been reviewed. Add `--profile voice` only after LiveKit, SIP, field
encryption, STT, TTS, and LLM settings have been validated.

## 5. Migrate, bootstrap, and start

Back up an existing database before migration. Start PostgreSQL, run the
one-shot migrator, verify the Alembic head, and only then start the web/API edge.
For a brand-new empty database, run the first-owner bootstrap once using a
private password file:

```bash
PLATFORM_ENV=production \
BOOTSTRAP_OWNER_EMAIL=owner@example.com \
BOOTSTRAP_TENANT_NAME="Example workspace" \
BOOTSTRAP_TENANT_SLUG=example \
BOOTSTRAP_OWNER_PASSWORD_FILE=/private/path/owner-password.txt \
MIGRATION_DATABASE_URL=postgresql://... \
pnpm bootstrap:owner
```

The command refuses a non-empty identity database. Delete the password file
after the first successful login and password rotation.

## 6. Acceptance and rollback

Verify TLS, login, tenant isolation, RBAC, CRUD flows, webhook signatures,
durable queues, health endpoints, restart behavior, and backup restoration into
a new database. Keep all real-provider flags off until each corresponding
provider smoke test receives explicit authorization.

Rollback application images only to a schema-compatible digest set. Database
recovery restores into a new database first; never overwrite the live database
as an automated rollback step.
