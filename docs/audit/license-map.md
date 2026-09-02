# License and provenance map

This is an engineering inventory, not legal advice.

## Repository licenses

| Source | License status | Required handling |
| --- | --- | --- |
| Or-on | No top-level license file, NOTICE/COPYING file, or package license metadata was found. The master prompt classifies it as private proprietary target-project code. | Keep private. Do not assign a public license. Obtain owner confirmation before external distribution or open sourcing. Preserve source SHA and authorship history. |
| WACRM | MIT; copyright 2026 Arnas Donauskas. | Include full MIT notice in `THIRD_PARTY_NOTICES.md` and in copies/substantial portions as appropriate. |
| OpenLive | MIT; copyright 2026 Yashwanth Reddy Katipally. | Include full MIT notice in `THIRD_PARTY_NOTICES.md` and in copies/substantial portions as appropriate. |

## Explicit non-repository license evidence

| Item | Source evidence | Status / required action |
| --- | --- | --- |
| ZipVoice model/code | OpenLive docs/code identify Apache-2.0 | Retain notice and model provenance/checksum; verify downloaded artifact's exact license before shipping. |
| Supertonic model | OpenLive `supertonic.ts` identifies OpenRAIL-M; implementation adapted from an MIT reference | Material license condition. Review OpenRAIL-M use/distribution restrictions and include both applicable notices. |
| Tremor-derived chart utilities | WACRM files contain Apache-2.0 comments | Preserve attribution/license notices for retained files. |
| Krisp SDK and `.kef` models | Or-on code says separately licensed vendor wheel/model | Do not redistribute without explicit entitlement. Keep optional and externally supplied. |
| RenikudPlus / RenikudPlus weights | Or-on auto-downloads `notmax123/RenikudPlus` | PyPI package 0.5.0 declares MIT and the current model card declares Apache-2.0, but historical repository metadata also reports CC-BY-4.0. Pin an exact revision/hash and verify its bundled license before any download/distribution. |
| ECAPA gender model weights | Or-on downloads `JaesungHuh/voice-gender-classifier`; architecture is ported from Jpost/TaoRuijie code | Model and TaoRuijie base declare MIT. Record the exact intermediate Jpost source/notice before importing or distributing the retained architecture. |
| Silero, Whisper, Smart-Turn, Kokoro, ONNX model assets | OpenLive downloads/caches these through packages/URLs | Resolve each model and code license, permitted redistribution, and notice obligations; record model hashes. |
| Fonts | WACRM/OpenLive use Next-managed Google fonts (for example Geist) | Verify font license and whether self-hosting/bundling is required for the target VM/privacy posture. |
| Icons/logos | Lucide plus source/agent/provider icons and product assets | Lucide is ISC in WACRM lock metadata. Brand logos may be trademarked even when source code is MIT; review use in unified branding. |
| Electron/desktop assets | OpenLive app icons/install assets | Covered by repository MIT only where original; confirm third-party marks/assets separately. |

## Lockfile observations

- WACRM's main npm lock has 803 non-root records and declares licenses including MIT, Apache-2.0, BSD, ISC, MPL-2.0, LGPL-3.0-or-later, CC-BY-4.0, CC0, BlueOak, Python-2.0, and compound expressions.
- Examples needing notice/review include Sharp/libvips packages (Apache/MIT/LGPL combinations), Lightning CSS (MPL-2.0), Axe Core (MPL-2.0), caniuse-lite data (CC-BY-4.0), argparse (Python-2.0), Lucide (ISC), and TypeScript (Apache-2.0).
- WACRM MCP's lock has 96 non-root records with MIT/Apache/BSD/ISC families.
- Or-on's `uv.lock` has 205 package records. It does not provide a complete checked-in license report.
- OpenLive's pnpm lock has approximately 765 package keys. A complete license inventory is not embedded in a directly usable report.

These observations are not a substitute for a generated dependency SBOM/license scan.

## Required notices and gates

- Phase 1: create `THIRD_PARTY_NOTICES.md` containing the complete WACRM and OpenLive MIT notices.
- Before copying files: record target path -> source SHA/path -> applicable license in the provenance manifest.
- Before container/model distribution: generate SBOMs and dependency license reports for Python, pnpm, Docker images, browser models, native binaries, fonts, and assets.
- Block release on unresolved strong-copyleft/source-offer obligations, model-use restrictions, proprietary model redistribution, or missing attribution.
- Do not infer that an upstream repository's MIT license covers third-party model weights, vendor SDKs, trademarks, fonts, or copied snippets.
- Keep OpenLive voice cloning accompanied by consent/anti-impersonation UX and documentation; this is a product/legal safety requirement independent of copyright licensing.

## Current legal/provenance blockers

| ID | Blocker | Release impact |
| --- | --- | --- |
| L-01 | Or-on ownership/license terms are not recorded in the repository. | Target must remain private; external distribution requires owner confirmation. |
| L-02 | RenikudPlus and ECAPA model/code provenance is incomplete in-repo. | Do not bundle/distribute those artifacts until resolved. Runtime download may also carry obligations requiring review. |
| L-03 | Supertonic OpenRAIL-M conditions have not been reviewed for the intended product use. | Do not claim unrestricted model use. |
| L-04 | Full transitive Python/pnpm/container license reports do not yet exist. | Required before Phase 10 completion or external deployment distribution. |
| L-05 | Brand/provider/coding-agent logos may have trademark restrictions. | Use needs a brand-asset review; code license alone is insufficient. |
