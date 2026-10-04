# Local rescue and release runbook

Run commands from the repository root. This runbook authorizes no live deployment,
registry publication, provider registration, trunk provisioning, customer message,
or call. The current isolated stack is `oron-poc-rescue-stack`; its private,
fictional configuration and evidence live under
`.artifacts/poc-rescue-local/container-stack`. Never substitute a developer or
production `.env`, database, object directory or Compose project.

The three Python images initially tested were built from
`525be698cf2bcbedf0a008b94809e5d69c9a12a6`. Their Python inputs matched
`a051d45`; their migrated schema was `7c91e5a2b640`. Later carrier-cost and
migration fixes require a fresh final snapshot and affected image rebuilds.
These historical results do not certify a newer candidate. Exact digests,
commands and source labels are in `python-image-build-results.json`.

The subsequent release audit passed 172 focused tests with zero skips in
16.06 seconds (`release-audit-final-tests.log`). It executes real networkless
Bash failure paths as well as archive, schema, recovery and restore contract
checks. The cost correction passed 61 common/agent-cost tests with zero skips.
Neither result replaces final image acceptance.

## 1. Preflight and exact image snapshot

Use the repository-pinned Node 24.20, pnpm 11.24, Python 3.14.7, uv 0.12.7,
PostgreSQL 18.6 and Docker Compose v2. Inspect the local Docker context; do not
use the acceptance harness with a remote engine.

```powershell
git status --short
git rev-parse HEAD
docker context inspect --format '{{json .Endpoints.docker.Host}}'
uv run --no-sync python scripts/db_verify.py
```

Review outstanding changes before selecting the final committed candidate.
`git archive` below excludes untracked secrets, local data and working-tree
changes. Do not replace it with a recursive copy of this workspace. If the
context already exists, inspect and reuse its recorded SHA or choose another
committed candidate; do not overwrite it.

