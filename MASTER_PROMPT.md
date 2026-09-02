MASTER CODEX GOAL — UNIFIED OR-ON PLATFORM

Read ./MASTER_PROMPT.md completely.

The upstream source repositories are available at:

- ../or-on
- ../wacrm
- ../openlive

Treat those three directories as read-only references. Only modify the current
unified-platform repository.

First verify and record each upstream URL, branch, commit SHA, and license.
Then perform Phase 0 of the master prompt.


ROLE

Act as the principal software architect, staff full-stack engineer, PostgreSQL
architect, DevOps/SRE engineer, application-security engineer, and senior
product designer for this project.

You are responsible for designing and implementing the platform, not merely
writing an architecture proposal.

MISSION

Build one cohesive, development-only, end-to-end omnichannel AI engagement
platform by integrating the following repositories:

1. Or-on
   URL: https://github.com/Abssel-AI/or-on
   Default source branch: master

2. WACRM
   URL: https://github.com/ArnasDon/wacrm
   Default source branch: main

3. OpenLive
   URL: https://github.com/katipally/openlive
   Default source branch: main

Use “Or-On Platform” as a temporary working product name. Centralize the name,
logo, metadata, and branding configuration so the product can be renamed
without searching through the entire codebase.

The finished system must:

- Run locally on the developer’s computer.
- Later run as a development environment on one GCP Compute Engine VM.
- Present one product, one login, one navigation system, and one design language.
- Use PostgreSQL as its only database and authoritative persistence system.
- Integrate telephony, WhatsApp CRM, automation, browser-local voice/vision, AI
  agents, contacts, pipelines, campaigns, analytics, and administration.
- Preserve mature source functionality instead of blindly rewriting it.
- Be efficient, reliable, secure, readable, testable, and easy to operate.
- Have a futuristic, modern, sleek, high-quality UI without sacrificing
  usability, accessibility, or performance.

Assume telephony, LiveKit, WhatsApp, AI-provider, STT, and TTS credentials will
be supplied later through environment variables or GCP Secret Manager.

Do not ask for real API keys during normal implementation. All CI and local
development flows must work with provider simulators and mocks. Real calls and
real WhatsApp messages must require explicit opt-in feature flags.

OPERATING MODE

The current repository is the new private target monorepo.

Treat the three source repositories as read-only upstreams. Never force-push,
rewrite, or commit integration changes directly to their source branches.

Before changing code:

1. Fetch or locate all three source repositories.
2. Record the exact source URL, branch, commit SHA, license, import date, and
   target path in docs/audit/source-lock.json.
3. Read every relevant:
   - AGENTS.md
   - AGENTS.override.md
   - CLAUDE.md
   - README
   - architecture document
   - package manifest and lockfile
   - Docker and Compose file
   - CI workflow
   - database migration
   - deployment script
   - license file
4. Inspect actual code rather than relying only on README claims.
5. Create an evidence-based capability and conflict matrix.
6. Identify duplicated concepts, incompatible schemas, overlapping flow
   engines, authentication assumptions, and runtime constraints.
7. Never invent a source capability you have not verified.

The target repository’s root AGENTS.md will be authoritative for the unified
project. Source-specific instructions remain useful engineering constraints,
but they do not prevent repository-local architecture documentation in the
new target repository.

When this prompt is used in plan mode:

- Perform the read-only audit.
- Produce the architecture, ADR list, migration map, risk register, phased plan,
  and acceptance-test matrix.
- Do not make application-code changes.

When this prompt is used in goal/execution mode:

- Perform or validate the audit first.
- Then implement all phases in order.
- Do not stop after producing documentation.
- At the end of every phase, run its verification gate and create a coherent
  commit.
- When a session or context boundary is approaching, leave a clean committed
  checkpoint, update docs/progress.md, and state the exact next task.

Resolve non-destructive implementation ambiguities using senior engineering
judgment and document the decision in an ADR. Do not pause for naming, colors,
folder naming, or other reversible decisions.

Only request human input when a decision would:

- Trigger a real telephone call or WhatsApp message.
- Spend external cloud/provider money beyond the defined dev environment.
- Destroy or overwrite non-development data.
- Require unavailable credentials or repository permissions.
- Create a material legal or licensing concern.

NON-NEGOTIABLE ARCHITECTURE RULES

1. POSTGRESQL ONLY

PostgreSQL is the only database and the single source of truth for all business
and application state.

Do not use at runtime:

- SQLite
- Supabase-hosted services
- Supabase Auth
- Supabase Realtime
- MongoDB
- MySQL
- DynamoDB
- Firestore
- Firebase
- external vector databases
- filesystem JSON as a database
- browser localStorage or IndexedDB as authoritative business persistence
- separate databases for individual services

Multiple least-privilege PostgreSQL role-specific connection strings pointing
to the same PostgreSQL cluster and database are allowed. Ephemeral PostgreSQL
test databases are also allowed.

SQLite libraries may exist only in a one-time migration/import utility that
reads legacy OpenLive data. They must not be included in normal runtime
containers or runtime dependency graphs.

JSON remains allowed as:

- an API or event serialization format
- static checked-in configuration
- test fixtures
- PostgreSQL JSONB for genuinely flexible fields
- provider payload snapshots

Runtime settings, conversations, credentials, profiles, and user state must not
be persisted to JSON files.

PostgreSQL extensions such as pgvector, pg_trgm, pgcrypto, and full-text search
may be used when justified. Do not add a separate search or vector database.

Redis is permitted only where LiveKit or another verified infrastructure
component technically requires it, or as a disposable cache. Redis must never
be the authoritative store for contacts, messages, calls, sessions, jobs,
automations, credentials, or user state.

Use PostgreSQL-backed inbox/outbox tables and SKIP LOCKED workers for durable
application jobs instead of adding Kafka, RabbitMQ, or Redis queues.

Large binary objects must not be stored inefficiently in PostgreSQL. Call
recordings, message attachments, uploaded media, and model artifacts must use:

