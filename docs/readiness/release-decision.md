# Release decision — 2026-09-12

**Controlled GCP staging: NOT READY.**

**Customer-facing production: NOT READY.**

Latest follow-up: [GCP DEV verification](gcp-dev-verification.md) records fresh
build/test/configuration checks and confirmed fresh-account, voice packaging and
host-readiness gaps. The user requested verification only before supplying cloud
metadata; no deployment or application/database change was performed in that step.
Subsequently, the user explicitly authorized the [local schema alignment](local-schema-alignment.md):
the private backup/restore rehearsal and four migrations passed. The local database
is now at `bfb741c767fd`; app/workers remain stopped and GCP release gates remain open.

The master prompt was read completely and executed through the current safe
checkpoint: baseline, complete source inventory, bounded hardening, regression
tests, responsive review, measured performance, and runnable guarded staging
artifacts. The assignment is **not declared complete**: remaining workflow and
release gates below cannot be inferred from successful builds.

## What changed and where

The original checkout retains the user's existing changes. No commit, stash,
reset, push or branch change was made. Branch remains `codex/phase-7-ui-polish`,
HEAD `7afa8534fc89259cd679da7ff58ec7546bd01b14`.

Application fixes were **applied to the original checkout** after the user
confirmed the runner was stopped and requested the merge. All 89 reviewed file
hashes matched; see [merged verification](application-merge.md). The user's
application database was subsequently migrated under separate user authorization;
real-capable workers remain stopped.
The [reviewed delta](candidate-changes.md) contains **64 changed + 25 added files**
with original/candidate hashes and explicit preservation rules. Infrastructure,
CI, Dockerfiles, the Python 3.12 infrastructure lint target, threat model and
readiness documentation were added/updated directly in the original checkout.
Do not overwrite original-only infrastructure changes from the candidate snapshot.

Implemented candidate repairs include:

- Tenant/API-key revocation, transaction-locked permission/session revalidation,
  tenant/user/session-bound one-use OAuth state and serialized per-mailbox saves.
- Payment customer/session/mode/amount/currency matching, replay/concurrency
  protection, immutable idempotency requests and guarded financial migrations.
- Invitation failure cookie clearing; bounded streamed JSON request bodies.
- Scoped worker claims, one-job processing, post-queue consent/actor/sender and
  human/AI ownership checks, terminal ambiguous delivery outcomes, graceful drain.
- Explicit development-only simulator admission/execution; no real providers
  enabled to replace simulations.
- PostgreSQL CSV savepoints with truthful failures; contact access during voice
  outage; retained user image model; Settings and Overview responsive repairs.
  **Inbox was not redesigned.**

Four new generated Alembic successors retain the original history: final head
`bfb741c767fd`, **57 revisions / 22 preserved Or-on revisions**, one root/head.
The isolated rehearsal and subsequently authorized local application database are
at that head; no cloud database was migrated.

Staging preparation includes four pinned production images, Compose/Caddy,
Terraform, private version-pinned Secret Manager retrieval, migration/release
locking, backup scheduling/GCS upload tooling, restore-to-new-database recovery,
and a protected manual build → scan/SBOM → optional publish → optional VM-deploy
pipeline. Cloud actions default off and were not run.

## Evidence

See [verification evidence](verification-evidence.md), [UI review](ui-verification.md),
[performance](performance-report.md), [image security](image-security.md) and
[release/backup review](release-backup-security-review.md).

- **619 TypeScript / 834 Python tests passed** in the consolidated run; 48/108
  respective skips are not passes. **107 real PostgreSQL tests passed** separately.
- Formatting, lint, strict typing, deterministic contracts/SQL, migration checks,
  peer/dependency boundaries and production application build passed.
- **25 browser route/action checks + 2 optional-service outage checks passed**;
  85 indexed screenshots cover EN/HE, light/dark and responsive widths. This is
  not exhaustive successful-write, all-role or accessibility acceptance.
- **77 infrastructure/security helper tests**, four Terraform mock checks, and
  actual network-disabled Linux file-permission/lock checks passed.
- Final production-image startup, database outage recovery, web-image rollback
  and forward with unchanged schema, and new-DB restore passed. Final restore
  **8.840 seconds**, fictional data only; no worker replay or real media recovery.