```powershell
$Candidate = (git rev-parse HEAD).Trim()
$Context = Join-Path (Get-Location) ".artifacts/poc-rescue-local/build-context-$Candidate"
$Archive = "$Context.tar"
if (Test-Path -LiteralPath $Context) { throw "Context already exists; inspect its receipt" }
New-Item -ItemType Directory -Path $Context | Out-Null
git archive --format=tar --output=$Archive $Candidate
if ($LASTEXITCODE -ne 0) { throw "git archive failed" }
tar -xf $Archive -C $Context
if ($LASTEXITCODE -ne 0) { throw "archive extraction failed" }
$Images = @{
  "web" = "apps/web/Dockerfile"
  "control-api" = "services/py/control-api/Dockerfile"
  "messaging-worker" = "infra/images/messaging-worker.Dockerfile"
  "dispatcher" = "infra/images/dispatcher.Dockerfile"
  "migrator" = "infra/images/migrator.Dockerfile"
}
foreach ($Service in $Images.Keys) {
  docker build --progress=plain --build-arg "ORON_SOURCE_REVISION=$Candidate" `
    -f (Join-Path $Context $Images[$Service]) `
    -t "oron-poc-rescue/${Service}:candidate" $Context
  if ($LASTEXITCODE -ne 0) { throw "Build failed: $Service" }
  docker image inspect "oron-poc-rescue/${Service}:candidate" `
    --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{.Config.User}}'
}
```

Retain each log and inspect result. All release images must identify the reviewed
source and match their immutable digests. Local `:candidate` tags are convenient
only for this disposable harness; a deployed manifest must use registry digests.
No push is part of these commands. Do not prune images, containers or volumes.

## 2. Verification before startup

The owned PostgreSQL test harness creates, migrates and removes only its UUID
databases. It strips provider secrets and disables real provider activity.

```powershell
uv run --no-sync python .artifacts/poc_rescue_verify.py final-python uv run --no-sync pytest packages/py services/py scripts/tests -q
uv run --no-sync ruff check packages/py services/py scripts infra/scripts
uv run --no-sync pyrefly check packages/py/oron-agent/src packages/py/oron-dispatcher/src services/py/dispatcher/src
```

Use unique verification labels. Record counts, skips, schema and exact source.
The 17 paid model-evaluation tests are explicitly gated; skipping them is not a
model-quality pass. Previously authorized synthetic model results are documented
in `VOICE.md`; provider calls/messages and human Hebrew listening remain separate.

The release archive's exact allowlist includes image digests, Compose/Caddy,
systemd application/backup/recovery units, deployment/backup/restore/recovery
helpers and `db/contracts/schema-manifest.json`. Validate the actual archive:

```powershell
uv run --no-sync python scripts/check-dev-release.py <reviewed-release.tar.gz>
```

Recovery units are packaged for review but are not automatically installed or
enabled. Missing, duplicate, linked, traversing or extra archive members fail
before extraction is accepted.

## 3. Owned local startup and smoke

The retained `.artifacts/poc_stack.py` wrapper imports the checked-in
`infra/scripts/readiness_stack.py`, selects the owned project and candidate
tags, and generates fictional credentials. `prepare` is for a fresh fixture
directory only; it refuses to overwrite existing configuration. The current
fixture is already prepared. Coordinate operations with the active test owner.

```powershell
# Fresh fixture only, never repeat against an existing prepared directory:
uv run --no-sync python .artifacts/poc_stack.py prepare
uv run --no-sync python .artifacts/poc_stack.py validate
# After all five reviewed image tags are ready:
uv run --no-sync python .artifacts/poc_stack.py start
uv run --no-sync python .artifacts/poc_stack.py check
uv run --no-sync python .artifacts/poc_stack.py callback
```

Startup brings up PostgreSQL, runs the one-shot migrator, sets the owned object
root's UID/GID, and starts services. PostgreSQL health must probe TCP with
`pg_isready -h 127.0.0.1`: its temporary initialization server accepts Unix
socket connections before TCP is ready. The original socket-only probe failed
an actual first-start migration; a separate delayed-init container reproduced
the race and verified the TCP correction.

All these flags remain `false`: `ENABLE_REAL_TELEPHONY`,
`ENABLE_REAL_VOICE_PROVIDERS`, `ENABLE_REAL_WHATSAPP`, `ENABLE_WHATSAPP_AI`,
`ENABLE_WHATSAPP_AUTO_CALLS`, `ENABLE_REAL_BILLING`. The dispatcher has fictional
LiveKit keys, an unreachable loopback LiveKit URL and an empty outbound-route
array. Healthy local storage does not mean a carrier is configured.

The callback probe uses the fictional key and a `room_finished` event for a
nonexistent fictional room. It must show unsigned 401, signed 200/204 and no
public outbound-control route. This tests Caddy/application reachability and
signature handling without dialing. Retain durable replay evidence separately.

Current Python evidence: both service health endpoints returned 200; UID 100;
actual DB roles `platform_voice` and `platform_web`; zero unsafe runtime roles;
zero users; dispatcher persistence/ledger ready and SIP disabled. The container
artifact probe uploaded 20 real WAV/transcript pairs, retained failed uploads
and unfinalized staging, then left zero staging entries after success. Control
API read all 20 transcripts through its read-only mount. This was not 20 full
voice calls or a host-capacity test.

## 4. Restart, dependency and failure drills

Only run these while the owned fixture is reserved for this drill. They stop
services in the disposable project; they are not production commands.

```powershell
uv run --no-sync python .artifacts/poc_stack.py restart
uv run --no-sync python .artifacts/poc_stack.py dependency
uv run --no-sync python .artifacts/poc_stack.py fault-check
uv run --no-sync python .artifacts/poc_stack.py check
```

`dependency` stops Control API, probes web/worker/callback behavior and restores
Control API in `finally`. `fault-check` stops PostgreSQL, requires API readiness
503, then restarts dependencies. Neither alone proves a real WhatsApp send or
zero outage during deployment. Preserve timestamps, failure receipts and the
subsequent healthy check; a liveness 200 is insufficient.

The deployer's EXIT handler covers explicit failure and signals. Its early
guard now restores private configuration and the deployed-revision marker after
preflight failures; application rollback restores that snapshot before any old
image restart. An unsuccessful private restore blocks restart. A changed or
unreadable schema refuses automatic old-image rollback. Controlled Bash tests
verify these branches; they do not establish the two-minute live service RTO.

For Linux recovery, `scripts/recover_unhealthy.py` defaults to a read-only plan.
`--apply` and the optional systemd timer require scoped operator authorization.
Recovery holds the deploy lock, permits only web/worker/Caddy, observes five-minute
cooldowns and two attempts per fifteen minutes, and spends budget before each
restart. It requires the exact packaged schema head for web/worker recovery.
Do not enable the timer during a release or infer recovery from Docker's restart
policy: a still-running unhealthy process is a separate condition.

## 5. Local rollback and migration compatibility

The existing helper rehearses **web-image rollback only**, against the current
schema, and always returns to the candidate in `finally`. Select a verified
local previous image ID, not a mutable remote tag. Its guard deliberately
requires this local checkpoint tag:

```powershell
docker tag <verified-previous-web-image-id> oron-readiness/web:rollback-checkpoint
uv run --no-sync python .artifacts/poc_stack.py rollback-check --previous-web-image <verified-previous-web-image-id>
```

This HTTP/role/schema smoke is insufficient for PDF-108. The immediately prior
live source is `42eebac2d423bb70a0c69690e8d2899beab12249`. The recommended broader
harness uses a **second** project such as `oron-poc-rescue-compat`, fresh private
fixture directories, the final candidate migrator and all four application
images built from that old commit. Keep all provider flags false. Populate
fictional tenant A/B auth, messages, queue retries, voice sessions and ownership
commands; run authenticated success and cross-tenant denial checks through the
old images against the new head. Verify function grants and signatures as well
as startup. Record every old image digest, the final migrated head and counts.

Do not use a mainline checkout or the active rescue stack for that comparison.
Do not downgrade the schema to make old images pass. Failure blocks application
rollback eligibility and requires a compatible forward image or separately
reviewed restore. The new WhatsApp pool migration must be included in this
matrix before compatibility is claimed.

## 6. Restore, keys and evidence

```powershell
uv run --no-sync python .artifacts/poc_stack.py recover
```

The local recovery helper writes a custom-format dump and restores it into a
fresh generated database. It compares schema/table counts, tenant/contact data,
forced RLS and runtime-role visibility, and restores a synthetic object by
checksum. It also writes a fictional encrypted session field using a newly
generated fixture key kept separately from every archive, reads the restored
ciphertext, decrypts it with that key, and rejects a wrong key or tenant.
It neither loads production keys nor certifies production key escrow. Evidence
states `off_host_restore=false`; a second database on the same Docker engine is
not an independent server restoration. Workers are not replayed by this drill.

Executed on 2026-10-05 against the historical local Python candidate: the
1,773,741-byte dump restored successfully into a fresh database in 30.133 seconds.
Schema/table/head/forced-RLS parity, scoped contact visibility, fictional-field
decryption, rejection of a wrong key and tenant, and object checksum all passed.
The receipt is `container-stack/recover.json`; the command log is
`container-stack/encrypted-recovery.log`. No service was stopped. The separately
stored fixture key contains no real credential. Repeat against the final schema
after the new migration; this result does not certify that later head.

The stricter `scripts/restore-dev-backup.py` accepts only an exact fresh
`oron_restore_<32-hex>` database on an approved local test port and a verified
backup SHA-256. Set `ORON_RESTORE_DATABASE_URL` through the private fixture
environment, never by pasting a credential-bearing command into logs:

```powershell
$RestoreDatabase = "oron_restore_" + [guid]::NewGuid().ToString("N")
uv run --no-sync python scripts/restore-dev-backup.py `
  --archive <reviewed-backup.tar.gz> --expected-sha256 <verified-sha256> `
  --target-database $RestoreDatabase --confirm-new-database $RestoreDatabase `
  --pg-restore <absolute-pg_restore-path> --objects-directory <fresh-owned-directory>
```

