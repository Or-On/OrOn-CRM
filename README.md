# Or-On Platform

Or-On Platform is a unified workspace for managing customer relationships,
WhatsApp conversations, voice operations, campaigns, and automated engagement.
It brings customer context and operator workflows into one bilingual product
designed for teams that work across messaging and telephone channels.

> **Development status:** The platform is under active development and is not
> currently presented as production-ready or compliance-certified. Real provider
> actions remain opt-in and protected by explicit safety controls.

## Product overview

Or-On gives operators a shared view of the customer journey instead of
separating conversations, calls, contacts, and automations into disconnected
tools.

Current product areas include:

- **Overview** — operational status, recent activity, and actionable summaries.
- **Inbox** — tenant-isolated WhatsApp conversations and human replies.
- **Contacts** — customer profiles, channel identities, consent, ownership, and
  activity history.
- **Pipelines** — visual deal and opportunity management.
- **Campaigns** — controlled messaging and voice campaign workflows.
- **Agents & Flows** — versioned agent definitions and connected cross-channel
  flow visualization.
- **Voice operations** — call records, transcripts, outcomes, usage, and
  simulator-backed validation.
- **Field service & technicians** — an optional, default-off tenant capability
  for service cases, scheduling, attendance, evidence, OCR-assisted review, and
  branded technician reports.
- **Administration** — workspace details, team access, invitations, roles,
  account settings, integrations, and API-key metadata.

The interface supports English and Hebrew, native left-to-right and
right-to-left layouts, responsive navigation, keyboard interaction, and light
and dark themes.

## Availability

| Capability                                           | Current availability                                        |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Unified login and workspace access                   | Available for development                                   |
| Tenant isolation and role-based access               | Available and PostgreSQL-tested                             |
| CRM, contacts, inbox, pipelines, and team management | Available for development                                   |
| WhatsApp simulator                                   | Enabled by default                                          |
| Meta WhatsApp Cloud API                              | Available only when explicitly configured and confirmed     |
| Voice and campaign simulator                         | Available for development                                   |
| LiveKit/SIP control plane                            | Optional, read-only verification available                  |
| Real carrier calling                                 | Explicitly enabled, consented, and confirmed calls only     |
| Cross-channel workflow simulation                    | Available for the supported workflow set                    |
| Field service and technician workflows               | Optional per tenant; unavailable and disabled by default    |
| Visual-agent/Live Lab experience                     | Deliberately deferred to the final integration phase        |
| Portable single-host deployment                      | OCI/Compose candidate prepared; live deployment not claimed |

## Data and tenancy

PostgreSQL is the platform's only runtime database and authoritative source of
application state. Tenant-owned information is protected through database and
application access controls. Application services use scoped database roles;
they do not run as PostgreSQL superusers.

The target runtime does not use Firebase, Supabase-hosted services, MongoDB, or
SQLite persistence. SQLite support is isolated to a one-time legacy import tool
and is not part of normal application execution.

## Prerequisites

Install the following before starting locally:

- Git
- Docker Desktop or Docker Engine with Docker Compose v2
- Node.js 24 LTS (`>=24.20,<25`)
- pnpm 11 (`>=11.24,<12`)
- Python 3.14 through `uv`
- `uv` (`>=0.12.7,<0.13`)
- GNU Make, if available

Hosting credentials, telephony credentials, WhatsApp credentials, and AI-provider
credentials are not required for the default local experience.

## Quick start

From the repository root:

```bash
make doctor
make bootstrap
make dev
```