- a mounted local object directory in localhost development
- a GCS bucket on the GCP VM deployment

All object metadata, ownership, tenant scope, checksums, retention state, and
access controls must live in PostgreSQL. PostgreSQL remains the source of truth
for the platform’s business state.

2. ONE PRODUCT, NOT THREE APPS BESIDE EACH OTHER

Do not produce:

- three separate dashboards
- three separate login systems
- three independent databases
- three top-level visual identities
- iframes around source applications
- a landing page that merely links to legacy apps
- duplicated contacts, users, agents, or conversations
- independent flow definitions that cannot interact

The finished experience must feel designed as one product.

3. PRESERVE WORKING ENGINES

Do not rewrite mature telephony, media, or AI pipelines merely to use one
programming language.

Retain each source where it is strongest:

- Or-on’s Python, LiveKit/SIP, Pipecat, dispatcher, tenancy, sessions, flow
  runtime, RLS, and telephony capabilities.
- WACRM’s CRM concepts, WhatsApp integration, inbox, contacts, pipelines,
  campaigns, broadcasts, automations, agent-management concepts, analytics,
  API/MCP capabilities, and useful UI components.
- OpenLive’s browser-local voice pipeline, WebGPU model execution, voice/vision
  interaction, WebSocket agent runtime, provider adapters, desktop wrapper,
  ACP integrations, and local-agent tooling.

Use adapters and stable contracts to integrate them.

4. DEVELOPMENT ENVIRONMENT ONLY

This is not currently a production or multi-region deployment.

Optimize for:

- excellent localhost development
- one reliable GCP development VM
- low operational complexity
- safe provider testing
- straightforward debugging
- deterministic setup and teardown
- clean future migration paths

Do not introduce Kubernetes, GKE, service meshes, multi-region databases,
Kafka, or production-scale orchestration.

Do not claim production readiness or regulatory compliance.

5. NO SECRETS IN SOURCE CONTROL

Never place API keys, tokens, private keys, database passwords, credentials, or
real customer data in:

- source files
- Compose files
- Terraform variables committed to Git
- CI logs
- Docker layers
- test snapshots
- screenshots
- seed data
- documentation examples

Provide .env.example with variable names and descriptions only.

6. AVOID ARCHITECTURE ASTRONAUTICS

Use a modular monolith for ordinary business capabilities plus a small number
of bounded services required by different runtimes and lifecycles.

Do not create a network service for every bounded context or table.

Every abstraction must solve a current integration, testability, security, or
operational problem.

TARGET MONOREPO

Use a structure close to the following. Adjust it only when the source audit
shows that another layout reduces risk, and record the reason in an ADR.

.
├── apps/
│   ├── web/                         Unified Next.js application and BFF
│   └── desktop/                     Optional Electron wrapper, not first gate
├── services/
│   ├── py/
│   │   ├── control-api/             Or-on control/session/tenancy API
│   │   ├── dispatcher/              LiveKit/SIP call orchestration
│   │   └── voice-agent/             Pipecat/LiveKit voice worker
│   └── ts/
│       ├── live-agent/              OpenLive Hono/WebSocket agent runtime
│       └── messaging-worker/        WhatsApp, campaigns, automation jobs
├── packages/
│   ├── py/
│   │   ├── oron-common/
│   │   ├── oron-db/
│   │   ├── oron-tenancy/
│   │   ├── oron-sessions/
│   │   ├── oron-flows/
│   │   ├── oron-secrets/
│   │   └── other retained Or-on packages
│   └── ts/
│       ├── ui/                      Design system
│       ├── contracts/               Shared schemas and event contracts
│       ├── api-client/              Generated API clients
│       ├── db-types/                Generated PostgreSQL types, no migrations
│       ├── config/                  Typed environment configuration
│       ├── observability/
│       ├── openlive-audio/
│       ├── openlive-shared/
│       ├── openlive-harness/
│       └── feature-specific packages when justified
├── db/
│   ├── alembic/                     Only migration authority
│   ├── importers/
│   ├── seeds/
│   └── tests/
├── infra/
│   ├── compose/
│   ├── caddy/
│   ├── terraform/
│   │   ├── modules/
│   │   └── environments/dev/
│   ├── github-actions/
│   └── scripts/
├── docs/
│   ├── audit/
│   ├── adr/
│   ├── architecture/
│   ├── runbooks/
│   ├── security/
│   └── progress.md
├── scripts/
├── AGENTS.md
├── Makefile
├── pnpm-workspace.yaml
├── turbo.json
├── pyproject.toml
└── README.md

Use pnpm and Turborepo for JavaScript/TypeScript workspaces.

Use uv for Python workspaces.

Configure workspace globs so TypeScript and Python package managers never
misinterpret each other’s packages.

Provide one root Makefile as the human-facing command surface. Package-native
commands may still exist underneath it.

BOUNDARIES AND DEPENDENCY DIRECTION

Use explicit module boundaries.

For backend business modules, prefer:

domain -> application -> ports -> adapters -> entrypoints

Domain and application modules must not import HTTP frameworks, database
drivers, cloud SDKs, or provider clients.

For the web application, use bounded feature modules rather than a global
collection of unrelated components and utilities. A feature may expose a
public index but must not allow arbitrary deep imports from another feature.

Do not create generic dumping grounds named utils, helpers, common, or shared
without a narrow and documented responsibility.

Enforce boundaries with:

- TypeScript ESLint/import boundary rules
- Python import-linter or an equivalent dependency test
- cycle detection in CI
- architecture tests for forbidden dependencies

Cross-language communication must occur through versioned contracts, not by
duplicating handwritten types.

Use:

- OpenAPI for HTTP APIs
- generated TypeScript clients for Python/FastAPI endpoints
- JSON Schema or another language-neutral schema for WebSocket and event
  messages
- Pydantic and TypeScript/Zod models generated from or validated against the
  same contract source
- explicit error envelopes and correlation IDs

Do not introduce gRPC unless the audit proves a measurable need.

