# Reviewed application merge — 2026-09-12

**Source application complete. User database migration and application restart
were not performed. Staging/production release approval remains blocked.**

This is the historical source-merge checkpoint. The user subsequently authorized
the [local schema alignment](local-schema-alignment.md); backup/restore rehearsal,
upgrade and current/head verification passed. The database is now at `bfb741c767fd`.
Application/worker restart remains user-controlled; earlier pending-migration
instructions below describe the state at the time of this merge.

The user confirmed that the development runner was stopped and explicitly asked
to apply the reviewed candidate. Process checks found no matching platform host
runner/workers. Existing Docker infrastructure was not stopped or reconfigured.

## Preservation and scope

- Rechecked every original and candidate SHA-256 in
  [candidate-changes.md](candidate-changes.md): **89 paths, zero conflicts**.
- Applied exactly **64 updates + 25 additions** with scoped file patches.
- All 89 resulting files matched the reviewed candidate hashes exactly.
- Preserved all 64 original source files in the ignored
  `.artifacts/readiness/merge-backup-20260912/`; every backup matched its original
  SHA-256 exactly. These are pre-merge source backups, not database backups.
- No source deletion, history rewrite, commit, push or branch change. Preserved
  the user's dirty changes, `.env`, original-only infrastructure/CI and root
  configuration. Generated contracts were regenerated, not copied; all four
  before/after hashes were unchanged.
- Rebuilt TypeScript package/service outputs and the production web application,
  so stale pre-merge `dist` files are not left as the intended runtime output.

## Merged-original verification

Verification ran against the **original merged checkout**, not just the candidate.
The task-local harness and raw logs are under
`.artifacts/readiness/merge-validation/`. No real credentials were loaded for tests.

`scripts/dev.py` CLI was deliberately not invoked: it loads the root `.env` even
for verification commands. Equivalent package-native stages used an allowlisted
child environment, disabled provider flags, and no inherited API credentials.
Python unit tests ran from an empty working directory using absolute original
test/config paths; a Python audit hook refused reads of the real root `.env`.
Explicit PostgreSQL checks used only the ownership-labelled task container on
loopback **55439**, never the application database.

| Check | Merged result |
| --- | --- |
| TypeScript suite | **619 passed, 48 skipped** |
| Python + infrastructure suite | **911 passed, 108 skipped, 5 warnings; 35.42 s** |
| Real PostgreSQL suite | **107 passed; 73.36 s** |
| CRM persistence suite | **88 passed, 1 alternate-DB skip**, fictional UUID database and non-superuser runtime role |
| Worker safety persistence | **11 passed**, own fictional UUID database, mocked provider boundary |
| OAuth concurrent credential persistence | **1 passed**, six concurrent saves and separate-mailbox assertion |
| Formatting / ESLint / Ruff / strict TS / Pyrefly | Passed |
| Production application/package build | Passed; build stage 19.18 s |
| Contract freshness | Four generated files unchanged by SHA-256 |
| Alembic graph / deterministic SQL / schema contract | Passed: 57 revisions, 22 preserved Or-on, one head `bfb741c767fd` |
| Isolated Alembic upgrade/current | Passed against only the task-owned database |
| Repository boundaries / sibling independence / secret patterns / docs / whitespace | Passed |
| Peer dependencies / pnpm audit at high threshold | Passed |
| Python security gate | **FAILED: expired `PYSEC-2026-3740` exception**, not extended or bypassed |

The Python count includes the original-only 77 infrastructure/security helper
tests, explaining its increase from the earlier candidate run. Counts overlap
across focused/consolidated suites; skipped cases are not passes. Prior candidate
browser/container evidence remains documented separately and is not mislabeled
as a fresh merged-checkout browser/cloud run. Container vulnerabilities remain
release blockers; this source merge is not a new security approval.

## Required before restart

The new code depends on this successor chain:

`eb2660eb37ec` → `2b2b64433c98` → `6d9561f45598` → `74e4f347dbbd` → `bfb741c767fd`.

**Keep the application and real-capable workers stopped.** The developer runner
checks the migration head but does not upgrade automatically. Next, explicitly
confirm the intended local application database, take and verify a private backup,
apply the reviewed Alembic successors with the migration identity, and check
`alembic current --check-heads`. Review rollback limitations: financial recovery
bindings refuse populated downgrade and revoked keys remain revoked.

Only after schema validation should the user choose to restart. No real message,
call, email, payment, cloud deployment or provider mutation occurred during this
merge. No customer data or real queue was consumed or modified.

Final recheck: all 89 reviewed files still match exactly; documentation, secret
patterns and full diff whitespace checks passed. Branch/HEAD remain unchanged;
the working tree has 553 changed tracked/nonignored paths, including preserved
earlier work. All three upstreams remain clean at their locked SHAs. The task-owned
test PostgreSQL container was stopped again without deleting data or evidence;
no development runner/worker was restarted.
