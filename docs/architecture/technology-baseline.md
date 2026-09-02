# Technology baseline

Status: Accepted for Phase 1 foundation
Discovery date: 2026-08-31 (Asia/Jerusalem)

## Selection method

The target selects the newest stable, supported, security-patched release that
can preserve required source behavior. Upstream versions are evidence of proven
compatibility, not permanent target pins. Prereleases and unsupported runtime
lines are excluded. Major upgrades are isolated and must pass the relevant source
behavioral suite before later feature ports adopt them.

Version evidence was read from the locked source manifests/lockfiles and queried
from official project documentation, npm, PyPI, Docker Hub, GitHub project
releases, and the Terraform Registry on 2026-08-31. Registry `latest` tags were
used only when they represented stable releases.

Authoritative support/release sources:

- [Node.js releases](https://nodejs.org/en/about/previous-releases)
- [Python release versions](https://www.python.org/doc/versions/)
- [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/)
- [Next.js release and security announcements](https://nextjs.org/blog)
- [React releases and security announcements](https://react.dev/blog)
- [TypeScript 7 release notes](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [LiveKit self-hosting documentation](https://docs.livekit.io/transport/self-hosting/)
- [PyPI](https://pypi.org/), [npm](https://www.npmjs.com/),
  [Docker Hub Official Images](https://hub.docker.com/search?image_filter=official),
  and [Terraform Registry](https://registry.terraform.io/)

## Runtime baseline

| Technology | Locked upstream state | Current stable/support state | Selected target | Compatibility/security decision |
| --- | --- | --- | --- | --- |
| Node.js | WACRM `>=20`; OpenLive `>=22.13`; Or-on CI 22 | 26.8.1 Current; 24.20.0 LTS; 22 LTS; 20 is EOL | **24.20.0 LTS (Krypton)** | Official Windows binary ran successfully. It satisfies pnpm, Next, Hono, ESLint, Vitest, and OpenLive's minimum. Current/EOL lines are not selected. |
| pnpm | OpenLive 11.5.2; WACRM npm 10.9.9 | npm registry latest stable 11.24.0; requires Node `>=22.13` | **11.24.0** | Ran under Node 24.20.0. It is the only target JS package manager. npm remains source evidence only. No Turborepo in Phase 1. |
| Python | Or-on `>=3.12`, tool target 3.12; lock has 3.13/3.14 markers | 3.14.7 is latest stable feature-line patch | **3.14.7**, `>=3.14,<3.15` | Core and voice/native import gates passed. This is newer than the proven 3.12 baseline without rewriting voice dependencies. |
| uv | Or-on lock/workflow; host began at 0.11.26 | PyPI stable 0.12.7 | **0.12.7** | Host updated and Python 3.14.7 provisioned successfully. |
| PostgreSQL | Or-on dev/CI 18; deployment 16; WACRM PostgreSQL via Supabase | 18.6 is current minor of newest supported major; supported to 2030-11-14 | **18.6** | Matches Or-on's newer tested major. Use `postgres:18.6-bookworm`; pin the image digest when the daemon is available. No other target runtime database. |

PostgreSQL major upgrades require dump/restore or `pg_upgrade`; minor updates are
the normal security/bug-fix path. The platform follows the current minor within
major 18 rather than pinning an old minor indefinitely.

## Web and TypeScript baseline

| Technology | Locked upstream version | Current stable | Selected target | Compatibility and breaking-change notes |
| --- | --- | --- | --- | --- |
| Next.js | WACRM 16.2.12; OpenLive lock 16.2.10 | 16.3.3 Active LTS | **16.3.3** | Required security upgrade: the official August 2026 release fixes critical vulnerabilities. Phase 1 uses App Router and reads bundled `node_modules/next/dist/docs` before version-specific work. |
| React / React DOM | WACRM 19.2.4; OpenLive lock 19.2.7 | 19.2.8 | **19.2.8** | Same supported 19.2 line, with later security/fix patches than vulnerable early RSC releases. |
| TypeScript | WACRM 6.0.3; OpenLive/Or-on 5.9.x | 7.0.2 | **6.0.3** (documented fallback) | TypeScript 7 is stable and substantially faster, but exposes no compiler API in 7.0 and `typescript-eslint` 8.69 supports `<6.1`. Select the newest compatible bridge until Next/ESLint/source builds prove TS 7 adoption. This is not an optional framework replacement. |
| Tailwind CSS | WACRM 4.3.3; OpenLive 4.3.2 | 4.3.3 | **4.3.3** | Patch alignment; CSS-first configuration and semantic CSS variables. |
| next-intl | WACRM 4.13.5 | 4.14.1 | **4.14.1** | Latest stable; initial shell remains locale-ready while full English/Hebrew catalogs are deferred. |
| Zod | WACRM MCP/OpenLive 3.25.76 lock | 4.5.4 | **4.5.4 for new contracts/config** | Existing OpenLive/WACRM adapters may retain Zod 3 at their boundary until behavior tests support migration. Avoid a big-bang schema rewrite. |
| ESLint | WACRM 9.x | 10.9.1 | **10.9.1** | Use the supported flat configuration and Next's official plugin directly. The aggregate `eslint-config-next` pulls legacy peer ranges, so the monorepo composes `@next/eslint-plugin-next` with current `typescript-eslint` instead of pinning unsupported ESLint 9. |
| Vitest | WACRM 4.1.10; OpenLive 3.2.7 | 4.1.11 | **4.1.11** | Supports Node 24; used for TS package/service tests. |
| Prettier | WACRM 3.9.6 | 3.9.6 | **3.9.6** | Stable formatter; formatting changes remain scoped. |

### Important UI libraries

These are approved compatibility baselines, not a requirement to install every
library in the Phase 1 shell.

| Library | Locked upstream | Current stable / target | Treatment |
| --- | --- | --- | --- |
| Base UI | WACRM 1.6.0 | 1.7.0 | Preserve/adapt for useful accessible primitives when porting WACRM. |
| XYFlow React | WACRM 12.11.2; Or-on 12.10.1 lock | 12.11.5 | Preserve for later flow editors; do not implement the canonical engine now. |
| Dagre | WACRM 3.1.0; Or-on 1.1.x | 3.1.1 | Preserve WACRM layout behavior; test Or-on graph transforms before upgrade. |
| DnD Kit core | WACRM 6.3.1 | 6.3.1 | Preserve where source UI needs it. |
| Lucide React | WACRM 1.30.0; OpenLive 0.469.0 | 1.38.0 | Selected icon baseline; provider/brand logos remain a separate trademark review. |
| next-themes | OpenLive 0.4.6 | 0.4.6 | Preserve theme behavior; initial shell may use a small first-party theme bootstrap to avoid client flash. |

## Python backend baseline

| Package | Or-on locked | PyPI stable | Selected Phase 1 | Result / rationale |
| --- | ---: | ---: | ---: | --- |
| FastAPI | 0.139.0 | 0.141.1 | **0.141.1** | Python 3.14.7 import passed. |
| Pydantic | 2.13.4 | 2.13.5 | **2.13.5** | Import/validation passed. |
| pydantic-settings | 2.14.2 | 2.15.0 | **2.15.0** | Selected for typed startup configuration. |
| SQLModel | 0.0.39 | 0.0.42 | **0.0.42** | Python 3.14.7 import passed; no Phase 1 domain-schema rewrite. |
| SQLAlchemy | 2.0.51 | 2.0.52 | **2.0.52** | Async PostgreSQL foundation only. |
| asyncpg | 0.31.0 | 0.31.0 | **0.31.0** | CPython 3.14 wheels exist; import passed. |
| Alembic | 1.18.5 | 1.19.1 | **1.19.1** | Import passed; sole migration authority. |
| httpx | 0.28.1 | 0.28.1 | **0.28.1** | Preserve Or-on HTTP-client convention. |
| PyJWT | Not used by retained Or-on control routes | 2.13.0 | **2.13.0** | Phase 5 verifies short-lived HS256 BFF-to-control assertions with pinned issuer, audience, algorithm, required claims, and a 120-second maximum lifetime. |
| tzdata | Implicit host database | 2026.3 | **2026.3** | Official PyPI stable fallback makes IANA calling windows deterministic on Windows and minimal containers; no host timezone database assumption. |
| Uvicorn | 0.51.0 | 0.52.4 | **0.52.4** | Stable ASGI runtime for minimal service foundations. |
| Ruff | 0.15.21 | 0.16.5 | **0.16.5** | Target `py314`; source-wide reformatting is prohibited. |
| Pyrefly | 1.1.1 | 1.2.0 | **1.2.0** | Preserve Or-on's typing strategy; package paths are passed explicitly. |
| pytest | 9.1.1 | 9.1.1 | **9.1.1** | Unit tests use `uv run pytest`; database tests use isolated development DBs. |

The core gate provisioned Python 3.14.7 in an isolated `uv` environment and
successfully imported FastAPI 0.141.1, Pydantic 2.13.5, SQLModel 0.0.42,
Alembic 1.19.1, httpx 0.28.1, and asyncpg 0.31.0.

## Voice and telephony baseline

Phase 1 does not ship the voice engine. These pins establish compatibility and
prevent later unreviewed upgrades.

| Technology | Or-on locked/source | Current stable | Selected direction | Phase 1 compatibility result |
| --- | --- | --- | --- | --- |
| Pipecat | 1.7.0 | 1.8.1 | **1.8.1 candidate** | Python 3.14.7 import with required Or-on extras passed. Full Or-on behavioral tests are mandatory in the isolated voice upgrade group before Phase 5 adoption. |
| LiveKit Python API | 1.2.0 | 1.2.1 | **1.2.1 candidate** | Imported with Pipecat gate. |
| LiveKit server | floating source image | v1.13.6 | **v1.13.6** | P5-011 pins multi-platform image digest `sha256:e37d68…a815`; local HTTP control port is loopback-only. |
| LiveKit SIP | floating source image | v1.13.0 | **v1.13.0** | P5-011 pins digest `sha256:80bf1f…58d3`; SIP/RTP remain private and the read-only SIP API proves Redis-backed control-plane connectivity. |
| Renikud Plus | 0.3.0 | 0.5.0 | **0.5.0 candidate** | Module import passed. Or-on Hebrew fixtures and model-license review gate adoption. |
| PyTorch | 2.13.0 | 2.13.0 | **2.13.0** | CPython 3.14 CPU wheel imported. |
| Torchaudio | 2.11.0 | 2.11.0 | **2.11.0** | Imported with PyTorch 2.13 in the source-resolved combination. |
| Python ONNX Runtime | 1.24.4 resolved | 1.29.0 | **1.24.4 for Pipecat voice** | Pipecat 1.8.1 constrains `onnxruntime~=1.24.3`; 1.24.4 imported on Python 3.14. Do not force 1.29 into this environment. |
| Soniox / Google speech adapters | Pipecat extras | Provider/API managed | **Preserve adapters** | No provider traffic; fixture/contract tests required in Phase 5. |
| OpenTelemetry/Phoenix instrumentation | OTel 1.44; OpenInference 2.0.1; Phoenix OTel 0.16.1 | OTel 1.44; OpenInference 2.0.3; Phoenix OTel 0.17.1 | **Latest listed patches** | Imported during the Python 3.14 voice gate; no telemetry exported. |

The Phase 5 recheck on 2026-09-02 installed an isolated 147-package environment and imported
Pipecat, LiveKit API, Renikud, PyTorch, Torchaudio, ONNX Runtime,
OpenTelemetry, and safetensors. It performed no model download, call, provider
request, or upstream write. The isolated voice environment also passed a fresh
`pip-audit` scan. Detailed selection and model-license boundaries are recorded in
[`telephony-compatibility.md`](telephony-compatibility.md).

## OpenLive runtime baseline

These versions are approved candidates for later OpenLive adaptation. Only Hono,
WebSocket contracts, and small service foundations are expected in Phase 1.

| Technology | OpenLive locked | npm stable | Selected direction | Notes |
| --- | ---: | ---: | ---: | --- |
| Hono | 4.12.28 | 4.13.5 | **4.13.5** | Preserve Hono. The Node server adapter moves from 1.19.14 to **2.1.1** only after its minimal service boot test passes. |
| `ws` | 8.21.0 | 8.21.3 | **8.21.3** | Patch update; authenticated product protocol remains deferred. |
| Transformers.js | 4.2.0 | 4.2.0 | **4.2.0** | Preserve single-copy override to avoid ONNX runtime conflicts. |
| ONNX Runtime Web | 1.27.0 | 1.29.0 | **1.29.0 candidate** | Browser/WebGPU tests required when Live Lab is ported. Independent from Python voice ONNX pin. |
| VAD Web | 0.0.29 | 0.0.30 | **0.0.30 candidate** | Preserve browser-local audio invariant. |
| Kokoro JS | 1.2.1 | 1.2.1 | **1.2.1** | Preserve browser-local TTS. |
| ACP SDK | 1.2.1 | 1.4.0 | **1.4.0 candidate** | Protocol/agent fixtures required before Phase 6 adoption. |
| MCP SDK | 1.29.0 | 1.30.0 | **1.30.0** | Also aligns with WACRM MCP's current locked 1.30.0. |
| Sherpa ONNX Node | 1.13.4 | 1.13.6 | **1.13.6 candidate** | Native desktop/platform build tests required; voice cloning remains optional and consent-gated. |

## Infrastructure baseline

| Component | Upstream state | Current stable | Selected target | Notes |
| --- | --- | --- | --- | --- |
| PostgreSQL image | 18 dev/CI; 16 Alpine deployment | 18.6 | `postgres:18.6-bookworm` | Core Compose service; loopback host binding only. Digest pin follows daemon-backed pull inspection. |
| Redis image | 7 Alpine | Redis 8.10 line current | `redis:8.10.1-alpine` | P5-011 pins digest `sha256:becdda…f0576`; private, ephemeral LiveKit/SIP coordination only, never application truth. |
| Caddy | floating `2-alpine` | 2.11.4 | `caddy:2.11.4-alpine` | Architecture/config foundation; public routing is not enabled in Phase 1. |
| Node base image | 20 Alpine upstream WACRM | 24.20.0 LTS | `node:24.20.0-bookworm-slim` | Debian slim preferred over musl for native-module compatibility. |
| Python base image | 3.12 slim upstream | 3.14.7 | `python:3.14.7-slim-bookworm` | Matches selected runtime; voice-native image compatibility remains a separate build. |
| Terraform | no target baseline | 1.16.0 stable | `>=1.16.0,<1.17.0` | Phase 1 structure/validation only; no apply and no GCP credentials required. |
| Google provider | no target baseline | 8.0.0 | `~>8.0` candidate | Pin only when real resources are implemented; Phase 1 documents the resource graph. |

Relevant GitHub Actions stable majors discovered from official project releases:

- `actions/checkout@v7` (latest patch 7.0.1)
- `actions/setup-node@v7`
- `astral-sh/setup-uv@v10`
- `pnpm/action-setup@v6`
- `docker/setup-buildx-action@v4`
- `docker/build-push-action@v7`

CI actions are pinned to immutable commit SHAs when practical, with the readable
major noted in comments. A scheduled dependency process may refresh those SHAs.

## Security state and exceptions

- Next.js 16.2.x is not selected: official August 2026 guidance requires 16.3.3
  to remediate critical issues.
- Early React 19.2 RSC releases had critical vulnerabilities; the target uses the
  latest patched 19.2.8 release.
- Node 20 and 25 are EOL and are rejected. Node 24 LTS is selected.
- PostgreSQL uses the current 18.6 minor because the project explicitly advises
  running the current minor for fixes, including security and data-integrity fixes.
- TypeScript 7 is an explicit compatibility fallback, not an ignored upgrade.
  Re-evaluate when the lint/compiler-API ecosystem and both source applications
  pass together.
- `pnpm audit`, `uv` dependency scanning, container scanning, and SBOM generation
  remain verification gates after target lockfiles/images exist. No unresolved
  critical vulnerability exception is accepted silently.

## Upgrade groups and ownership

1. Runtime: Node 24 LTS, pnpm 11, Python 3.14, uv 0.12.
2. Web framework: Next 16.3, React 19.2, Tailwind 4.3, next-intl 4.14.
3. TypeScript/tooling: TypeScript 6, ESLint 10, Vitest 4, Prettier 3.
4. Python foundation: FastAPI/Pydantic/SQLModel/Alembic and tooling.
5. Voice/telephony: Pipecat, LiveKit, speech/native dependencies.
6. OpenLive browser AI: Transformers/ONNX/VAD/TTS/ACP/native desktop modules.
7. Infrastructure: PostgreSQL/Redis/Caddy/base images/Terraform/actions.

Each group requires a focused commit, lockfile diff, relevant tests/build, breaking
change note, and rollback/reversion path. Automatic dependency updates must not
merge major upgrades without those gates.

## Phase 1 compatibility status

| Gate | Result |
| --- | --- |
| Official Node 24.20.0 binary | Passed; reported LTS codename Krypton. |
| pnpm 11.24.0 on Node 24.20.0 | Passed. |
| Python 3.14.7 core backend imports | Passed. |
| Python 3.14.7 voice/native import smoke | Passed; Pipecat 1.8.1 and source-relevant extras imported. |
| PostgreSQL 18.6 registry/support validation | Passed; daemon-backed health/migration test belongs to P1-008/P1-009. |
| TypeScript 7 ecosystem gate | Failed by design: `typescript-eslint` current peer range is `<6.1`; fallback selected. |
| Target TypeScript build / Next production build | Passed on Node 24.20.0/pnpm 11.24.0; all workspace packages and Next 16.3.3 production output built. |
| Container image pull/build and digest recording | Pending Docker availability and P1-008/P1-022. |

No upstream dependency installation, provider call, model download, real message,
real telephone call, or Terraform apply occurred during discovery.

## Phase 7 interaction-test tooling — 2026-09-03

Additive development dependencies only; no production framework/runtime upgrade:

| Package | Previous target | Selected stable | Verification |
| --- | --- | --- | --- |
| `@testing-library/react` | absent | 16.3.3 | npm registry version/peers inspected; React 19.2.8 interaction tests pass |
| `@testing-library/dom` | absent | 10.4.1 | npm registry inspected; satisfies React Testing Library peer |
| `jsdom` | absent | 30.0.1 | npm engine constraint accepts pinned Node 24.20.0; DOM interaction tests pass |

Authoritative discovery used `pnpm view <package> version engines peerDependencies`
against the [npm registry](https://registry.npmjs.org/). The three packages are
test-only and do not replace any upstream technology. Frozen lockfile updated;
`pnpm audit --audit-level=critical` reported no known vulnerabilities. The pinned
Node 24.20.0 / pnpm 11.24.0 toolchain, strict TypeScript checks, and Next.js 16.3.3
production build pass. DOM tests are not evidence of browser layout, accessibility
certification, real provider correctness, or production performance.
