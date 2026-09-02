# Repository layout and ownership

## Intended hierarchy

```text
apps/
  web/                         unified Next.js product shell and BFF
  desktop/                     future retained OpenLive Electron wrapper
services/
  py/
    control-api/               PostgreSQL/control boundary and OpenAPI authority
    dispatcher/                retained Or-on orchestration composition entrypoint
    voice-agent/               future retained Or-on voice entrypoint
  ts/
    live-agent/                future OpenLive Hono/WebSocket/ACP host
    messaging-worker/          future WhatsApp/automation durable worker
packages/
  py/
    oron-dispatcher/           retained per-call engine and signed webhook contracts
    oron-common/               retained shared primitives and logging
    oron-db/                   retained SQLModel/PostgreSQL session foundation
    oron-flows/                retained flow schema and validation model
    oron-secrets/              retained secret-provider boundary
    oron-tenancy/              retained tenant/user/membership control plane
    oron-sessions/             retained session, contact, and call lifecycle
    platform-integration/      new cross-system configuration/contracts only
    README.md                  preserved Or-on package import direction
  ts/
    ui/                        design tokens and reusable primitives
    contracts/                 language-neutral schema assets and TS views
    api-client/                generated control-api client and wrapper
    config/                    typed environment parsing and provider safety
    observability/             structured logging and correlation helpers
    platform-integration/      new cross-system composition, not source rewrites
    README.md                  package ownership and boundary rules
db/
  alembic/                     sole target migration history
  importers/                   future isolated legacy readers
  seeds/                       deterministic PII-free development seeds
  tests/                       PostgreSQL migration/RLS integration tests
infra/
  compose/                     localhost core and future optional profiles
  caddy/                       one-origin proxy foundation
  terraform/
    modules/                   only reusable resource groups that earn a module
    environments/dev/          one-VM GCP development environment
  scripts/                     infrastructure-specific operations
docs/
  audit/                       immutable source facts and provenance plan
  adr/                         architecture decision records
  architecture/                current target design
  plans/                       implementation plans
  runbooks/                    operator/developer procedures
  security/                    threat model and security decisions
  progress.md                  executable phase ledger
scripts/                       cross-repository developer and verification tools
.github/workflows/             consolidated target-only CI
```

Directories are created only when they contain implemented code/configuration or
a concise ownership README. `apps/desktop` is not created as an empty
placeholder. Retained Or-on packages are added incrementally only after their
dependency, provenance, security, and compatibility gates pass.

## Naming policy

Retained Or-on packages keep names such as `oron-db`, `oron-tenancy`,
`oron-sessions`, and `oron-flows`. New `platform-*` packages contain genuinely
new integration behavior and never renamed copies of an upstream package.

TypeScript packages use the private `@or-on/*` namespace. Python distribution
names use `or-on-*` and import names use `or_on_*` only for new integration code;
retained `oron_*` imports remain unchanged.

## Public boundaries

- TypeScript packages expose documented root exports. Cross-package deep imports
  are forbidden by the architecture check.
- Web features expose a local public index; cross-feature deep imports are
  forbidden.
- Generated sources live below `generated/` and are never hand-edited.
- Cross-language payloads originate from OpenAPI or versioned JSON Schema, not
  duplicated handwritten models.
- Runtime code cannot reference `../or-on`, `../wacrm`, or `../openlive`.

## Source provenance

Phase 1 contained no copied business implementation. Phase 5 imports retained
Or-on packages from the locked private source and records each copied/adapted
artifact in `docs/audit/source-map.md`. Any later copied/adapted file must add the
same source repository, locked commit, source path, target path, transformation,
reason, and license treatment. WACRM and OpenLive substantial copies retain their
MIT notices.
