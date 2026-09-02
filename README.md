# Or-On Platform

Or-On Platform is the target home for one operator product spanning voice and
telephony, CRM and WhatsApp, and browser-local live agents. It integrates three
working source systems through thin adapters and canonical contracts instead of
rewriting proven engines for uniformity.

## Current status

Phase 2A established the canonical PostgreSQL model while preserving the Or-on
lineage and adapting WACRM/OpenLive persistence. Phase 2B live validation is
complete on PostgreSQL 18.6: clean migration, catalog, roles, RLS, tenant
isolation, historical encryption backfill, supported downgrade/re-upgrade,
constraints/delete actions, keyset pagination, idempotency, durable-job
concurrency, seed, OpenLive JSON/SQLite import, WACRM export mapping, production
containers, and the complete core Compose health chain all pass.

SQLite appears only as a read-only legacy OpenLive importer input; canonical
PostgreSQL is the only destination and target runtime database. GNU Make is not
installed on this host, although the same underlying cross-platform command
runner used by every Make target passes.

Phase 3 added one canonical, PostgreSQL-backed identity/session boundary: an
Alembic-owned credential and session schema, Argon2id passwords, opaque
HMAC-digested session tokens, CSRF/origin enforcement, tenant switching, typed
RBAC, short-lived live-agent assertions, and an authenticated Next.js shell.
Phase 4 now integrates a bounded CRM and WhatsApp simulator slice: contacts and
deduplication, shared inbox, pipelines, durable simulator campaigns, versioned
automation runs, team/settings, notifications, scoped API keys, and the
PostgreSQL messaging worker.

Phase 5 is simulator-complete. The retained Or-on dispatcher, Hebrew processing,
Pipecat voice agent, sessions, tenancy, campaigns, flows, and SIP admission
packages are target-local. The unified shell now provides voice flows, safe DID
admission diagnostics, consent-aware simulator campaigns, calls, call detail,
transcript/outcome/artifact/usage/latency views, and a contact call action backed
by canonical PostgreSQL. Provider execution and model loading remain default-off;
no real call path is enabled.

Phase 6 now provides the cross-channel control plane: tenant-scoped immutable
agent versions, one canonical voice/WhatsApp flow contract with deterministic
retained-engine adapters, idempotent PostgreSQL simulator jobs, consent-aware
channel transitions, race-safe human handoff, safe contact activity, and honest
usage/latency/unpriced-cost reporting. The unified shell exposes these under
**Agents & flows**, and FastAPI OpenAPI generates the cross-language validation
client. WhatsApp additionally has a simulator-default Meta Cloud API adapter:
real sends are explicitly selected and confirmed, durably queued in PostgreSQL,
processed outside database transactions, and updated by raw-body-verified,
deduplicated status webhooks.

It does **not** enable real WhatsApp by default or any real telephony, public signup/OAuth/MFA,
OpenLive/Live Lab/visual-agent execution, or production GCP infrastructure.
OpenLive is deliberately reserved for the final integration phase. Planned
navigation is visibly unavailable rather than presented as finished functionality.

## Source systems

The sibling repositories are read-only engineering references at locked commits:

| Source | Path | Locked commit | Preserved direction |
| --- | --- | --- | --- |
| Or-on | `../or-on` | `cece174f4d590a1b8a283d539dd66e08cc689aa9` | Python/FastAPI/SQLModel/Alembic/RLS, LiveKit/SIP, Pipecat, dispatcher/session/flow/tenancy behavior |
| WACRM | `../wacrm` | `98b5bd26e8feacacfd4b74ff58411acb8154d212` | Next/React/Tailwind CRM, WhatsApp Cloud API, inbox/contact/pipeline/campaign/automation behavior |
| OpenLive | `../openlive` | `849173cd1c8c17a95d600b17b428c301722bf5df` | Next/Hono/WebSocket/ACP/MCP, provider harness, browser-local VAD/STT/TTS/WebGPU and desktop behavior |

Do not install, format, migrate, reset, clean, commit, or generate files in those
repositories. The target builds and runs without them.

## Architectural rules

- Modular monolith plus only the specialized runtime processes justified by
  media, native dependencies, protocols, or lifecycle.
- PostgreSQL 18 is the only target runtime database and authoritative application
  state. No Firebase, Supabase runtime service, SQLite runtime store, MongoDB, or
  separate application database.
- Alembic is the only schema migration authority and must converge on one head.
- Application processes never use PostgreSQL superuser or migrator credentials.
- pnpm is the sole JavaScript package manager; uv owns the Python workspace.
- Retained technologies use the newest stable, supported, patched compatible
  versions. Upstream pins are evidence, not automatic target versions.
- Real provider actions remain disabled by default and require both an explicit
  feature flag and explicit user approval when implemented.

See [architecture overview](docs/architecture/overview.md),
[technology baseline](docs/architecture/technology-baseline.md), and the
[ADR index](docs/adr/README.md).

## Repository layout