- 20k-contact/two-tenant repository sample: list p95 **14.14 ms**, search p95
  **27.77 ms**. Public login HTTP sample: p95 **16.16 ms** over 60 sequential warm
  local requests. These are not production SLAs or invented before/after gains.
- Explicit candidate pattern scan: 1,042 files, no findings. It is not a full
  secret-history audit or a guarantee of absence.

**The consolidated verify command failed**, after preceding stages passed,
because the NLTK security exception expired. It was not extended or suppressed.

## Exact blockers and priority

1. **Local schema activation — RESOLVED:** the separately authorized private
   backup/restore rehearsal and four successors through `bfb741c767fd` passed.
   All original business-table data was preserved. No app/worker restart occurred;
   that remains user-controlled. This resolves local schema alignment only.
2. **Security gate:** NLTK 3.10.3 / `PYSEC-2026-3740` is unresolved and its exception
   expired. All four final image scans fail the high threshold after available
   narrow patches. Node images report 7 critical/52 high findings; Python images
   report 12 critical/69 high. Counts are findings, not proven exploits. Resolve
   with supported vendor updates or a separately reviewed mitigation; the agent
   has not waived risk or removed proven voice functionality to hide it.
3. **Workflow/security acceptance gaps:** finish significant actions identified
   in the [feature matrix](feature-matrix.md): invitation existing-user destination,
   broader role/UI negative cases, successful uploads/reload/replacement, task and
   calendar time-zone edges, authenticated recovery, and external-effect crash
   reconciliation. Protected autonomous calls still need an independent bounded
   consent/action/spend policy before enabling them. Historical pending billing
   and simulator provenance require operator review, not automatic data deletion.
4. **Staging host and release acceptance:** supply reviewed project/region/zone,
   domain/CIDRs, VM/disk sizing, numeric GitHub identities/ref/environments, WIF,
   SSH host pin and prepared root-owned host configuration. Test actual IAM,
   mounted-disk/OS Login/IAP/TLS, authenticated functional release smoke, alerts,
   cloud backup/restore and media/encryption-key recovery. No real plan/apply,
   deployment, secret fetch, GCS upload or notification occurred here. Required
   voice/dispatcher cloud packaging is not complete; live workers remain off.
5. **Production additions:** MFA/recovery/session-management maturity, verified
   email changes/invitation delivery, retention/export/deletion policies, resource
   limits and sustained load, operational alert delivery, RPO/RTO and incident
   ownership. OAuth connection is not mailbox sync or a working email client.

Cloud/provider validation requires separate authorization. Supplied configuration
must use private service bundles and named Secret Manager versions, never chat or
Terraform state. Exact names and sequence are in [deployment/recovery](deployment-recovery.md)
and [protected CI](staging-ci.md).

## Preservation and recovery

No customer records, financial history, application source modules or upstream
files were deleted. No broad dependency/framework rewrite occurred. Runtime image
builds remove unnecessary npm/Corepack and package cache material; the application
lockfiles and legitimate voice dependencies remain. All upstreams must remain at
their locked clean SHAs; final integrity evidence is recorded in progress.

Application rollback uses a reviewed schema-compatible image. Financial recovery
data makes populated downgrade refuse; revoked keys stay revoked. Restore only
to a new isolated database, validate row/content/RLS/key/object invariants, and
quarantine jobs before any separately approved cutover. Never restore over newer
writes or replay messages, calls or payments automatically.

Fictional candidate, scanner reports, screenshots, backups and disposable Docker
volumes are retained for review and resumption. No real calls, WhatsApp messages,
emails, charges, provider configuration changes or infrastructure provisioning
were performed by this task.

At the original audit handoff, the task-owned Compose stack and `oron-readiness-pg-20260912` were
stopped without deleting containers, volumes or evidence. The user's development
runner/worker processes were still active and were not stopped. Final original
Git status contains 507 changed tracked/nonignored paths; branch/HEAD are unchanged.
All three upstreams were rechecked clean at their exact locked SHAs. The later
user-approved source merge and its newer verification supersede that earlier
pending-merge status; see [application merge](application-merge.md).

## Next product improvements

The [CRM backlog](crm-improvements.md) ranks saved/shared views, better search/
pagination, reversible duplicate handling, follow-up queues and reviewable agent
summaries. These do not supersede security, tenant correctness or release gates.
