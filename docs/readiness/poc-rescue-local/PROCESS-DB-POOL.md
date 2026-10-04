# PDF-082 — bounded web PostgreSQL pools

## Change

The web auth repository, tenant transactions (including CSRF/session checks), staff SMS authentication, Stripe ingress and WhatsApp ingress borrow a process-owned PostgreSQL pool. Request cleanup releases a lease; it no longer tears down shared connections. The existing default constructors remain owned for CLI/worker callers that explicitly manage their lifetime.

Only an **exact trusted server DSN plus fixed client options** shares a pool. The ordinary profile has `max: 4`, `connect_timeout: 3`, `idle_timeout: 10`, and `prepare: false`. The optional WhatsApp signature verifier has a separate fixed profile (`max: 1`, `connect_timeout: 2`). Its supplier acquires a lease only after successful HMAC and primary receipt persistence, inside the existing isolated attestation error handling. Verifier acquisition or SQL failure cannot undo a committed inbound receipt. Credentials, startup role, database, TLS/options and client profile participate in the pool key; no request data chooses them.

The registry is process-global under a versioned symbol so Next route bundles and module reloads reuse the same handles. It stores no tenant, user, session or authorization state. Tenant identity is still set with transaction-local `set_config(..., true)` inside `begin`; verifier capability checks and `SET LOCAL ROLE` remain within its own transaction. Privileged verifier, runtime and migrator DSNs are not merged.

Explicit shutdown stops new acquisitions, waits up to five seconds for active leases, then closes connections with a two-second bound. Hooks cover `beforeExit`, `SIGTERM` and `SIGINT`. A standalone process retains signal termination. When an existing server owns the signal, the pool stays available while that server drains accepted HTTP requests; server exit closes its sockets. Starting pool drain concurrently with Next's HTTP drain was demonstrated to reject a later auth-to-tenant lease and was corrected.

## Local evidence

All database tests use the owned fictional `oron_ui_preview_*` database on the isolated local PostgreSQL cluster. The harness migrates, seeds and removes only that database. No production or original developer database is used.

`packages/ts/auth/src/process-database.postgres.test.ts` covers:

- Module reload reuses the same physical backend PID.
- Thirty concurrent operations, thirty auth repository wrappers and an SMS wrapper share at most four backend PIDs; closing one wrapper leaves other requests usable.
- Twelve verifier-profile operations use one backend PID, distinct from the runtime-profile PID even with the same test DSN.
- Twenty-four interleaved transactions across two fictional tenants preserve actual RLS, user and session context; after rollback and reuse, transaction-local values are empty.
- Distinct web, messaging and migrator startup-role DSNs use separate backend PIDs; low-privilege roles cannot read auth credentials.
- Shutdown waits for an active lease, rejects new acquisitions and removes the physical backend from `pg_stat_activity` when the lease finishes.

The final complete web rerun passed **158 files / 943 tests, 0 skipped** with the candidate `4741fb2a9f6578d335dee42224044d9fd54775cf` runtime source. The final auth invocation passed **19 executed files / 95 assertions, 0 skipped**. The auth build includes tests in `dist`, and Vitest's existing default discovery executes both `src` and `dist`; this count represents **10 source files / 48 unique source cases**, plus 9 compiled duplicate files / 47 repeat executions. It must not be presented as 95 distinct auth cases. The final focused pool run passed **all six actual-database tests**. The final Stripe/WhatsApp adapter run passed **2 files / 36 tests**, including concurrent webhook pool reuse, trusted account binding and lazy verifier acquisition. Root `pnpm typecheck` passed all 11 workspace projects and root lint passed.

Final logs are `.artifacts/poc-rescue-local/web-final-diagnose.log`, `auth-final-all.log`, `lint-final-all.log` and `typecheck-final-all.log`. Earlier focused evidence is in `auth-pool-profile.log` and `web-pool-adapters-focused.log`. The web dependency build passed in `web-final-all.log`; the full diagnostic rerun used those current compiled packages.

The first final web invocation passed all 943 assertions but failed the existing `public-contact-adversarial.postgres.test.ts` 10-second `afterAll` hook. Its public API uses separate owned clients, whose `finally` closes them; it does not borrow this process pool. Temporary stage timing and read-only `pg_stat_activity` observation were added to diagnose the cleanup. The focused rerun closed its fixture client in 4 ms, dropped its owned database by 1,186 ms and closed maintenance by 1,190 ms. The complete suite rerun measured 6 ms, 954 ms and 961 ms respectively and passed with the original timeout. PostgreSQL was observed in `IPC/CheckpointDone` during database drop, and no public fixture database remained after either run. There was no reproduced client leak. The original timeout's exact stage/cause cannot be proven retrospectively; checkpoint/resource contention is a plausible explanation, not a confirmed runtime defect. Temporary timing instrumentation was removed, and neither application source nor the hook timeout was changed. Diagnostics are `public-cleanup-diagnose.log`, `public-cleanup-observe.log`, `public-cleanup-observe-full.log` and `web-final-diagnose.log`.

The final real-database signature-proof regression also passed (**1 file / 1 test**, `pool-webhook-proof-verified.log`) after a clean migration to `8d32f4a91c70`. It uses borrowed main/verifier clients, proves the verifier supplier is not invoked for invalid HMAC, confirms `SET LOCAL ROLE` clears after attestation, and proves a verifier-lease failure leaves the accepted inbound event durable without creating a signature proof. The test creates and removes its own fictional tenant instead of depending on an unrelated published agent fixture. An earlier attempt was blocked by the new migration's multi-statement asyncpg error; WhatsApp work repaired that migration before this passing run.

## Next SIGTERM regression

The Linux harness `.artifacts/pool-shutdown-probe/run.py` uses the shipped **Next 16.3.6 `startServer`**, its actual HTTP server/signal cleanup, Node 24.20.0, the current pool module, and an owned migrated PostgreSQL database. Only the router is replaced by a deterministic two-stage request: one delayed database lease followed by another, representing auth then tenant work. The server receives SIGTERM while the first query is active. This is a lifecycle regression fixture, not a complete production-app canary.

Before the fix, the accepted request returned **503**, `Database pool is shutting down`; Next exited143 and left0 backends (`next-pool-shutdown-measured-before.log`). After respecting the existing HTTP signal owner, the identical request returned **200** with its second query completed, Next exited143 and left **0 backends** (`next-pool-shutdown-fixed.log`). The signal-to-exit duration is recorded in that log. A committed child-process unit regression also verifies later leases remain available during server-owned drain without opening a DB connection. Full candidate application/route shutdown remains a deployment validation step.

One preliminary probe startup failed before readiness because the standalone image did not expose the postgres package outside its webpack bundle. It was corrected by mounting the existing pure-JavaScript dependency into the fixture. That stopped preliminary harness may have left its unnamed owned database and three fixture clones in the disposable local cluster; no broad database deletion was attempted. Both measured before/after runs removed their owned databases and containers normally.

## Limits

This is a real-database concurrency regression, not a production HTTP throughput benchmark. The bound is per exact DSN/client profile **per process**; replicas multiply the aggregate limit. The tests prove distinct startup roles and RLS on the isolated cluster, not the production credential inventory. The optional verifier remains separately bounded because sharing a privileged connection profile would violate the role boundary. No live provider event, deployment or production connection count is claimed by these tests.
