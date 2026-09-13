# Runtime image security gate — failed, partially remediated

Executed locally on 2026-09-12 using Syft **1.51.1** and Grype **0.118.0**.
Official Windows archive SHA-256 values were checked before execution:
Syft `5e4bc3e6b6344b4625de0f7aa5351aaa72856d11d78462972de0a101ee2c1c8f`;
Grype `82fb07f246e61526e8f2bf187fc6bb29ed23c7450cda6e9d1868a60fb942fc98`.
The vulnerability database was schema `v6.1.9`, built
`2026-09-12T06:27:25Z`, valid at execution. The scanner downloaded public
vulnerability feeds; **no SBOM, application data or credentials were uploaded**.

## Actual results

Each local image was catalogued using `syft docker:oron-readiness/<service>:<tag>
-o syft-json=<file>`, then `grype sbom:<file> --fail-on high -o json --file <report>`.
Every Grype invocation returned **exit 2**, the configured vulnerability threshold
failure. Build success and import success do not override that gate.

| Runtime | Before: critical / high | After narrow remediation: critical / high | Release status |
| --- | --- | --- | --- |
| web | 7 / 57 | 7 / 52 | blocked |
| messaging-worker | 7 / 57 | 7 / 52 | blocked |
| control-api | 12 / 70 | 12 / 69 | blocked |
| migrator | 12 / 70 | 12 / 69 | blocked |

These are scanner **findings**, not unique vulnerabilities or demonstrated remote
exploits. The patched Node images have 25 unique high/critical vulnerability IDs;
Python images have 38. Duplicates can arise from binary and distribution package
catalogues. They have not been blanket-dismissed or suppressed.

Full baseline and patched artifacts are ignored local evidence in
`.artifacts/readiness/image-scan/`: `<service>.sbom.json`,
`<service>.vulnerabilities.json`, `<service>.security.sbom.json`, and
`<service>.security.vulnerabilities.json`. Baseline tags were subsequently rebuilt
by other acceptance work; use each artifact's exact source image ID, not a mutable
tag, to identify what was scanned.

Patched artifact source image IDs (config identities recorded by Syft/Grype):

| Runtime | Exact scanned image ID |
| --- | --- |
| web | `sha256:89bb7eec7408cd35a6006cd91a6c379619bc4e748db58ab7c3429b57801f87f9` |
| control-api | `sha256:e21e288cc1943f07fedf7af42d1d68995a97d5d7df50073f4cf9ada31d0192f7` |
| messaging-worker | `sha256:474076ec9fce706e4b513d47a2754740307231771393a2c1dcc709b5e248967c` |
| migrator | `sha256:f00b0b890f58ade535b1299c436ffd7725a3f36c12483c56f476385d8990da14` |

Patched scan-report SHA-256 values, in the same order:

```text
web              b7539f52422667ab1135481aa24a74a2c085e43049e0eb2adfae00272e5f237b
control-api      736a8e9135f75d1680eadccd9ee3e94de3fccb70117bf9b0283ddb7e88017464
messaging-worker bc8abc378cf3a28f6902d48727df02f475826ae5a9ed388302fa28f34f8ea28c
migrator         93aa3e52a415cfb3f049aab123225944d7fb16e6a0a7dbe34e0471371643f3cb
```

## Narrow repairs verified

- All four runtime Dockerfiles install the exact Debian Bookworm security package
  `libpcre2-8-0=10.42-1+deb12u1`. A disposable container's refreshed official APT
  catalogue identified this as the only available package upgrade on this baseline.
  The patched SBOMs confirm that exact installed version.
- Node runtime layers remove npm/corepack and their launcher symlinks; the build
  stages retain them. The application starts via `node`, not `npm start`. This
  removes the npm-bundled `brace-expansion` 5.0.7, `ip-address` 10.2.0 and `tar`
  7.5.19 findings rather than upgrading unrelated application dependencies.
  Their locations were `/usr/local/lib/node_modules/npm/...`, not app packages.
- Existing Node 24.20.0, Python 3.14.7 and uv 0.12.7 base images are digest-pinned.
  PostgreSQL 18.6 and all provider flags/settings remain unchanged.
- Four patched builds succeeded into separate `:security-candidate` tags.
  Network-disabled worker compiled adapter/store imports and control API imports
  succeeded. This is not a full authenticated container workflow acceptance.

## Remaining vulnerability triage

Residual Node high/critical findings are OS packages such as glibc, util-linux,
perl-base, ncurses, ACL, zlib and tasn1, with no fixed version reported by the
matching Debian records at scan time. Python also includes OpenSSL and the
base image's system SQLite library (not application SQLite persistence).

Ten Python-image high/critical **binary OpenSSL NVD/CPE** matches report upstream
fixed versions 3.0.21/3.0.22 and newer maintained branches, while the Debian
`libssl3`/`openssl` catalogue still reports `3.0.20-1~deb12u2` with no available
APT update during this check. Example IDs: `CVE-2026-45447`, `CVE-2026-63076`,
`CVE-2026-34180`. Do not equate an upstream fixed version with an installable
vendor package, nor dismiss a finding merely because the vendor has no fix.
Vendor advisory/backport/reachability review and an approved patched base-image
strategy are still required. No broad OS change, custom OpenSSL compilation or
unreviewed vulnerability waiver was introduced to produce a green result.

## Worker lockfile consistency

The legacy `pnpm deploy` packaging pass reports 531 graph entries versus the
initial 524-entry workspace lock policy check. Inspection found 19 distinct
external installed runtime package/version directories, all present in the
reviewed `pnpm-lock.yaml`. Six additional workspace packages are local copies.
Syft also detects `transport@0.0.1` under `pino/test/fixtures/transport/package.json`;
that is an upstream packaged test fixture, not a newly resolved dependency.

`infra/scripts/verify-runtime-lock.mjs` is now an image-build-only guard after
legacy deployment: every external installed manifest must match a package/version
in the reviewed lockfile. The rebuilt worker executed it successfully for **22
installed package records** (including repeated manifests), and ESLint passed.
This demonstrates version consistency, **not byte-for-byte reproducible images**;
base package repositories, image build metadata and scanner feeds have their own
provenance/retention requirements. Publication always uses immutable image digests.

Next: resolve the remaining high/critical release blockers with vendor evidence,
then rebuild, recatalogue and rescan exact images; repeat container functional and
restore acceptance before separately approved staging publication/deployment.

## Final candidate-image repetition

After final application fixes and head `bfb741c767fd`, all four images were rebuilt
and scanned again using the same valid local vulnerability feed. Artifacts are
`<service>.final.sbom.json` and `<service>.final.vulnerabilities.json` in the same
ignored evidence directory. All four scans again returned exit 2; counts remained
web/worker **7 critical + 52 high**, API/migrator **12 critical + 69 high**.

Exact final SBOM config identities:

| Image | SBOM source image ID |
| --- | --- |
| web | `sha256:85ff7fe7897d0f6cca8e74e89138a7e58003a8af63ac22e8397abd5fd9563893` |
| control-api | `sha256:e21e288cc1943f07fedf7af42d1d68995a97d5d7df50073f4cf9ada31d0192f7` |
| messaging-worker | `sha256:69d1872bf65d74d950faef1b0dbb519adb558bb79a9e1141df170068c2058aa2` |
| migrator | `sha256:e2bdf3fcec5fdc3d9d6448bdad0aaa63269b88bf40a881fe454c46cb368174f7` |

Final disposable startup/restore and web rollback smoke passed separately. Those
results do not override the failed security gate. No registry publication occurred.
