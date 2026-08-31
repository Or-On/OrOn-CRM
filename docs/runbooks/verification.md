# Verification runbook

`make verify` is the consolidated local gate after `make bootstrap`. It checks:

- TypeScript and Python formatting/linting;
- workspace dependency boundaries, prohibited runtime dependencies, single
  database/migration direction, sibling independence, and committed secrets;
- strict TypeScript and Pyrefly typing;
- TypeScript and Python tests;
- deterministic generated OpenAPI/client/event contracts;
- one Alembic head and the connected database at that head;
- all TypeScript package/service builds and the Next.js production build;
- pnpm peer state, `pnpm audit`, and `pip-audit`.

CI separates these into TypeScript, Python, database, contracts,
architecture/security, and container-build jobs. It starts a clean PostgreSQL
18.6 service and does not mount or fetch sibling repositories.

Docker-backed failures are not replaced with fake green checks. When Docker is
unavailable, record the precise skipped gates and keep Phase 1 blocked rather than
claiming PostgreSQL/container acceptance.

No verification command requires GCP, Terraform credentials, provider
credentials, a real message/call, or external webhook mutation.