It verifies archive safety, schema, roles/RLS/function ownership and object
references, and preserves failed fresh targets for diagnosis. Pre-deploy backups
use database-only mode under the deploy lock; scheduled full backups still
include private objects. Durable off-host storage, external key escrow, retention,
restore on another host and replay acceptance are outstanding infrastructure
gates, not satisfied by the local commands above.

## 7. Live release gates and receipts

Before any authorized live action: complete the candidate compatibility matrix,
retain a verified independent backup/restore, prove bounded rollback and messaging
availability, review source/image/schema/tenant mappings, and approve the exact
deployment scope. CI deploy/publish requires manual dispatch with `deploy_dev`
and matching `expected_commit`; inspect actual repository/environment protections
and the existing WIF repository condition before relying on that gate.

The current source template uses a 240-second systemd stop allowance and a
120-second dispatcher Compose grace period. Deployer unit comparison may refuse
an older installed unit; installing or enabling units is a separately reviewed
operation, never an automatic workaround. Actual active-call shutdown and host
load are still required. The observed live 4-GB shared-core host with nonzero
swap does not meet the requested capacity/zero-swap acceptance. Separate voice
hosting, Cloud SQL/PITR and decommissioning remain decisions requiring review and
authorization; no infrastructure was provisioned by this work.

After an authorized deployment, run the reviewed read-only
`scripts/verify-dev-runtime.sh <full-commit>` on its target host. It verifies
each running immutable image/revision, worker health and the **packaged** schema
head. It now reads the manifest instead of comparing every release to an old
hardcoded migration. Preserve the receipt with the release archive checksum.

ProTouch outbound provisioning remains governed by `PROTOUCH-OUTBOUND-PLAN.md`.
User-confirmed sender/test-recipient identity is not a completed caller-ID test.
Do not deregister an existing WhatsApp application/account to bypass the current
coexistence blocker. Record unavailable provider tariffs as unpriced; no new
Twilio rate or carrier attribution is inferred from a phone-number prefix.

Retain source revisions, image digests, schema heads, command logs and explicit
local/live limitations in `VERIFICATION.md`, `VOICE.md`, `WHATSAPP.md` and
`coverage.json`. Cleanup targets only exact owned fixtures after evidence review;
never run global prune or remove original developer/production volumes.