DATABASE AND MIGRATION ARCHITECTURE

Use Or-on’s existing root Alembic history as the foundation and sole migration
authority.

Requirements:

1. Preserve every valid existing Or-on revision and its behavior.
2. Continue using generated Alembic revision IDs. Never manually invent
   sequential revision identifiers.
3. Convert required WACRM Supabase/PostgreSQL migrations into ordered Alembic
   revisions. Raw SQL inside an Alembic revision is acceptable.
4. Do not keep a second active Supabase migration runner.
5. Model OpenLive chats, messages, provider configuration, settings, voice
   profiles, sessions, and related state in PostgreSQL.
6. Provide one-time importers for OpenLive SQLite and JSON data.
7. Make importers:
   - transaction-safe
   - idempotent
   - resumable
   - dry-run capable
   - checksum-aware
   - explicit about source-to-target ID mappings
8. Provide an optional importer for an existing WACRM PostgreSQL/Supabase dump.
9. Preserve source timestamps and relationships where valid.
10. Validate imported row counts and referential integrity.
11. Keep TypeScript database mappings synchronized with PostgreSQL, but do not
    let a TypeScript ORM become a second migration authority.
12. CI must assert exactly one Alembic head.
13. Each migration must have a safe downgrade or explicitly document why it is
    irreversible and require a backup.
14. Run migration tests against a clean database and an upgrade fixture
    representing the prior integrated schema.

Prefer logical domain separation such as identity, crm, messaging, voice,
agents, automation, audit, and platform. Do not move stable existing tables
between PostgreSQL schemas purely for visual neatness if the migration creates
unnecessary risk.

Use:

- UUID primary keys unless source compatibility requires otherwise
- timestamptz for timestamps
- foreign keys
- check constraints
- unique constraints
- explicit delete behavior
- partial and composite indexes based on query patterns
- JSONB only where the schema is genuinely flexible
- normalized columns for query-critical fields
- optimistic locking/version columns where concurrent editing is possible

CANONICAL DATA MODEL

Create one canonical model covering at least:

Identity and tenancy:
- tenants/organizations
- users
- memberships
- roles
- permissions
- sessions
- invitations

CRM:
- contacts
- contact channel identities
- phone numbers
- WhatsApp identities
- tags
- custom fields
- consent and opt-out state
- notes
- pipelines
- stages
- deals/opportunities

Messaging:
- channels
- conversations
- participants
- messages
- attachments
- delivery and read receipts
- message templates
- human/AI ownership and handoff state

Voice:
- calls
- call legs
- LiveKit rooms
- agent sessions
- transcripts
- transcript segments
- recordings
- call outcomes
- summaries
- usage and cost records

Agents:
- agent profiles
- immutable profile versions
- channel capabilities
- provider/model configuration
- prompts
- tools
- knowledge sources
- voice configuration
- OpenLive local-runtime configuration

Campaigns:
- campaigns
- audiences
- campaign members/items
- schedules
- retries
- results
- opt-outs

Automation:
- flow definitions
- immutable flow versions
- triggers
- automation runs
- step runs
- retry/dead-letter state

Platform:
- inbound webhook events
- outbound webhook deliveries
- idempotency keys
- outbox events
- scheduled jobs
- object metadata
- audit records

Do not force all activities into one giant polymorphic table. Keep specialized
source tables and expose a unified activity timeline through a query model,
view, projection, or carefully designed activity index.

TENANCY AND ROW-LEVEL SECURITY

Preserve and extend PostgreSQL RLS.

Use transaction-local PostgreSQL settings such as:

- app.current_tenant
- app.current_user
- app.current_role

All tenant-scoped access must use the established tenant-aware session helpers.
Do not rely on developers remembering to add WHERE tenant_id filters.

Translate WACRM policies that depend on Supabase auth.uid() into application
identity and PostgreSQL session-context policies.

Use separate least-privilege roles for:

- schema migration
- unified web/BFF
- messaging worker
- voice/session services
- background workers
- read-only observability, when needed

Runtime services must never connect as the PostgreSQL superuser or migration
owner.

Add automated tests proving:

- tenant A cannot read tenant B
- tenant A cannot modify tenant B
- cross-service roles cannot access unrelated privileged tables
- background workers can access only their required scopes
- a missing tenant context fails closed
- every new tenant-scoped table has RLS enabled and forced where appropriate

POSTGRESQL EVENTING AND JOBS

Use PostgreSQL for durable orchestration.

Implement:

- inbox tables for inbound provider events
- outbox tables for cross-service events
- unique provider-event IDs
- idempotency keys
- retry counts
- next-attempt timestamps
- exponential backoff with jitter
- terminal/dead-letter state
- trace/correlation IDs
- SKIP LOCKED job claiming
- advisory locks for singleton scheduled tasks where appropriate

LISTEN/NOTIFY may wake workers but must not be the durable event store.

Webhook endpoints must persist and deduplicate an event before acknowledging
successful processing.

IDENTITY AND AUTHENTICATION

Create one authentication and authorization system.

Remove runtime dependence on Supabase Auth.

Evaluate a mature, actively maintained, self-hosted, PostgreSQL-native auth
solution compatible with the unified Next.js application. Record the selection
and rejected alternatives in an ADR.

Requirements:

- secure HTTP-only cookies
- secure and SameSite cookie settings
- CSRF protection
- Argon2id or an equivalently appropriate password hash
- session rotation and revocation
- tenant memberships
- role-based access control
- optional API tokens stored as hashes
- audit logging for sensitive administrative actions
- no browser access directly to PostgreSQL
- no provider secrets sent to browser code

The browser should normally communicate with the same-origin Next.js BFF.

Internal services must be on a private Compose network and authenticate
service-to-service calls with short-lived signed credentials or another
documented mechanism. Network location alone is not authentication.

The Live Agent WebSocket must authenticate the user and tenant before accepting
a session. Do not place long-lived credentials in WebSocket query strings.

UNIFIED PRODUCT EXPERIENCE

Build a single application shell with these primary areas:

1. Command Center
   - platform status
   - live activity
   - active calls
   - new messages
   - campaign progress
   - automation failures
   - provider health
   - usage and cost summaries

2. Omnichannel Inbox
   - WhatsApp conversations
   - channel and assignment filters
   - human/AI ownership
   - typing and delivery states
   - media
   - contact context
   - call and automation activity in the conversation timeline
   - human handoff

3. Contacts
   - canonical contact profile
   - phone and WhatsApp identities
   - tags and custom fields
   - consent
   - complete messaging/call/activity timeline
   - initiate call or WhatsApp action

4. Pipelines
   - stages
   - opportunities
   - drag and drop
   - automation triggers
   - contact and communication context

5. Campaigns
   - voice campaigns
   - WhatsApp broadcasts
   - audiences
   - scheduling
   - throttling
   - retries
   - results
   - opt-out enforcement

6. Automations and Flow Studio
   - visual flow builder
   - versioning
   - validation
   - simulation
   - execution logs
   - message, call, pipeline, schedule, and webhook triggers
   - WhatsApp, call, CRM update, AI, condition, delay, and handoff actions

7. Agents
   - shared agent profiles
   - prompts and tools
   - models/providers
   - voice settings
   - WhatsApp behavior
   - telephony behavior
   - OpenLive local voice/vision behavior
   - version history
   - test and publish workflow

8. Voice and Calls
   - active and historical calls
   - inbound/outbound state
   - phone-number management
   - transcripts
   - recordings
   - summaries
   - outcomes
   - test call
   - failure diagnostics

9. Live Lab
   - OpenLive browser-local voice and vision experience
   - microphone/camera permission handling
   - model-loading progress
   - agent selection
   - text and media timeline
   - voice visualizer
   - connection and latency diagnostics
   - ability to save a tested configuration as a shared agent-profile version

10. Analytics
    - messaging
    - calls
    - campaigns
    - agents
    - conversion/pipeline impact
    - latency
    - provider errors
    - usage and cost

11. Settings and Administration
    - organization
    - users and roles
    - providers
    - WhatsApp
    - telephony
    - AI models
    - secrets
    - webhook endpoints
    - audit log
    - system health
    - feature flags

CROSS-CHANNEL WORKFLOWS

Implement and test these end-to-end workflows:

A. WhatsApp inbound:
   webhook -> durable inbound event -> contact/channel identity resolution ->
   conversation/message -> live inbox update -> AI or human reply -> provider
   delivery/status update

B. CRM to voice:
   contact page -> initiate outbound call -> dispatcher -> LiveKit/Pipecat agent
   -> transcript and outcome -> contact timeline -> pipeline/automation event

C. Voice to WhatsApp follow-up:
   call outcome or summary -> automation trigger -> approved WhatsApp follow-up
   -> conversation timeline and delivery status

D. Live Lab to deployed agent:
   test voice/vision configuration locally -> save immutable agent version ->
   assign channel capabilities -> use profile in telephony or WhatsApp

E. Human handoff:
   AI determines or receives handoff condition -> conversation/call is assigned
   -> operator sees context, transcript, and reason -> audit trail records change

F. Campaign workflow:
   select audience -> enforce consent -> schedule campaign -> execute jobs ->
   retry transient failures -> store results -> update contact/deal state

UNIFIED FLOW MODEL

Or-on and WACRM may contain overlapping flow or automation engines.

Do not keep two unrelated end-user flow definitions.

Create one canonical, versioned flow graph contract with:

- schema version
- node IDs
- typed node kinds
- typed input/output ports
- edge validation
- trigger definitions
- channel constraints
- retry/error policy
- immutable published versions
- draft versions
- validation diagnostics
- execution trace format

Prefer reusing the strongest existing visual editor and each mature runtime.

Create adapters or compilers from the canonical flow graph to:

- Or-on/Pipecat voice-flow execution
- WhatsApp/CRM automation execution
- shared validation and simulation

Do not remove a working runtime until parity tests prove that its supported
behavior is represented by the canonical contract.

Do not install the deprecated pipecat-ai-flows package. Use the Pipecat Flows
namespace already bundled with the supported pipecat-ai dependency.

UNIFIED AGENT MODEL

Use one shared agent profile with immutable versions and channel-specific
capabilities.

A profile version may include:

- system prompt
- model provider and model
- tool permissions
- knowledge configuration
- telephony voice/STT/TTS configuration
- WhatsApp response policy
- OpenLive local model and voice configuration
- language and locale
- escalation/handoff rules
- safety and rate limits

Provider credentials must be references to encrypted credential records, never
embedded directly in profile JSON.

UI AND DESIGN DIRECTION

The UI must be visually distinctive and operationally useful.

Visual direction:

- dark-first, with a polished light mode
- futuristic and modern without becoming a neon gaming interface
- deep graphite/ink surfaces
- restrained luminous accent colors
- subtle ambient gradients
- selective glass/depth effects
- crisp typography
- strong spacing and visual hierarchy
- dense information where operators need it
- generous space where users make complex decisions
- smooth, understated micro-interactions
- high-quality charts and live states
- elegant voice waveform and session visualization

Avoid:

- excessive glassmorphism
- illegible low-contrast text
- gradients on every component
- dozens of competing accent colors
- unnecessary borders
- giant marketing-style cards in operational screens
- animation that delays work
- generic AI-dashboard aesthetics
- placeholder pages presented as finished work

Build a reusable design system in packages/ts/ui with:

- semantic design tokens
- CSS variables
- typography scale
- spacing scale
- elevation and surface tokens
- accessible form controls
- buttons
- menus
- dialogs
- drawers
- tables
- data grids
- filters
- command palette
- status indicators
- charts
- empty/error/loading states
- conversation components
- call and waveform components
- flow-editor components

Use the current Next.js/React/Tailwind stack from WACRM where practical.

Before changing framework-specific code, inspect the bundled Next.js
documentation in node_modules/next/dist/docs and obey current deprecations and
conventions. Do not code against remembered APIs when the repository explicitly
contains the authoritative version documentation.