Then open [http://127.0.0.1:3000](http://127.0.0.1:3000).

`make bootstrap` prepares the local environment, synchronizes dependencies,
starts PostgreSQL, applies migrations, generates contracts, and creates the
local development account. Development credentials are stored in the ignored
file `.artifacts/development-login.txt` and are never committed.

### Windows without GNU Make

The same workflow is available through the cross-platform runner:

```powershell
uv run python scripts/dev.py doctor
uv run python scripts/dev.py bootstrap
uv run python scripts/dev.py dev
```

Run these commands from the `OrOn-Platform` directory. Press `Ctrl+C` to stop
the host development processes.

When the LiveKit, SIP, STT, TTS, LLM, and database settings are already present,
real calling is armed by changing both voice flags to `true` and restarting the
same development command. The runner then starts the guarded dispatcher and
creates ignored local field-encryption material when it is absent. A call still
requires an active E.164 contact, granted voice consent, `voice:operate`
permission, a published voice flow, the real-call checkbox, and the final
browser confirmation.

## Common commands

| Command                | Description                                                              |
| ---------------------- | ------------------------------------------------------------------------ |
| `make doctor`          | Check tools, versions, Docker, and required local ports                  |
| `make bootstrap`       | Prepare an idempotent local development environment                      |
| `make dev`             | Start core services and the dispatcher only when both voice flags are on |
| `make stop`            | Stop local Compose services without deleting stored data                 |
| `make ps`              | Show the state of local services                                         |
| `make logs`            | Follow local service logs                                                |
| `make migrate`         | Apply the canonical database migrations                                  |
| `make migration-check` | Confirm the database is on the current migration head                    |
| `make seed`            | Create the minimal local development identity and workspace              |
| `make lint`            | Run formatting, lint, and repository-policy checks                       |
| `make typecheck`       | Run strict TypeScript and Python type checks                             |
| `make test`            | Run the automated test suites                                            |
| `make verify`          | Run the consolidated verification and production build gate              |

## Optional voice control plane

The retained voice stack is intentionally separate from ordinary CRM and web
development because it includes larger audio and real-time dependencies.

```bash
make voice-bootstrap
make voice-up
make voice-check
```

`voice-check` only reads the local LiveKit/SIP configuration. It does not create
carrier resources or place calls. See the
[voice control-plane runbook](docs/runbooks/voice-control-plane.md) before
configuring a real SIP provider.

## Optional WhatsApp provider

The simulator remains the default WhatsApp provider. Real Meta delivery is
available only after the required environment variables, webhook validation,
consent, provider selection, and user confirmation are all in place.

Follow the [WhatsApp Cloud API runbook](docs/runbooks/whatsapp-cloud-api.md) for
configuration and safe testing. Do not paste credentials into source files,
documentation, screenshots, issue reports, or chat transcripts.

### Optional WhatsApp AI and tenant integrations

The Inbox operator must
then explicitly assign a published WhatsApp agent to each conversation.
Generated messages use the canonical durable outbound queue and all Meta safety
gates. A human can take over at any time. Automatic WhatsApp-requested callbacks
remain separately disabled by default; when deliberately enabled, an explicit
customer request creates one durable call job against the published connected
flow. See the
[WhatsApp AI and call-request runbook](docs/runbooks/whatsapp-ai-and-call.md).

Tenant administrators enter Google and Microsoft OAuth client credentials in
the Email UI. The browser never receives stored secrets or refresh tokens. The
deployment operator must provide one 32-byte base64
`CREDENTIAL_ENCRYPTION_KEY` through the selected deployment secret store so the server
can encrypt tenant credentials with AES-256-GCM.

Campaign funding is unavailable until `ENABLE_REAL_BILLING=true` is set with
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. A tenant administrator must
first connect a reusable payment card through Stripe Checkout setup mode. Only
then can a wallet top-up Checkout session be created, and the wallet is credited
only by a verified paid webhook. There is no simulator or locally minted demo
balance. Never send card numbers to an Or-On endpoint.

## Access model

- **Members** work with the product capabilities permitted by their assigned
  role.
- **Tenant administrators** manage their own workspace, members, invitations,
  and workspace-level configuration.
- **Platform super administrators** may operate across authorized tenants.

Invitations currently produce a secure, one-time link for manual delivery.
Automated invitation email and verified mailbox-change workflows are not yet
claimed.
Invitation acceptance uses a shell-free public route. Workspace owners and
administrators can revoke pending invitations, immediately invalidating the
single-use link while retaining an audit record.

## Verification

Before submitting changes, run:

```bash
make verify
```

The verification gate covers formatting, linting, type safety, automated tests,
database migration state, generated contracts, repository safety rules, and the
production web build. Checks that require real providers remain separate and
manually authorized.

## Documentation

- [Local development](docs/runbooks/local-development.md)
- [WhatsApp development](docs/runbooks/crm-whatsapp-local.md)
- [WhatsApp Cloud API](docs/runbooks/whatsapp-cloud-api.md)
- [WhatsApp AI and call requests](docs/runbooks/whatsapp-ai-and-call.md)
- [Voice control plane](docs/runbooks/voice-control-plane.md)
- [Field service and technicians](docs/runbooks/field-service.md)
- [Field-service source mapping](docs/migration/brimag-field-service-map.md)
- [Field-service validation evidence](docs/migration/field-service-validation.md)
- [Architecture overview](docs/architecture/overview.md)
- [Portable deployment](docs/runbooks/deployment.md)
- [Security threat model](docs/security/threat-model.md)
- [Architecture decisions](docs/adr/README.md)
- [Development progress](docs/progress.md)

## Known limitations

- The platform is a development environment, not a production release.
- Real voice campaigns are not enabled by this workflow. Automatic callbacks are
  limited to explicit WhatsApp requests, the assigned published connected flow,
  and all voice safety gates.
- Invitation email delivery, public signup, mailbox background synchronization,
  MFA, account recovery, and verified email-change workflows remain incomplete.
- The connected flow canvas is currently a visual and operational foundation,
  not a complete free-form workflow editor.
- OpenLive visual-agent functionality remains deferred.
- Production deployment, backup recovery, monitoring, and accessibility
  certification require their dedicated acceptance phases.

## Source and licensing

Or-On Platform preserves proven concepts and capabilities from Or-on, WACRM,
and OpenLive while presenting them through one product experience. Those source
repositories are engineering references and are not required at target runtime.

Third-party attribution and licensing information is maintained in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No license is implied for
private or proprietary source material.

## Contributing

Keep provider actions disabled during normal development, preserve tenant
isolation, add tests for behavioral changes, and never include secrets or real
customer information in commits.
