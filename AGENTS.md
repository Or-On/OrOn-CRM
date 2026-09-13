# Or-On Platform — Engineering instructions

## Repository scope

This repository is the only writable project repository.

The following sibling repositories are read-only upstream references:

- `../or-on`
- `../wacrm`
- `../openlive`

Never modify files in those three upstream repositories.

Never run formatting, dependency installation, migrations, resets, cleanup,
commits, rebases, pushes, or generated-code commands inside an upstream
repository. Read them only at their locked Phase 0 commits.

All integrated application code, tests, infrastructure, documentation,
migrations, and configuration must be created inside this repository.

The final project must build and run independently without requiring the
three sibling repositories to remain present.

## Database

PostgreSQL is the only runtime database and source of truth.

Do not introduce:

- Firebase
- Firestore
- Supabase runtime services
- Supabase Auth
- SQLite runtime persistence
- MongoDB
- filesystem JSON as an application database

SQLite is permitted only inside a one-time legacy OpenLive import utility.

Alembic is the only target schema migration authority. Prisma, Drizzle, TypeORM,
Supabase, and application-startup schema mutation must not create competing
migration histories. CI must converge on exactly one Alembic head.

Application services must not connect as PostgreSQL superusers or migration
owners. Preserve Or-on's transaction-local tenant context and fail-closed RLS
direction.

## Technology and dependency policy

Preserve proven source technologies, engines, protocols, package identities, and
behavior when compatible. Integrate working engines through thin adapters to
canonical contracts; do not rewrite them for visual or framework uniformity.

Technology choice and dependency version choice are separate. Select the newest
stable, actively supported, security-patched compatible version and document
fallbacks. Do not use prerelease channels merely for freshness. Optional
replacement of a proven technology requires explicit user approval.

Use pnpm as the only target JavaScript package manager and uv for Python. Do not
add Turborepo without a measured need and ADR.

## Provider and secret safety

Real provider traffic is disabled by default. Never place a telephone call, send
a WhatsApp message, modify provider webhooks, or provision provider resources
without both an explicit feature flag and explicit user approval. Tests use local
fixtures and fakes.

Never commit or log passwords, tokens, API keys, private keys, decrypted provider
credentials, or service-account JSON. Configuration diagnostics must redact
sensitive values. Hosting-provider provisioning and credentials remain outside
this application repository and require separate explicit authorization.

## Provenance and boundaries

The target must build and run without its sibling repositories. For each copied or
adapted upstream artifact, update `docs/audit/source-map.md` with source repository,
path, locked commit, target path, treatment, reason, and license implications.

Keep public package and feature APIs intentional. Avoid cross-feature deep imports,
circular dependencies, mutable module-global service state, and global dumping
grounds named `utils`, `helpers`, or `components`.

## Branch and verification discipline

Use the current `main` integration line and coherent commits; isolate major
dependency upgrades.
Update `docs/progress.md` as tasks move through the acceptance gate.

Every change must run the smallest relevant tests, followed by the consolidated
verification appropriate to its scope. Before completion, verify lint, formatting,
strict typing, tests, production builds, migration state, contract freshness,
dependency guards, sibling independence, and clean upstream worktrees.

## Upstream paths

Use these exact relative paths:

- Or-on: `../or-on`
- WACRM: `../wacrm`
- OpenLive: `../openlive`

## Workflow

1. Read `MASTER_PROMPT.md` completely.
2. Read scoped `AGENTS.md` files before changing their subtree.
3. Treat `docs/audit/` as the locked-source evidence base and
   `docs/architecture/` plus `docs/adr/` as target direction.
4. Implement incrementally with tests and coherent commits.
