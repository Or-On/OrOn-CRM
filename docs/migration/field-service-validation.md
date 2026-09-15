# Field-service implementation validation

Validation date: 2026-09-15

## Verified source and target

- Target remote: `https://github.com/Abssel-AI/OrOn-CRM.git`
- Target branch and baseline: `main` at
  `a7d18bc7bf937154af9d120fede61355a0a09271`
- Read-only reference remote: `https://github.com/Abssel-AI/Brimag.git`
- Reference branch and commit: `main` at
  `08228541cf0ccf7f65eb8517ec9c5346c29f280f`

The capability mapping and explicit exclusions are documented in
[Brimag field-service source-to-target map](brimag-field-service-map.md).

## Locally verified gates

The following commands completed successfully from the repository root:

| Command                                                      | Result                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`                                          | Passed; all matched files use the configured Prettier style.                                           |
| `pnpm lint`                                                  | Passed; Next.js route types generated and ESLint reported no warnings or errors.                       |
| `pnpm typecheck`                                             | Passed across all 11 applicable TypeScript workspaces.                                                 |
| `pnpm test`                                                  | Passed: 977 tests; 69 explicit environment-gated tests skipped.                                        |
| `uv run pytest -p no:cacheprovider`                          | Passed: 1,064 tests; 133 explicit environment-gated tests skipped; 5 warnings.                         |
| `pnpm build`                                                 | Passed; all packages, workers, and the Next.js production application compiled.                        |
| `pnpm contracts:check`                                       | Passed; generated contracts match the committed contract files.                                        |
| `uv run python scripts/db_verify.py offline`                 | Passed; one Alembic head (`b72c5f0e4d91`), 68 revisions, schema contract valid, offline SQL generated. |
| `pnpm peers check`                                           | Passed.                                                                                                |
| `pnpm audit --audit-level critical`                          | Passed; no critical package vulnerability was reported.                                                |
| `uv run python scripts/pip_audit.py`                         | Passed; no known vulnerability, with one documented time-bounded repository exception.                 |
| `git diff --check`                                           | Passed; no whitespace errors.                                                                          |

The TypeScript test total includes the CRM domain and query contracts,
authorization, feature controls, web routes and responsive report rendering,
private-object validation, WhatsApp worker contracts, and existing application
regressions. PostgreSQL-dependent tests remain explicitly skipped unless an
isolated test database is supplied.

The offline migration verification generated 373,206 bytes of SQL with SHA-256
`68bf55c7b04d740de9e0d7412034dc9ffa14d6f607653e522dd1a50add554a2a`.

## Environment-gated validation

These checks are not claimed as completed:

- **Live PostgreSQL migration and RLS execution:** no explicit isolated
  `TEST_DATABASE_URL` was configured. The configured local migration endpoint
  at `127.0.0.1:5433` was unreachable, and the local Docker daemon was not
  running. Offline Alembic generation and schema-contract validation passed.
- **Browser interaction and visual screenshots:** a provider-disabled production
  server was started against an intentionally unreachable database. The login
  route failed closed with the generic unavailable state, so authenticated
  workflow and layout evidence remains blocked. Component-level English, Hebrew
  RTL, responsive upload, report-branding, and navigation tests passed; the
  local server was stopped after the check.
- **Meta, calendar, OCR/LLM, object-store, and call-provider behavior:** no live
  provider action was performed. Automated checks use synthetic fixtures and
  provider simulators. The current cloud-object configuration deliberately
  fails closed until a private adapter is configured.
- **Repository aggregate `verify`:** the safety preflight correctly refused to
  run while the local `.env` had real WhatsApp, telephony, voice-provider, and
  automatic-call flags enabled. Those user-managed values were not changed.

## Toolchain note

This workstation used Node.js 25.9.0. The repository declares
`>=24.20.0 <25`, so pnpm emitted an engine warning even though every command
above completed. CI and deployment builds should use a supported Node 24.x
runtime before treating the environment as release-equivalent.

## Remaining release proof

Before enabling the module in a deployed environment:

1. Provision an isolated PostgreSQL test database and run the online migration,
   rollback, RLS, concurrency, and worker integration tests.
2. Run the application with synthetic tenant fixtures and complete desktop and
   mobile browser checks in both locales and themes.
3. Configure private object storage and protected-field secrets, then exercise
   upload/download integrity and retention using non-customer files.
4. Connect provider sandboxes one at a time and validate Meta retries, OCR
   failure recovery, and calendar read-only/write policies without real
   customer communication or calendar changes.
