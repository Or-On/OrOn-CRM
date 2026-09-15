# Controlled staging deployment and recovery

> **Historical evidence (superseded).** This file records the earlier staging
> rehearsal and references harnesses that no longer define the active DEV
> release path. Current deployment and recovery instructions are in
> [`docs/deployment/dev-gcp.md`](../deployment/dev-gcp.md), and the fresh
> post-implementation verdict is in
> [`docs/readiness/post-implementation/release-assessment.md`](post-implementation/release-assessment.md).
> Do not use the commands below as the current operator procedure.

**Not deployed. Do not execute cloud/host actions until separately authorized.**
One Compute Engine VM; Docker Compose/Caddy; PostgreSQL18.6 on a separate disk;
private GCS/Artifact Registry/Secret Manager. No Cloud SQL/Kubernetes substitution.

## Local evidence and remaining gates

- Four production-image builds passed, with public web assets and JavaScript-only
  worker packaging. Non-root application processes, read-only roots, bounded
  resources/logs, private DB network. Optional workers never auto-start.
- `infra/scripts/readiness_stack.py` creates only the fixed task-owned Compose
  project with separate named volumes and loopback13880; it rejects remote Docker
  contexts and disables implicit `.env` loading. No real credentials or seed users.
- Compose/Caddy validation, PostgreSQL migrate→API readiness→web readiness→Caddy
  startup, login200, disabled webhook404, no superuser/BYPASSRLS runtime roles, and
  restart passed. This is HTTP/role/startup evidence, not full authenticated E2E.
- Fresh-schema backup/restore6.014s; second drill with a fictional contact9.309s.
  New-database restore compares table counts, forced RLS/head, contact content and
  runtime-role tenant visibility. Existing database never overwritten; workers
  not replayed. Local files under `.artifacts/readiness/stack`; no real media.
- Final rebuilt images passed startup at `bfb741c767fd`, database-outage 503 and
  recovery. Web rollback to the prior local image and forward again preserved
  the schema and HTTP/role checks. This did not test every authenticated workflow.
  Final-head fictional restore took **8.840 s**, 482,997 bytes, into a new database.
- Terraform fmt/validate and4mockpolicytests passed. No GCP plan/apply, state
  creation, IAM access, DNS/TLS, real secret fetch or provider check occurred.
- Dependency/image security gates and remaining workflow coverage block release.
  Voice/dispatcher cloud packaging, media consistency, production alert delivery,
  resource sizing and authenticated release smoke remain explicit blockers.

## Inputs to review (names only)

Terraform project/region/zone, VM image/machine/disk sizing, domain, administrator
identities, numeric GitHub repository/owner IDs, protected ref/environment/workflow,
private state bucket. Runtime: `STAGING_DATA_DIR`, `STAGING_CONFIG_DIR`,
`PLATFORM_ORIGIN`, `CADDY_ACME_EMAIL`, `STAGING_ALLOWED_CIDRS` and digest image
manifest. Never use0.0.0.0/0 or::/0 as the allowed operator range.

Service secrets use separate raw env bundles:

- web: `DATABASE_URL`, `AUTH_TOKEN_PEPPER`, `AUTH_SERVICE_SECRET`,
  `AUTH_DUMMY_PASSWORD_HASH`; optional reviewed encryption/provider settings only.
- API: runtime `DATABASE_URL`, `VOICE_DATABASE_URL`, `AUTH_SERVICE_SECRET`.
- worker: `MESSAGING_DATABASE_URL`; no live provider credentials for restricted staging.
- migrator: migration-only `DATABASE_URL`, `PLATFORM_WEB_PASSWORD`,
  `PLATFORM_VOICE_PASSWORD`, `PLATFORM_MESSAGING_PASSWORD` (32–128URL-safe characters).
- PostgreSQL initialization password agrees with migrator DSN; runtime DSNs agree
  with role passwords. Existing database passwords are not changed by init-env alone.

See [secret retrieval](staging-secrets.md), [Terraform](terraform.md) and
`infra/scripts/staging-secrets.example.json`. Numeric secret versions only;
owner-only0700config directory/0600files. Never copy the developer `.env`.

## Authorized-host sequence, not run here

1. Resolve all release blockers and merge/reverify the candidate without losing
   existing edits. Explicitly approve infrastructure cost, project and host scope.
2. Review Terraform plan with protected remote GCS state/locking; apply only after
   authorization. VM/disk prevent-destroy and VM deletion protection are intentional.
