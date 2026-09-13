# Authorized local database alignment — 2026-09-12

**Completed. The local application database is at the current Alembic head.**

## Voice-quality successors applied — 2026-09-12 23:34 Asia/Jerusalem

The user explicitly authorized the next local migration after the voice-quality
implementation checkpoint. With application writers stopped, the same guarded
workflow upgraded the local Compose PostgreSQL 18.6 database from
`bfb741c767fd` through `17f57105f1a9` to the single current head
`eb626a89c3a8`.

- A new private custom-format backup was created before the upgrade: 597,902
  bytes, SHA-256
  `5e8f9d8892481e99dddd8011db5790bc18628a300bb37da6ddb88faaeeb0e0c1`.
- The backup was restored into a new PostgreSQL 18.6 container with networking
  disabled and memory-backed storage. The exact two-revision SQL was rehearsed
  there before the source database changed.
- All 77 pre-existing business-table original-column counts and content
  fingerprints matched before restore, after rehearsal and after the real
  upgrade. Existing role attributes/settings also matched.
- Knowledge version/validity/publication constraints, immutable-publication
  triggers, runtime read grants, fail-closed active-tenant helper, voice-control
  tables, FORCE RLS, functions and fixed security-definer paths passed catalog
  checks. The new command/control tables are empty.
- `alembic current --check-heads` passed at `eb626a89c3a8`. A final read-only
  query found no other application client connected.
- The temporary restore container and memory data were removed. No seed, queue
  replay, application/worker restart, provider action, role-password change,
  commit or push occurred.

The ignored, owner-restricted evidence and private backup are retained at
`.artifacts/readiness/local-db-voice-quality-20260912-233427/`. Do not upload the
backup: it contains local application data. The schema prerequisite for running
the matching voice-quality code is now satisfied. Real-call/provider acceptance
remains separate and requires an explicit test authorization.

The user explicitly requested database migrations before further implementation.
This operation applied only the four already-reviewed revisions. No application
implementation, seed, role-password rotation, queue replay or cloud action was
performed. Git changes were preserved; schema alignment does not erase Git diffs.

## Exact target and migration

- Repository: `C:/Users/almo9/Or-On-Integration/OrOn-Platform`.
- Branch: `codex/phase-7-ui-polish`; HEAD unchanged:
  `7afa8534fc89259cd679da7ff58ec7546bd01b14`.
- Local Docker Desktop engine; container `or-on-platform-postgres-1`, verified
  Compose project/service, repository path and persistent volume
  `or-on-platform-postgres-data`.
- PostgreSQL **18.6**, database `or_on_platform_dev`, migration identity
  `platform_migrator`, host binding `127.0.0.1:5433` only.
- Before: `eb2660eb37ec`.
- Applied: `2b2b64433c98` → `6d9561f45598` → `74e4f347dbbd` → `bfb741c767fd`.
- After: exactly one head, **`bfb741c767fd`**. `alembic current --check-heads` passed.

No platform host runner/workers or other database client sessions were active.
The operation held the existing migration advisory lock, used a sanitized child
environment, and did not load the developer `.env`. The existing container's
database credential was used only in process memory, never printed or written to
source/evidence. Direct Alembic avoided the staging wrapper's password rotation.
The migration connection applied bounded lock/statement timeouts; the online
Alembic environment applies the revision chain transactionally.

## Verified private backup and rehearsal

Backup retained locally under the ignored, access-restricted directory:

`C:/Users/almo9/Or-On-Integration/OrOn-Platform/.artifacts/readiness/local-db-alignment-20260912-213607/`

- Archive: `before-upgrade.dump`, custom PostgreSQL format, **569,249 bytes**.
- SHA-256: `9ff126f3569e276ced445f716e96dd2a466907124eb8fa5d0366f1b6f8e7b704`.
- Windows ACL inheritance disabled; only the current user, SYSTEM and local
  administrators have access. `.gitignore` and Docker context exclusion apply.
- Restored into a new PostgreSQL 18.6 container with **networking disabled**, no
  host ports and temporary-memory storage. No application/worker was attached.
- Verified the old head and original-column row counts/content fingerprints for
  every existing business table. Rehearsed the exact generated PostgreSQL SQL for
  the four revisions, then checked the new head and security definitions.
- The temporary restore container and its memory-backed data were removed after
  verification. The protected backup remains; no source database/volume was removed.

The backup contains private application data. Do not upload it to Git, images,
chat or GCP as a deployment fixture. This is a local database recovery proof,
not a media/encryption-key backup or a production recovery-time guarantee.

## Post-upgrade evidence

- **75 original business tables**: original-column row counts and SHA-256 content
  fingerprints unchanged against the pre-upgrade snapshot. This includes users,
  memberships, contacts, conversations, messages, credentials, queues and finance.
  The Alembic version row and new columns are intentionally outside that comparison.
- Existing role attributes/settings unchanged; no password-setting command ran.
- **19 catalog/invariant checks passed**, covering new tables, defaults, triggers,
  RLS/FORCE RLS, new function grants, denial of old billing signatures and unsafe
  direct money updates, runtime role flags, and checked security-definer paths/ACLs.
- New OAuth/payment-setup tables are empty. Existing conversation ownership epochs
  are zero; new outbound/topup binding fields remain NULL, as designed.
- Zero active API keys belonged to inactive tenants before migration, so the
  reviewed revocation backfill did not alter existing records.
- Read-only queries as `platform_web` without tenant context returned zero contacts,
  OAuth authorizations and payment-setup rows. These are focused local checks, not
  a replacement for the previously documented isolated multi-tenant test suite.
- Final read-only connection check found no other application clients. Existing
  Docker services were left running unchanged; no app or worker was restarted.

Private machine-readable receipts: `baseline.json`, `backup.json`, `rehearsal.json`,
`completion.json`; operational helper: `align.py`. No provider secret/message body
was emitted in the verification output. All 89 reviewed source hashes matched
before applying the database update.

## Compatibility and next step

Historical queued AI sends without ownership bindings, old OAuth callback flows,
and old unbound pending Stripe completions may now fail closed. They were not
backfilled, replayed or deleted. Restart an expired OAuth connection flow through
the UI; reconcile any historical external-effect work before retrying it.
Do not automatically downgrade: key revocation is intentionally irreversible,
and populated billing bindings prevent unsafe downgrade. Recovery would require
reviewed restore to a new database, never overwriting newer writes.

The schema prerequisite for the updated local app is now satisfied. App/worker
startup remains user-controlled because existing flags may enable real providers.
The [GCP DEV code-side blockers](gcp-dev-verification.md) remain separate work;
this migration is not a staging or production release approval.