Requirements:

- WCAG 2.2 AA target
- complete keyboard navigation
- visible focus states
- screen-reader labels
- reduced-motion support
- responsive desktop/tablet/mobile layouts
- RTL-ready layout
- English and Hebrew support
- locale-aware dates/numbers
- no color-only status communication
- consistent error recovery
- skeletons only when they improve perceived continuity
- virtualized or paginated large lists
- lazy loading for OpenLive models and heavy editors
- no unnecessary client components or large client bundles

Use a command palette and meaningful keyboard shortcuts for frequent operator
actions.

Do not use static mock state as the final implementation. Seeded development
data must still come from PostgreSQL through real application paths.

WHATSAPP INTEGRATION

Retain and adapt WACRM’s WhatsApp Cloud API capabilities.

Implement:

- webhook verification
- signature validation
- durable webhook ingestion
- provider-event deduplication
- inbound text and supported media
- outbound messages
- template messages
- status updates
- conversation assignment
- campaigns/broadcasts
- retry handling
- throttling
- consent and opt-out handling
- provider diagnostics
- simulator fixtures for CI and local development

Verify current WhatsApp API requirements from authoritative provider
documentation during implementation. Do not assume old API versions or policies.

Real outbound WhatsApp sends require:

ENABLE_REAL_WHATSAPP=true

The default must be false.

TELEPHONY INTEGRATION

Retain Or-on’s self-hosted LiveKit/SIP/Pipecat architecture and existing
provider integration.

Support:

- inbound calls
- outbound calls
- phone-number configuration
- SIP trunk configuration
- agent dispatch
- call lifecycle events
- transcripts
- recordings
- outcomes
- campaigns
- test calls
- usage/cost tracking
- provider diagnostics
- mock telephony for tests

Preserve the existing requirement that SIP tests use the complete SIP control
plane and required Redis connection rather than an SFU-only mock.

Never create an inbound SIP trunk with an empty allowed-address ACL.

Real outbound calls require:

ENABLE_REAL_TELEPHONY=true

The default must be false.

OPENLIVE INTEGRATION

Preserve OpenLive’s thick-client/local-first media design.

Requirements:

- voice activity detection remains browser-local
- local STT/TTS/model execution remains browser-local where supported
- raw microphone audio must not be sent to the platform server by default
- server communication uses the verified OpenLive protocol for text, control
  messages, and explicitly enabled vision frames
- camera/vision transmission requires clear user action and visible state
- model downloads show progress and recover from failure
- WebSocket reconnect behavior is robust
- backpressure and message ordering are handled
- local model support and remote-provider support remain explicit choices
- desktop packaging remains compiling but is not a first GCP acceptance gate

Migrate OpenLive runtime persistence:

- chats and messages currently stored in SQLite
- provider settings and other small stores currently written as JSON
- voice profiles and configuration stored outside PostgreSQL

All of the above must be modeled in the canonical PostgreSQL database.

Keep a one-time legacy importer, but remove SQLite and file persistence from
normal runtime behavior.

Preserve existing ACP/coding-agent adapters and WACRM MCP capabilities unless
the audit proves they are obsolete. Integrate them with unified authentication,
tenancy, and contracts rather than silently deleting them.

SECRETS AND PROVIDER CONFIGURATION

Centralize typed environment parsing.

Every service must:

- validate required configuration at startup
- distinguish required from optional integrations
- report an optional integration as unavailable rather than crashing the entire
  platform
- redact values from errors and logs
- fail clearly when a required production-like setting is absent

Provider credentials stored in PostgreSQL must use application-level envelope
encryption with authenticated encryption, key version metadata, and a master
key stored outside the database.

Prefer reusing an audited Or-on secrets implementation when suitable.

Local secrets:
- ignored local environment file
- restrictive filesystem permissions
- never copied into images

GCP secrets:
- Secret Manager
- least-privilege VM service-account access
- no secret values in Terraform state
- no long-lived GCP JSON service-account key in GitHub Actions

LOCAL DEVELOPMENT EXPERIENCE

A developer with Docker, Git, Node/pnpm, Python/uv, and Make must be able to run:

make doctor
make bootstrap
make dev

make doctor must validate:

- Docker and Compose
- Node version
- pnpm version
- Python version
- uv
- PostgreSQL client tools where required
- Terraform and gcloud only for GCP tasks
- required ports
- environment-file presence

make bootstrap must:

- install or sync TypeScript dependencies
- sync Python workspaces
- create local directories
- start required infrastructure
- apply Alembic migrations
- generate API clients/types
- seed a PII-free demo tenant and user
- verify health endpoints

make dev must start or clearly coordinate:

- PostgreSQL
- connection pooler when used
- Redis required by LiveKit
- LiveKit and SIP development services
- unified web application
- control API
- dispatcher
- voice agent
- messaging worker
- OpenLive live-agent service
- Caddy or a localhost reverse proxy when necessary

Prefer infrastructure in Docker and application processes with hot reload on
the host. Also provide:

make dev-docker

to run the full stack in containers.

Provide:

make stop
make reset-db
make migrate
make migration-check
make seed
make lint
make format
make typecheck
make test
make integration
make e2e
make verify
make logs
make ps
make backup
make restore

Use a central port registry/document so services do not collide.

Provide a provider-simulator profile for WhatsApp and telephony.

Because real provider webhooks cannot reach localhost directly, provide an
optional documented tunnel command such as:

make tunnel

Do not make the tunnel service mandatory for normal development.

Use one public local origin wherever practical so cookies, CORS, and WebSockets
match the GCP topology.

GCP DEVELOPMENT VM

Deploy to one GCP Compute Engine VM using Docker Compose.

Do not use Kubernetes or GKE.

Create Terraform for:

- remote Terraform-state bootstrap/documentation
- VPC/network
- minimal firewall rules
- reserved static external IP
- Compute Engine VM
- attached persistent SSD disk
- least-privilege service account
- Artifact Registry
- GCS media/object bucket
- GCS PostgreSQL backup bucket
- Secret Manager resource names and IAM bindings
- optional DNS records when a domain is supplied
- OS Login and IAP-compatible administration

Do not put secret values into Terraform.

Use a supported Debian or Ubuntu LTS image suitable for Docker Compose.

Mount persistent application data under a clearly defined path such as:

/srv/or-on-platform

PostgreSQL runs on this VM for the initial development deployment and stores its
data on the attached persistent disk.

Do not use Cloud SQL in the first deployment. Keep the application’s PostgreSQL
configuration portable enough to move to Cloud SQL later without rewriting
domain code.

Run on the VM:

- Caddy
- unified web
- control API
- dispatcher
- voice agent
- messaging worker
- live-agent
- LiveKit/SIP infrastructure
- Redis only as required
- PgBouncer or equivalent pooling when justified
- PostgreSQL

Expose publicly only:

- HTTP/HTTPS
- verified LiveKit/SIP/media ports required by the existing deployment
- webhook routes required by providers

Never expose PostgreSQL publicly.

Caddy must provide:

- TLS when a domain is supplied
- one public product origin
- WebSocket proxying
- request/body limits
- secure headers
- route-specific public webhook access
- support for any COOP/COEP headers required by OpenLive/WebGPU workers without
  breaking the rest of the application

Use Docker:

- pinned versions or image digests
- health checks
- restart policies
- log rotation
- resource limits/reservations where appropriate
- read-only filesystems where practical
- non-root users
- explicit volumes
- private networks
- no floating latest tags

GCP CI/CD

Consolidate source CI/CD into root GitHub Actions workflows.

Use GitHub Actions with GCP Workload Identity Federation. Do not use a committed
or long-lived service-account JSON key.

CI on every pull request must include:

- frozen dependency installation
- TypeScript formatting/linting
- TypeScript strict type checking
- TypeScript unit tests
- Next.js production build
- Python formatting/linting
- Python type checks
- Python tests
- PostgreSQL migration tests
- RLS isolation tests
- API/event contract tests
- generated-code freshness checks
- Docker image builds
- secret scanning
- dependency/security scanning
- license/notice validation
- selected Playwright end-to-end tests

Deployment workflow must:

1. Build immutable images.
2. Tag them with the Git commit SHA.
3. Generate an SBOM.
4. Scan images.
5. Push to Artifact Registry.
6. Connect to the VM using OS Login/IAP or another keyless approved method.
7. Create a database backup before schema changes.
8. Run migrations through a one-shot migrator container.
9. Deploy the release manifest.
10. Wait for readiness checks.
11. Run smoke tests.
12. Roll back to the prior image set when health verification fails.
13. Record the deployed commit and migration revision.

Make GCP dev deployment manually triggerable and environment-protected.

POSTGRESQL BACKUP AND RECOVERY

For the GCP VM:

- run scheduled compressed PostgreSQL backups
- encrypt data in transit to GCS
- use bucket versioning/lifecycle retention
- record checksums
- alert or surface failed backups
- supply make backup and make restore
- provide a restore-to-new-database safety mode
- document full recovery
- automate a periodic restore verification where practical

Do not claim that an untested backup is recoverable.

SOURCE-SPECIFIC INVARIANTS

Or-on:

- Keep Python 3.12 or a verified compatible version.
- Use uv commands; do not use bare Python or pytest when the workspace requires
  uv run.
- Preserve the established one-way package dependency direction unless an ADR
  replaces it with an equally enforceable structure.
- Use Pydantic/SQLModel for persisted Python models where existing conventions
  require it.
- Use dependency injection rather than mutable module-level globals.
- Use enums instead of repeated magic strings.
- Use httpx rather than adding requests.
- Preserve transaction-local tenant RLS.
- Preserve real Alembic migrations as schema truth.
- Preserve non-superuser runtime role testing.
- Do not manually assign sequential Alembic IDs.
- Do not add the deprecated pipecat-ai-flows package.
- Never use real customer spreadsheets or PII as fixtures.
- Do not depend on an external local Obsidian vault for the unified project’s
  architecture or status.

WACRM:

- Preserve useful CRM, WhatsApp, inbox, pipeline, automation, campaign,
  analytics, API, and MCP behavior.
- Remove runtime dependence on Supabase clients, Auth, Realtime, and storage.
- Adapt existing PostgreSQL and RLS concepts rather than discarding them.
- Read the bundled Next.js version documentation before changing
  framework-specific APIs.
- Preserve current UI behavior until replacement screens reach parity.

OpenLive:

- Preserve browser-local media and WebGPU behavior.
- Preserve the live-agent WebSocket protocol through a versioned contract.
- Preserve useful provider and ACP adapters.
- Migrate SQLite and JSON persistence to PostgreSQL.
- Keep desktop code compiling, but prioritize localhost web and GCP web
  deployment.
- Do not force large model files into PostgreSQL.

CODE QUALITY

TypeScript:

- strict mode
- no unbounded any
- no ignored type errors without a documented boundary
- runtime validation at external boundaries
- exhaustive handling of discriminated unions
- stable public package APIs
- generated clients isolated under generated directories

Python:

- complete typing at service and public package boundaries
- Ruff formatting and linting
- existing pyrefly/mypy-style checks retained or improved
- Pydantic validation at external boundaries
- async-safe database and HTTP handling
- graceful cancellation and shutdown

All languages:

- names express domain intent
- comments explain why, invariants, and tradeoffs
- no broad catch-and-ignore error handling
- no N+1 query patterns
- no hidden global state
- no silent fallback to insecure behavior
- no mass unrelated reformatting
- no completed-phase TODO placeholders
- generated files clearly identified
- dependency versions and container tags pinned
- upgrades performed only for compatibility, security, or consolidation reasons

TEST STRATEGY

Create a layered test suite.

Unit tests:
- domain rules
- flow validation
- consent and opt-out rules
- agent-version rules
- retry calculations
- message/call state transitions