3. Via reviewed IAP/OS Login, install supported Docker Compose and gcloud from
   official sources. Patch the OS. Inspect the exact data device and filesystem;
   **never blindly format it**. Mount existing reviewed disk at `/srv/or-on-platform`
   before starting containers. Provision Caddy data directory ownership65532.
4. Retrieve pinned secret bundles into a new private configuration directory using
   `staging_secrets.py --execute` only when authorized. Review every role's DSN.
5. Run protected manual `.github/workflows/staging-candidate.yml`: full checks,
   builds, high-severity scans, SBOMs, optional approved registry publication.
   Publication and `deploy_vm` both default off. Optional VM deployment requires
   passing scanned publication, separate `staging-deployment` approval, pinned SSH
   host key, IAP/OS Login and a prepared host with exact source hashes. WIF must
   match the configured workflow/ref/environment. Required GitHub reviewers are
   an external gate. This workflow has not been executed against GCP.
6. Copy reviewed source tooling and immutable manifest to the VM. Run
   `python3 infra/scripts/release.py deploy --manifest MANIFEST --backup-dir BACKUPS`
   to validate the no-action plan. Add `--execute` only after deployment approval.
   The runner pulls digests, stops writers, starts/checks PostgreSQL, backs up,
   holds migration advisory lock, applies Alembic, provisions nonprivileged roles,
   starts API/web/Caddy and records the release. No seed/demo account or worker.
7. Establish an authorized staging identity through the reviewed invitation/account
   workflow; there is deliberately no default admin password. Exercise login,
   role denial, tenant switching, contact save/reload, logout, private downloads,
   and disabled provider behavior. Until these pass, release record says functional
   smoke pending. Do not enable live integrations to make empty states disappear.
8. Validate HTTPS/canonical callbacks, restricted CIDRs and webhook signature/body
   limits from outside the VM. Only exact callback/webhook paths bypass CIDR access.
   No database/debug/media/SIP port is public. Do not enable optional voice ports
   without reviewed call/network requirements and separate provider authority.
9. Review/install `infra/systemd/oron-backup.service`/`.timer`, with explicit private
   `STAGING_BACKUP_DESTINATION=gs://BUCKET/postgres` and release env/manifest paths.
   Enable only after backup/cloud authorization. Upload unique objects/checksums;
   normal VM writer cannot read/delete backups. Test failure alerting and a real
   restore under a separately authorized reader. OS patching and disk/memory/backup
   alerts must be installed and exercised before staging approval.

## Failure, rollback and recovery

Release is serialized by host flock plus PostgreSQL advisory migration lock.
Migration/backup/readiness failure exits nonzero; no automatic downgrade, restore
over writes or blind old-image restart. Keep private diagnostics, manifest and
backup. Do not expose environment values in support logs.

For compatible code rollback, review the prior immutable image manifest against
the expanded schema, then run `release.py rollback --schema-compatible ... --execute`.
It backs up first and never changes Alembic history. New billing bindings make
populated downgrade intentionally fail closed; retained revoked keys stay revoked.
Do not use migration downgrade as an operational rollback.

Restore only into an isolated recovery stack with application workers stopped:
`release.py restore --archive ARCHIVE --restore-database oron_restore_ID ... --execute`.
Checksums must match and destination must not exist. Verify data counts/content,
roles/RLS, crypto-key availability, object metadata↔GCS bytes and audit/financial
invariants before any separately approved cutover. Restored jobs/payments/calls
must remain quarantined until provider-side reconciliation prevents replay.

Measured8.840s is for a tiny local fictional dataset, **not a production RTO**.
Daily backup schedule implies up to roughly24h potential DB loss if no other
recovery source; actual RPO/RTO and WAL/PITR requirement need operator approval.
Database and encrypted credential backups are unusable without retained key
versions; backup object storage alone does not solve encryption-key recovery.

## Resume the retained local rehearsal

The task's test containers were stopped at handoff; their fictional volumes and
evidence were retained. To resume only this environment, inspect its ownership
labels, start `oron-readiness-pg-20260912` for loopback 55439 tests, and run
`uv run python infra/scripts/readiness_stack.py start` for the separate image
stack on 13880. Do not run the developer bootstrap, load its `.env`, or reuse its
database for acceptance. `prepare` intentionally refuses to overwrite existing
fictional configuration; it is not needed when resuming the retained stack.
