# Dependency strategy

## Preservation categories

Every significant technology decision is classified:

- **A — Preserved:** proven technology retained with compatible patch/minor
  modernization.
- **B — Adapted:** technology/behavior retained behind a platform boundary or with
  required runtime integration changes.
- **C — Replaced, required:** source technology conflicts with a non-negotiable
  target constraint.
- **D — Replaced, optional:** replacement is not required and needs explicit user
  approval.

No Category D replacement is approved in Phase 1.

| Source area | Category | Direction |
| --- | --- | --- |
| Or-on Python/FastAPI/Pydantic/SQLModel/Alembic/RLS/LiveKit/Pipecat | A | Preserve packages, dependency direction, and behavioral tests. |
| WACRM Next/React/Tailwind/CRM/WhatsApp/XYFlow behavior | A/B | Preserve behavior and useful UI; adapt data/auth/realtime/object access behind BFF and workers. |
| OpenLive browser media/Hono/WebSocket/ACP/MCP/provider harness | A/B | Preserve local media and agent runtime; adapt authentication, contracts, and persistence. |
| Supabase clients/Auth/Realtime/Storage migration authority | C | Remove from target runtime; preserve PostgreSQL concepts and behavior. |
| Firebase authentication/runtime dependency | C | Remove; retain legacy external identity only as migration data. |
| OpenLive SQLite/JSON business persistence | C | Replace with PostgreSQL adapter; keep future isolated importer only. |
| Framework/language rewrites for uniformity | D | Not proposed or performed. |

## Version policy

- Runtime foundations prefer active LTS/current supported stable releases.
- Security patches override exact source version matching.
- Major upgrades are isolated by group and never hidden in feature commits.
- Native/media dependencies keep source-compatible constraints until their focused
  behavioral tests pass.
- Lockfiles and container tags are committed. Container digests are recorded after
  a daemon-backed pull inspection.
- Prerelease channels are prohibited unless a required capability and explicit
  approval justify them.

The exact selected versions and fallbacks are in
[technology-baseline.md](technology-baseline.md).

## Package managers

- pnpm is the only target JavaScript package manager.
- uv is the only target Python workspace/dependency manager.
- No Turborepo is installed in Phase 1. Root pnpm scripts plus recursive filters
  are sufficient at current scale.
- No TypeScript ORM may introduce a migration runner.

## Boundary enforcement

Repository checks inspect manifests and imports for:

- prohibited runtime database/auth clients;
- sibling-repository path dependencies;
- cross-package deep imports;
- Python/TypeScript dependency direction violations;
- a second migration authority;
- filesystem JSON persistence patterns in runtime modules.

Documentation, audit evidence, static fixtures, and explicitly isolated importer
directories are excluded by narrow path rules rather than broad string ignores.

## Security and provenance

Frozen installs are followed by ecosystem audits. Critical vulnerabilities block
the phase unless a documented, time-bounded exception proves non-exploitability and
no compatible patch exists. Dependency/model/container SBOM and notice coverage is
expanded as artifacts become shippable.

The upstream source map remains the code-provenance authority. Phase 1 creates new
foundation code; copied source code is not required for the current proofs.