PostgreSQL integration tests:
- real Alembic migrations
- real RLS
- service roles
- transaction-local tenant context
- outbox workers
- webhook deduplication
- data importers
- concurrency and SKIP LOCKED behavior

Contract tests:
- OpenAPI compatibility
- generated TypeScript clients
- WebSocket protocol
- event schemas
- provider adapter fixtures

End-to-end tests:
- login and tenant selection
- inbound WhatsApp simulator event
- human reply through simulator
- outbound call through telephony simulator
- transcript/outcome appearing on contact timeline
- automation triggered by call outcome
- WhatsApp follow-up generated by automation
- flow draft, validation, publish, and execution
- agent profile test and publish
- tenant-isolation negative scenarios
- core keyboard navigation

OpenLive tests:
- model-loading state
- microphone permission states
- WebSocket reconnect
- message ordering
- PostgreSQL persistence
- supported-browser manual WebGPU smoke test

Provider tests:
- all normal CI tests use fixtures/mocks
- real-provider smoke tests are separate, manually triggered, and protected by
  feature flags
- tests must never send a real message or call by default

Use only PII-free fixtures.

OBSERVABILITY

Implement:

- structured JSON logs
- request IDs
- trace IDs
- tenant IDs where safe
- conversation/call/session IDs
- secret and PII redaction
- OpenTelemetry-compatible traces
- Prometheus-compatible metrics where appropriate
- /health/live
- /health/ready
- dependency health summaries
- worker lag and retry metrics
- webhook failure metrics
- provider latency/error metrics
- database pool metrics
- model-loading and Live Lab diagnostics

Liveness should indicate that the process is alive.

Readiness should indicate whether the service can safely receive its expected
traffic.

Provide an optional observability Compose profile rather than making a heavy
Grafana/Loki/Tempo stack mandatory for every developer.

SECURITY

Create docs/security/threat-model.md before exposing provider integrations.

Address:

- tenant breakout
- broken object authorization
- credential leakage
- webhook forgery and replay
- CSRF
- XSS
- SSRF
- malicious media/file uploads
- prompt/tool abuse
- unsafe internal service access
- WebSocket authentication
- call and message abuse
- rate limiting
- audit-log tampering
- backup exposure
- dependency compromise

Apply:

- secure cookies
- CSRF controls
- restrictive CORS
- appropriate CSP
- webhook signatures
- replay windows
- idempotency
- request/body limits
- MIME and size validation
- timeouts
- bounded retries
- redacted logs
- encrypted provider secrets
- least privilege
- safe default feature flags
- no unrestricted inbound SIP ACL
- no public database port

LICENSING AND PROVENANCE

Preserve source provenance.

Create:

- THIRD_PARTY_NOTICES.md
- docs/audit/source-map.md
- docs/audit/dependency-licenses.md

Retain the full MIT notices for WACRM and OpenLive in copies or substantial
portions of their code.

Treat the private Or-on source as proprietary target-project code. Do not assign
it a new public license without explicit instruction.

Audit licenses for:

- on-device models
- voice models
- UI assets
- fonts
- icons
- copied code
- transitive dependencies
- Docker images

Do not use runtime Git submodules in the finished platform.

Preserve upstream commit provenance using source-lock metadata and, where
practical, subtree/filter-repo history. Do not let history preservation block
functional integration.

PHASED EXECUTION

PHASE 0 — READ-ONLY AUDIT

Produce:

- docs/audit/repository-inventory.md
- docs/audit/capability-matrix.md
- docs/audit/conflict-matrix.md
- docs/audit/dependency-matrix.md
- docs/audit/database-map.md
- docs/audit/source-map.md
- docs/audit/source-lock.json
- docs/audit/license-map.md
- docs/audit/risk-register.md
- docs/audit/parity-checklist.md

Identify:

- capability overlaps
- duplicate schemas
- duplicate identity models
- duplicate agent definitions
- duplicate flow models
- API conflicts
- port conflicts
- Node/Python compatibility constraints
- source licensing
- migration risks
- features that must be retained
- features that can be consolidated
- obsolete or experimental components

PHASE 1 — ARCHITECTURE AND MONOREPO FOUNDATION

Create root AGENTS.md and scoped AGENTS.md files where specialized instructions
are useful.

Create ADRs for at least:

- target monorepo and service boundaries
- PostgreSQL-only persistence
- Alembic as migration authority
- identity, tenancy, and RLS
- service contracts
- PostgreSQL inbox/outbox jobs
- canonical flow graph
- unified agent profile
- object/media storage
- GCP single-VM deployment
- authentication selection
- UI design system

Set up:

- pnpm/Turborepo
- uv workspace
- Makefile
- typed environment configuration
- CI skeleton
- local Compose infrastructure
- health endpoints
- source provenance
- initial documentation

PHASE 2 — CANONICAL POSTGRESQL FOUNDATION

- Preserve Or-on migrations.
- Create the integrated schema.
- Establish service roles and RLS.
- Add canonical identity/tenant model.
- Add canonical CRM, messaging, voice, agent, automation, and audit models.
- Add outbox/inbox/job infrastructure.
- Convert required WACRM migrations.
- Add OpenLive models and importers.
- Add migration/RLS/import tests.
- Ensure exactly one Alembic head.

PHASE 3 — UNIFIED IDENTITY AND APPLICATION SHELL

- Implement one login/session system.
- Implement tenant switching and RBAC.
- Create unified Next.js shell.
- Create design tokens and core UI package.
- Implement navigation, command palette, error boundaries, loading states, and
  responsive layout.
- Connect to real PostgreSQL-backed APIs.
- Add seed data and provider simulators.

PHASE 4 — CRM AND WHATSAPP

- Port and adapt WACRM features into the unified shell.
- Remove Supabase runtime dependencies.
- Integrate contacts, inbox, pipelines, broadcasts, campaigns, automations,
  teams, analytics, API/MCP, and settings against canonical PostgreSQL.
- Add WhatsApp webhook and provider simulation.
- Complete WhatsApp E2E tests.

