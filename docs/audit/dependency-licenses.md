# Dependency license audit snapshot

This Phase 0 snapshot uses only checked-in metadata. It does not run package-manager installation, network resolution, or a license scanner.

## WACRM locked direct dependencies

| Dependency | Locked version | Lockfile license |
| --- | ---: | --- |
| `@base-ui/react` | 1.6.0 | MIT |
| `@dagrejs/dagre` | 3.1.0 | MIT |
| `@dnd-kit/core` | 6.3.1 | MIT |
| `@supabase/ssr` | 0.12.0 | MIT |
| `@supabase/supabase-js` | 2.108.2 | MIT |
| `@xyflow/react` | 12.11.2 | MIT |
| Next.js | 16.2.12 | MIT |
| React | 19.2.4 | MIT |
| Recharts | 3.10.1 | MIT |
| Lucide React | 1.30.0 | ISC |
| Tailwind CSS | 4.3.3 | MIT |
| TypeScript | 6.0.3 | Apache-2.0 |
| Vitest | 4.1.10 | MIT |
| `opus-recorder` | 8.0.5 | MIT |

WACRM MCP direct locked dependencies: MCP SDK 1.30.0 (MIT), Zod 3.25.76 (MIT), TypeScript 5.9.3 (Apache-2.0).

## WACRM non-permissive or attribution-relevant transitive examples

| Package family | License metadata | Note |
| --- | --- | --- |
| `@img/sharp-libvips-*` | LGPL-3.0-or-later | Verify dynamic-link/distribution handling in container/standalone output. |
| Sharp platform builds | Apache-2.0 / MIT / LGPL compound expressions | Preserve notices and verify actual artifact composition. |
| Lightning CSS and platform packages | MPL-2.0 | File-level copyleft/notice obligations need compliance. |
| Axe Core | MPL-2.0 | Test/tooling still belongs in SBOM/license report where distributed. |
| caniuse-lite data | CC-BY-4.0 | Attribution requirement. |
| argparse | Python-2.0 | Preserve notice. |

## Or-on dependency-license gaps

The checked-in `uv.lock` contains 205 package records but no complete license report. Direct packages include Pydantic, phonenumbers, SQLModel, SQLAlchemy, asyncpg, FastAPI, Uvicorn, LiveKit API, Pipecat, RenikudPlus, Torch/Torchaudio, cryptography, Google Cloud SDKs, OpenTelemetry/Phoenix, openpyxl, httpx, Loguru, and testing tools.

Required Phase 1 action: generate a `uv`/Python SBOM and license report from the locked environment without changing upstream. Explicitly include native/ML wheels and downloaded model artifacts; package license and model license are separate.

## OpenLive dependency-license gaps

The pnpm lock contains approximately 765 package keys but no complete checked-in license report. Important direct families include Next/React/Tailwind, Hugging Face Transformers, ONNX Runtime Web, VAD Web, Kokoro, Electron/electron-builder, Hono, WebSocket, Zod, ACP/MCP SDKs, sherpa-onnx, GSAP, Zustand, and TanStack Query.

Required Phase 1 action: generate pnpm and Electron SBOM/license reports for each platform build. Separately inventory downloaded voice/STT/TTS/end-turn/vision models, because lockfile metadata does not cover remote artifacts.

## Container image license and pinning review

Images referenced upstream include Python 3.12 slim, Node 20/22 Alpine, nginx Alpine, PostgreSQL 16/18, Redis 7 Alpine, LiveKit server/SIP, Phoenix 12.7.0, and Caddy 2 Alpine. Several references are major/floating tags rather than immutable digests. Phase 1/9 must pin the selected images, record their base-image licenses/SBOMs, and scan final images.

## Exit criteria for the dependency-license gate

- Machine-readable SBOM per shipped image/application/desktop artifact.
- License expression, copyright/notice source, and distribution classification for every shipped dependency.
- Model registry with source URL, version/revision/hash, license, storage location, and redistribution decision.
- Resolved Or-on proprietary ownership and all high-risk model/SDK gaps from [license-map.md](license-map.md).
- Generated `THIRD_PARTY_NOTICES.md` validated in CI.
