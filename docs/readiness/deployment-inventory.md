# Deployment and operations inventory

Source inspected 2026-09-12; baseline HEAD in baseline.md. Unless explicitly
listed as verified-local, execution remains unverified.

| Entrypoint / feature | Code, actual behavior and boundaries | Status / evidence | Required gate |
| --- | --- | --- | --- |
| Developer command surface | Makefile; scripts/dev.py: doctor, bootstrap, dev, voice*, migrate, seed, checks | Source reviewed; dev loads operator .env and may run real workers | Never use bootstrap/dev for readiness verification; isolated stack required |
| Consolidated verify | scripts/dev.py verify; runs voice dependency sync, formatter/lint, typing, tests, Git-diff contract check, connected DB, build and audits | blocked for direct invocation: .env real flags, mutable developer DB, dirty generated contracts; underlying safe equivalents required | Hermetic verify runner with explicit isolated DB; preserve Git-based CI freshness |
| Database graph and imports | db/alembic, db/importers, scripts/db_verify.py | Source/graph reviewed by worker inventory; one head eb2660eb37ec | Fresh install, prior upgrade, roles/RLS, restore, idempotency |
| Runtime web image | apps/web/Dockerfile, standalone Next production | verified-local build; nonroot uid1000. FAILED asset check: /app/apps/web/public/brand/logo.webp absent | Copy public assets; prove authenticated runtime and images over HTTP |
| Runtime control image | services/py/control-api/Dockerfile | baseline build in progress | Fresh startup with private scoped DB, health, shutdown |
| Other specialized images | Messaging worker, dispatcher, voice, live-agent | failed: no Dockerfiles at baseline | Build required workers; retain intentional Live Lab deferral; no real provider activation |
| Development Compose | infra/compose/compose.yaml, LiveKit/SIP/Redis optional profile | existing user stack healthy; NOT staging-ready (fixed development passwords, no complete workers/migration/release orchestration) | Separate production-shaped Compose, private network, resources/log rotation, no seed |
| Public webhook tunnel | infra/compose/webhook-tunnel.yaml, Caddyfile.webhook-local | Current user stack; not touched or probed with user tokens | Staging single TLS origin; signed webhook tests against isolated data |
| Reverse proxy | infra/caddy/Caddyfile.example | Source reviewed; lacks private-staging access split and complete release configuration | Validate real Caddy config, request limits, headers, callbacks, nonpublic internals |
| Terraform | infra/terraform/environments/dev/versions.tf, README | failed: version constraints and placeholders only; Terraform absent PATH | VM/VPC/disk/IAM/registry/private buckets/secret metadata/WIF resources; fmt/validate without apply |
| CI | .github/workflows/ci.yml | Existing TS/Python/PostgreSQL/contracts/security/build jobs; no deployment workflow, browser gate, SBOM/image scan | Protected manual immutable release pipeline, rollback compatible with migration |
| Secret scan | scripts/check_secrets.py | verified-local regex scan (tracked + nonignored untracked paths); not full-history/image scan | Broaden precise patterns, artifact/container review; no secrets in evidence |
| Dependency audit | scripts/pip_audit.py | failed policy: exception expired 2026-09-09; do not extend arbitrarily | Inspect actual current advisory and remediation; all severity decision explicit |
| Backup/restore/rollback | No executable deployment backup/recovery commands found | failed: runbook aspiration only | pg_dump checksum, restore NEW DB, role/RLS/row/object integrity; no replay side effects |
| Object/media storage | Existing local/GCS retained Python artifact adapters; DB metadata and avatar bytes | source review required | Staging private GCS identity/prefix, unauthorized recording/image reads, restore consistency |
| Runtime observability | health endpoints, pino/Python JSON logs, UI observed health; no complete staging alert evidence | unreviewed | Queue/DB/worker failures, redaction, bounded logs/disk, exercise alerts |
| Source assets/licenses | public/brand, shared ui tokens; third-party MIT notices and source-map | source reviewed; no assets deleted | Preserve accepted reference, notices, and only remove demonstrably unused code |

## Recovery and operating constraint

No user containers, running processes, volumes, .env or queues may be stopped,
restarted, reset or consumed. New drills must use a dedicated Compose project,
database cluster, volume and ports. Provider/billing/AI flags must be false and
credentials must not be inherited. Cloud resources/deployments remain separately
authorized. A passing image build does not validate routes or database access.