PHASE 5 — TELEPHONY

- Integrate Or-on control, dispatcher, voice-agent, sessions, tenancy, flows,
  campaigns, phone numbers, calls, and analytics.
- Expose stable APIs/contracts.
- Replace the standalone Or-on console with unified web screens only after
  feature parity.
- Add telephony simulator and E2E tests.
- Keep real provider smoke tests opt-in.

PHASE 6 — CROSS-CHANNEL PLATFORM

- Implement shared agent versions.
- Implement unified contact activity.
- Implement canonical flow graph.
- Add voice and messaging runtime adapters.
- Add call-outcome-to-WhatsApp workflow.
- Add WhatsApp-to-CRM-to-call workflow.
- Add human handoff.
- Add unified audit, analytics, and usage/cost views.
- Complete cross-channel E2E tests.

PHASE 7 — UI/UX POLISH

- Complete visual consistency.
- Remove legacy visual fragments.
- Add accessibility and keyboard coverage.
- Add RTL/Hebrew verification.
- Optimize loading and bundle boundaries.
- Add polished voice/call/live status visualization.
- Test desktop, tablet, and mobile layouts.
- Run accessibility and production-build performance checks.

PHASE 8 — GCP DEVELOPMENT DEPLOYMENT

- Create Terraform.
- Create GCP Compose profile.
- Configure Caddy/TLS/WebSockets.
- Configure Artifact Registry.
- Configure Secret Manager integration.
- Configure persistent disk and GCS object storage.
- Configure PostgreSQL backup and restore.
- Create keyless GitHub Actions deployment.
- Implement health-based rollback.
- Deploy and run dev smoke tests.

PHASE 9 — OPENLIVE LIVE LAB AND VISUAL AGENT — FINAL INTEGRATION

- Port OpenLive web experience into the unified application last.
- Retain the Hono/WebSocket live-agent as a bounded service.
- Preserve on-device media/model execution.
- Integrate unified auth, agent profiles, and cross-channel flows.
- Use the canonical PostgreSQL persistence and existing legacy import tooling.
- Keep the desktop build working.
- Complete Live Lab persistence/reconnect, accessibility, performance, and GCP
  routing/deployment tests.

PHASE 10 — FINAL HARDENING

- Run the complete verification suite.
- Resolve high/critical security findings.
- Verify no runtime SQLite, Supabase, MongoDB, or JSON persistence remains.
- Verify licenses and notices.
- Test clean-machine bootstrap.
- Test backup restoration.
- Test GCP rollback.
- Update architecture and runbooks.
- Complete the parity matrix.
- Remove superseded runtime entrypoints only after parity is proven.

COMMIT AND WORKTREE DISCIPLINE

Use a branch or worktree per phase or independently reviewable milestone.

Do not edit the target default branch directly.

Each commit must:

- represent one coherent change
- pass the smallest relevant checks
- avoid unrelated formatting
- include migrations and tests together when applicable
- contain no secrets
- update progress documentation when it completes a tracked task

Do not delete legacy implementations until their parity tests pass.

Maintain docs/progress.md with:

- current phase
- completed task IDs
- active task
- decisions made
- verification results
- known blockers
- next exact task
- latest clean commit

DEFINITION OF DONE

The project is complete only when all of the following are true:

1. A clean developer machine can run:
   make doctor
   make bootstrap
   make dev

2. One browser URL presents one application.

3. A user signs in once and sees all authorized modules.

4. PostgreSQL is the only runtime database.

5. OpenLive no longer writes runtime state to SQLite or JSON.

6. WACRM no longer depends on Supabase Auth, Realtime, client-side database
   access, or Supabase storage at runtime.

7. All application services use the same PostgreSQL database with
   least-privilege role-specific access.

8. CI fails when a runtime package introduces:
   - SQLite persistence
   - Supabase runtime clients
   - MongoDB or another database driver
   - filesystem JSON persistence
   - a second application database endpoint

9. Or-on’s existing Alembic history remains valid and the integrated migration
   graph has one head.

10. RLS tests prove tenant isolation.

11. WhatsApp simulator inbound and reply flows pass end to end.

12. Telephony simulator call and transcript flows pass end to end.

13. OpenLive Live Lab persists its chat/session configuration to PostgreSQL.

14. A contact timeline shows WhatsApp, voice, automation, and agent activity.

15. A call outcome can trigger a WhatsApp follow-up through the canonical
    automation model.

16. A tested OpenLive configuration can become a versioned shared agent profile.

17. One flow graph can drive channel-specific voice and messaging runtimes.

18. No real call or WhatsApp send occurs unless explicitly enabled.

19. Core routes pass accessibility and keyboard checks.

20. English and Hebrew/RTL layouts are functional.

21. The platform builds and runs using production-mode containers locally.

22. Terraform can create the GCP development environment.

23. GitHub Actions can deploy immutable images without a static GCP key.

24. The GCP VM serves the unified platform through Caddy.

25. PostgreSQL is not publicly reachable.

26. A GCP database backup can be restored successfully.

27. Failed deployment health checks roll back to the prior image set.

28. No secrets appear in Git history, Docker layers, logs, or build artifacts.

29. THIRD_PARTY_NOTICES.md includes the required WACRM and OpenLive MIT notices.

30. The source parity checklist shows every retained, adapted, replaced, or
    intentionally deferred capability with an explicit reason.

FINAL REPORT FORMAT

At the end of every execution checkpoint, report:

1. Current phase and completion percentage based on tracked tasks.
2. Decisions made and corresponding ADRs.
3. Files and modules changed.
4. Database revisions added.
5. Commands executed.
6. Test, lint, type-check, build, migration, and security-scan results.
7. Provider simulations performed.
8. Remaining risks or blockers.
9. Current clean commit SHA.
10. Exact next task.

Begin now with the read-only repository audit. Do not begin a big-bang rewrite,
do not flatten the three projects blindly, and do not stop at an architecture
document when running in execution/goal mode.
