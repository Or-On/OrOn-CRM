# Readiness verification evidence — 2026-09-12

## Scope and reproducibility

**Update:** the reviewed source delta has since been applied to the original
checkout. New merged-tree results are in [application-merge.md](application-merge.md).
The table below retains the earlier isolated candidate evidence; it is not a
claim that the user's application database was upgraded or real workers restarted.

Application evidence applies to the isolated candidate at
`.artifacts/readiness/candidate`, **not the active development application**.
Infrastructure and this documentation are in the original checkout. See the
[baseline](baseline.md) and [conflict-safe file manifest](candidate-changes.md).
No commit, push, cloud deployment or live provider operation was performed.

Windows; Node 24.20.0, pnpm 11.24.0, uv 0.12.7, Python 3.14.7.
The candidate has independent dependencies, no developer `.env`, and disabled
real messaging, voice, AI auto-call and billing execution. Database tests use the
task-owned PostgreSQL 18.6 container on loopback port 55439. Production-image
tests use another Compose project, `oron-readiness-stack`, separate volumes and
loopback HTTP port 13880. Neither uses the developer database or queues.

Raw output stays in ignored local artifacts, not source control. Test counts
below overlap where a focused suite is included in a consolidated suite; do not
sum them into an invented unique-test total.

## Recorded checks

| Check | Observed result | Scope / limitations |
| --- | --- | --- |
| Final `pytest -m postgres db/tests/postgres` | **107 passed, 66.67 s** | Real PostgreSQL; migrations, roles/RLS, cross-tenant constraints, imports, jobs, billing and authorization races |
| Alembic upgrade/current | **57 revisions, head `bfb741c767fd`**, one root `0001`, preserved historical branch/merge | Four readiness successors; original head `eb2660eb37ec`; preserved Or-on migration files |
| CRM isolated PostgreSQL suite | **88 passed, 1 alternate-DB skip** | Actual `platform_web` tenant operations; see application fixes |
| Worker PostgreSQL suites | **11 passed + 13 passed** | Scoped claims, eligibility, ownership and cross-channel persistence; no external sends |
| Billing/fresh authorization focused suite | **32 passed** | Actual lock waits, event binding, downgrade guards; included in final DB suite |
| OAuth focused checks | **8 passed** | Includes six concurrent PostgreSQL credential saves; provider consent not executed |
| Full Python suite | **834 passed, 108 skipped, 5 warnings, 30.25 s** | PostgreSQL skipped here deliberately; 107 collected separately above; other unavailable integration remains skipped |
| Full TypeScript suite | **619 passed, 48 skipped** | Actual workspace Vitest results; separate PostgreSQL suites cover only their recorded paths |
| Consolidated `uv run python scripts/dev.py verify` | **FAILED at expired NLTK exception**, after all preceding stages passed | Full formatting/lint/typing/tests/contracts/migration/build/peer/npm-audit stages ran; gate not weakened |
| Contract freshness and offline SQL | **4 generated files unchanged by SHA-256**, deterministic SQL passed | 247,490 SQL bytes; SHA-256 `5b900b7340ad43470ab71d7946bbd64a6770266777626b1373988cad300c8269` |
| Explicit candidate secret scan | **1,042 source/configuration files, 0 pattern findings** | Filesystem enumeration, independent of parent Git ignore; not full history, entropy analysis or proof no secrets exist |
| Repository/dependency-boundary and documentation guards | Passed in consolidated run | Static checks; no substitute for provider/runtime evidence |
| TypeScript and Python formatting/lint/strict typing | Passed after bounded fixes | Preview stop callback now explicitly returns `None`; no suppressed type error |
| Browser route/action suite | **25/25 passed** | Fictional owner session, production preview, EN/HE, light/dark; not every successful mutation or role |
| Optional voice outage browser test | **2/2 passed** | Contact view/edit remains usable without optional voice service |
| Responsive visual checks | **85 indexed screenshots + 2 outage images** | 360/390/768/1024/1440 widths; measured horizontal overflow zero; manual screen-reader/zoom coverage incomplete |
| Terraform | fmt/validate + **4 mock policy tests passed** | No real GCP plan/apply/state, IAM or cloud API verification |
| Secret materialization | **13 unit tests passed**, isolated Linux permissions passed | Mock gcloud only; mode 0700 directories / 0600 files, symlink/no-overwrite guards |
| Final original infrastructure suite | **77 passed, 0.69 s**, Ruff check/format passed | Includes image/VM deployment guards, backup locking, private paths and Python 3.12 host syntax; cloud subprocesses mocked |
| Image packaging | Four production-mode images built; worker runtime lock check passed | Non-root apps; public assets copied; exact external runtime versions in reviewed lockfile |
| Container security | **FAILED** at high threshold on all four scanned images | See exact image IDs, findings and partial remediation in image-security report |
| Python dependency audit with voice group | **FAILED: NLTK 3.10.3 / PYSEC-2026-3740** | Expired exception not extended; no patched release confirmed by maintainer advisory |
| Compose/Caddy/start/restart | Passed on disposable stack | Login HTTP 200, disabled webhook 404, zero demo users, nonprivileged runtime roles; public TLS not tested |
| Database disconnect | API readiness returned **503**; recovery smoke passed | Stopped only the disposable stack's PostgreSQL; real workers untouched |
| Final backup/new-DB restore | **8.840 s**, 482,997-byte fictional backup at final head | Checksums, schema/counts/head/RLS and fictional contact content; no real media/key recovery; not a production RTO |
| Final web rollback/forward rehearsal | **Passed** with schema held at `bfb741c767fd` | Prior reviewed local image, HTTP/role/schema smoke; not full authenticated financial/worker compatibility acceptance |
| CRM load sample | List p95 **14.14 ms**, search p95 **27.77 ms** | 20k fictional contacts, 2 tenants, concurrency 4; see performance methodology |

Final consolidated output is
`.artifacts/readiness/candidate/.artifacts/final-verify.log`.
Final DB output is the adjacent `final-postgres.log`. The final release decision
records the consolidated completion and outstanding gates; no skipped or
unavailable check is treated as passed.

## Avoid misleading freshness/coverage claims

The ignored candidate is not an independent Git repository. Therefore the
existing `contracts:check` Git-diff step and Git-based secret discovery alone are
insufficient evidence there. Explicit source scanning is recorded above; contract
generation requires file-hash comparison in addition to the ordinary command.
Four contract outputs were hashed before and after explicit regeneration and
were unchanged. The final generated schema manifest and offline SQL graph passed
the repository's database verification script.

Successful browser page loading is not evidence that every action, permission,
race or provider integration works. Detailed source inventories and feature
matrix retain blocked cases: external OAuth/token refresh/mailbox sync, payment
provider acceptance, real telephony, alert delivery, customer onboarding, media
recovery, full non-owner UI coverage and production identity controls.

## Regression and recovery limitations

No customer data was deleted. No histories were rewritten. Four new Alembic
successors preserve the previous lineage. Populated financial recovery bindings
refuse downgrade; revoked API keys stay revoked. Operational recovery uses
schema-compatible images or restore to a **new** isolated database, never an
automatic downgrade or overwrite of newer writes. Encryption keys and media
must be recovered separately before any production cutover.

Candidate originals are guarded by per-file hashes for a later stopped-runner
merge. The initial baseline recorded paths, not a complete pre-task content hash
set; no cryptographic claim of whole-checkout pre-task equivalence is made.
