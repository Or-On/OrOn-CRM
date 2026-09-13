# GCP DEV verification — 2026-09-12

**Controlled GCP DEV deployment: NOT READY.**
**Customer-facing production: NOT READY.**

Subsequent authorized action: [local schema alignment](local-schema-alignment.md)
completed the verified backup and four migrations. The local database is now
at `bfb741c767fd`; the old-head observation below is historical. GCP blockers remain.

The user clarified: verify the repository first; project, region and hostname
will be supplied later. This follow-up performed verification only. It did not
implement new application/infrastructure code, modify `.env`, migrate the user
database, start workers, provision resources, or deploy. Existing changes remain
preserved; no commit or push was made.

## Fresh verification

Baseline: branch `codex/phase-7-ui-polish`, HEAD
`7afa8534fc89259cd679da7ff58ec7546bd01b14`, 553 changed tracked/nonignored paths
before this report. All **89 reviewed application files still match** the applied
candidate SHA-256 manifest; zero drift. All upstreams remain clean at their locked
SHAs. See [application merge](application-merge.md) for the earlier live database
and browser evidence; those tests were not relabeled as new cloud evidence.

| Check | Fresh result |
| --- | --- |
| Production application/workspace build | Passed, 13.39 s |
| TypeScript strict checks | Passed, 10.10 s |
| TypeScript tests | **639 passed, 48 skipped**, summed across 11 package summaries |
| Python + infrastructure suite | **911 passed, 108 skipped, 5 warnings**, 29.80 s pytest time |
| Infrastructure/secret helper subset | **77 passed**, included in the Python total, not additional unique tests |
| ESLint / Prettier / infrastructure Ruff | Passed |
| Python typing | Passed; existing suppressions/warnings remain reported |
| Repository boundaries / secret pattern checks / documentation | Passed; not a full secret-history audit |
| Alembic offline graph and SQL | Passed: 57 revisions, 22 preserved Or-on, one head `bfb741c767fd` |
| Deterministic PostgreSQL SQL | 247,490 bytes; SHA-256 `5b900b7340ad43470ab71d7946bbd64a6770266777626b1373988cad300c8269` |
| Staging Compose render | Passed with fictional private bundles; no services started |
| Caddy HTTPS configuration | Passed in a network-disabled disposable container using staging UID/capabilities; not live TLS/ACME evidence |
| Terraform formatting / validation | Passed, existing pinned Terraform 1.16.2 / Google 8.2.0 |
| Terraform mock-provider policy tests | **4 passed**, no real cloud plan/apply |
| Python security gate | **Failed**, expired `PYSEC-2026-3740`; no exception extended |
| Container security | Existing same-day reports still fail: web/worker 7 critical + 52 high each; API/migrator 12 critical + 69 high each. These were rechecked, not rescanned in this follow-up. |

The TypeScript count above is the actual sum of the fresh package summaries;
the older 619 summary is not used for this run. Skips are not passes. New logs
are under ignored `.artifacts/readiness/merge-validation/gcp-*.log`, using the
existing sanitized harness, pinned Node 24.20.0, and no developer `.env` loading.
The first Caddy probe omitted the binary's required `NET_BIND_SERVICE` capability
and could not execute; the corrected probe matched staging's configured capability
and passed. No public port or network access was granted to that probe.

## Confirmed repository-controlled gaps

1. **First administrator/account on a fresh database.** The release intentionally
   creates no demo users. The runbook points to invitations, but invitation
   creation already requires an authenticated member with `members:manage`.
   A guarded one-shot first-owner/admin bootstrap is missing. Reusing the local
   fixed development superuser/seed is not an acceptable deployment procedure.
2. **Complete voice packaging and routing.** Staging and its build/release
   manifest contain exactly four application images, not the dispatcher. The
   real-call BFF goes directly to the dispatcher and otherwise defaults to
   `127.0.0.1:8082`, inside the web container. The dispatcher hosts per-call voice
   agents and needs its optional voice dependencies; blindly adding another
   standalone agent would not establish correct ownership. Packaging, internal
   routing, required LiveKit/SIP configuration, readiness and active-call drain
   still need implementation/verification. Provider flags correctly remain off.
3. **Authenticated release acceptance.** `/login` without a cookie skips the
   authentication configuration/database path. API readiness executes `SELECT 1`;
   it does not validate web auth material, cross-service signing-secret agreement,
   voice schema/grants or an authenticated workflow. The release record correctly
   leaves functional smoke pending. Service-bundle cross-validation and actual
   login/permission/service-call acceptance are required.
4. **Reproducible host preparation and restart safety.** Terraform deliberately
   does not prepare the host. The deployment helper requires a root-owned exact-SHA
   checkout, private configuration and separately mounted data disk. Installation,
   reboot ordering and missing-disk refusal before Docker container auto-restart
   need a tested operational procedure. `release.py` dry-run checks only the image
   manifest, not the host/configuration/mount; it is not a host-readiness probe.
5. **Security remediation.** The expired NLTK exception and image scan gate remain
   unresolved. Some OpenSSL binary findings need Debian backport reconciliation;
   that does not clear other confirmed vendor-vulnerable packages. Supported base
   upgrades/mitigations need compatibility tests and complete scans, not blanket
   suppression or silent removal of the working voice engine.
6. **Recovery and operations acceptance.** PostgreSQL restore was previously
   exercised with fictional local data. Actual GCS restore, media/encryption-key
   recovery, backup failure alerts, disk/memory monitoring and authenticated
   recovery are still pending. Existing helper files are not proof those
   operational controls are installed or effective.

Sources for current security triage: [NLTK maintainer advisory](https://github.com/nltk/nltk/security/advisories/GHSA-8mgp-746c-j5xp),
[Debian OpenSSL backport record](https://security-tracker.debian.org/tracker/CVE-2026-45447),
[remaining OpenSSL finding](https://security-tracker.debian.org/tracker/CVE-2026-63076),
and [remaining glibc finding](https://security-tracker.debian.org/tracker/CVE-2026-5450).
No security waiver was made from this evidence.

## Local application database and safety

A read-only query of the explicitly identified local Compose PostgreSQL container
`or-on-platform-postgres-1`, database `or_on_platform_dev`, observed head
`eb2660eb37ec`. The reviewed source expects four successors through `bfb741c767fd`.
**Before restarting the updated local app: take and verify a private backup,
then explicitly apply/check those migrations.** No mutation or queue processing
was performed by this verification. The Docker services present at the start
were unchanged at the final check; the temporary Caddy probe was removed.

This is separate from creating a fresh GCP DEV database. Never upload the local
database, provider credentials or real queues to GCP as an implicit bootstrap.

## Next work, without needing GCP project details yet

Implement/test the first-owner bootstrap and authenticated configuration/smoke
checks; finish retained dispatcher packaging/routing/drain; reconcile and repair
dependency/image security; then rehearse blank-host startup, missing-disk refusal
and recovery. Preserve the full [feature acceptance gaps](feature-matrix.md).
Only after those repository/local gates should cloud metadata and cost approval
be requested for actual IAM, DNS/TLS and deployment validation. OpenLive remains
deferred; this verification does not broaden scope into its integration.