```text
apps/web/                         unified Next.js shell and same-origin BFF
apps/desktop/                     documented future OpenLive desktop boundary
services/py/                      control-api, dispatcher, voice-agent boundaries
services/ts/                      live-agent and messaging-worker boundaries
packages/py/platform-integration  new cross-system Python foundation
packages/ts/                      UI, contracts, client, config, observability, integration
db/alembic/                       sole 36-revision migration graph/head
db/bootstrap/                     local role bootstrap, not schema migration
db/contracts/                     consumer-only schema expectation manifest
db/importers/                     isolated one-time legacy import tools
db/seeds/                         deterministic fictional seed
infra/compose/                    localhost core
infra/caddy/                      future single-origin edge foundation
infra/terraform/                  non-deploying one-VM GCP structure
docs/                             audits, ADRs, architecture, runbooks, security, progress
scripts/                          developer orchestration and repository checks
```

## Selected prerequisites

- Git
- Docker Engine/Desktop and Docker Compose v2
- Node.js 24.20 LTS-compatible runtime (`>=24.20,<25`)
- pnpm `>=11.24,<12`
- Python 3.14.7 through uv
- uv `>=0.12.7,<0.13`
- GNU Make or compatible Make implementation

Ordinary localhost work does not require Terraform, gcloud, GCP credentials,
LiveKit, provider credentials, or AI credentials.

## Localhost setup

```bash
make doctor
make bootstrap
make dev
```

`bootstrap` is idempotent and creates ignored `.env` from `.env.example` only when
missing. It synchronizes frozen dependencies, starts PostgreSQL, creates
least-privilege local roles, migrates the one Alembic lineage, regenerates
contracts, generates local-only auth material, applies fictional seed data, and
checks real PostgreSQL readiness. The fictional operator login is written with
restrictive permissions to ignored `.artifacts/development-login.txt`; it is
never printed or committed.

The retained Pipecat, PyTorch, Torchaudio, ONNX, and Hebrew voice stack is kept
in the opt-in uv `voice` group so ordinary CRM/control development stays small.
Install it with `make voice-bootstrap`; this does not download model weights or
enable LiveKit, speech, LLM, or telephony providers.

The default host workflow keeps PostgreSQL in Compose and runs the current app
processes with hot reload. See the
[local development runbook](docs/runbooks/local-development.md). CRM simulator
details are in the [CRM/WhatsApp runbook](docs/runbooks/crm-whatsapp-local.md).
Real Meta setup and the protected smoke command are documented in the
[Meta WhatsApp runbook](docs/runbooks/whatsapp-cloud-api.md).
The opt-in, no-call LiveKit/SIP setup is in the
[voice control-plane runbook](docs/runbooks/voice-control-plane.md).

## Command surface

| Command | Purpose |
| --- | --- |
| `make doctor` | Report required tools, selected versions, daemon state, and ports |
| `make bootstrap` | Sync, start PostgreSQL, migrate, generate, seed, and health-check |
| `make voice-bootstrap` | Install the heavy retained voice dependency group with providers disabled |
| `make voice-up` / `make voice-down` | Start/stop the private Redis/LiveKit/SIP control plane without enabling a carrier path |
| `make voice-check` | Read-only list SIP control-plane resources; never creates or mutates provider state |
| `make dev` | Run host processes; simulator-default, with only explicitly configured gated WhatsApp allowed |
| `make stop` / `make ps` / `make logs` | Operate the non-destructive local Compose stack |
| `make migrate` / `make migration-check` | Upgrade/check the sole Alembic lineage |
| `make migration-graph` / `make migration-sql` | Inspect the graph and deterministic PostgreSQL SQL offline |
| `make db-contract-check` | Check RLS, indexes, extensions, SQL safety, and the schema manifest |
| `make db-verify-offline` | Run the repository-controlled Phase 2A database gate without a server |
| `make db-verify-live` | Run Phase 2B against an explicit disposable PostgreSQL 18.6 URL |
| `make seed` | Apply idempotent PII-free development metadata |
| `make lint` / `make format` | Check/apply repository formatting and policy |
| `make typecheck` / `make test` | Run strict typing and tests in both workspaces |
| `make verify` | Run the consolidated database-aware acceptance gate |

## Provider and secret safety

`.env.example` contains no real credentials and defaults to:

```dotenv
ENABLE_REAL_TELEPHONY=false
ENABLE_REAL_WHATSAPP=false
ENABLE_REAL_VOICE_PROVIDERS=false
```

Verification/bootstrap refuse non-false values. Host `make dev` accepts real
WhatsApp only when explicitly configured; each UI send still requires consent,
selection, acknowledgement, and confirmation, while the worker checks the flag
again. Never commit `.env`, service-account JSON, provider
tokens, keys, or secrets; diagnostics and logs must redact sensitive values.

## Known limitations

- Docker-backed PostgreSQL health/migration and container builds require a local
  Docker daemon; the checks intentionally fail rather than report fake health.
- Public signup/OAuth/MFA/recovery, provider signature/replay controls,
  uploads, backups, and production telemetry remain planned or Phase 2B controls,
  not current claims.
- Or-on has no repository license file; its preserved migration lineage is
  treated as private/proprietary project code. WACRM/OpenLive adaptations retain
  MIT notices in `THIRD_PARTY_NOTICES.md`. Future voice/model assets still need
  separate license review.
- Terraform declares constraints/documentation only. No resource is provisioned
  and `terraform apply` remains prohibited in Phase 2A.

Current task status and exact blockers are recorded in
[docs/progress.md](docs/progress.md). The full security posture is in the
[Phase 1 threat model](docs/security/threat-model.md).
