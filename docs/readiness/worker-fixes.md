# Worker reliability and safety repairs — isolated candidate

Date: 2026-09-12. Scope: candidate workspace only; the user's active runner,
database and provider resources were not changed or invoked. Initial source
inventory: `docs/readiness/workers-inventory.md`. This document supersedes only
the findings explicitly closed below; the inventory is a baseline, not a claim
that every feature passed readiness.

## Changes

| Baseline finding                                | Candidate repair and exact entrypoint                                                                                                                                                                                                                                                                                                                         | Evidence / residual                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WRK-001 cross-provider claims                   | Generated Alembic successor `2b2b64433c98` after `eb2660eb37ec` limits `ops.claim_inbound_events` to tenant-resolved Meta text/status records, `claim_jobs_all_tenants` to the messaging queue, and inbound completion/failure to Meta records. Historical migrations remain unchanged.                                                                       | Fresh PostgreSQL migration executed. A `platform_messaging` connection cannot claim fictional LiveKit events or a voice queue even by supplying arbitrary queue arguments. Other historical definer functions still need their own scope review.                                                                                                                                                          |
| WRK-002 expired prefetched work                 | `services/ts/messaging-worker/src/database.ts` claims one event and one job immediately before processing instead of prefetched batches of 10/25. Outbound admission and persistence lock and validate the owned job, with a 60-second lease and 10-second statement deadline.                                                                                | Two queued sends require two turns. Normal provider deadlines fit the lease. Not a general distributed fencing proof for all historical workers.                                                                                                                                                                                                                                                          |
| WRK-003 changed consent/permissions/ownership   | Outbound execution rechecks contact lifecycle/opt-out/consent, identity validity, active channel, matching conversation/channel/contact, active tenant/operator authorization and service window. Migration trigger advances a conversation ownership epoch on takeover, re-enable or agent binding change; AI generation and queued AI sends compare epochs. | Real PostgreSQL tests refuse opt-out, archived contact, revoked channel and human takeover after admission, without invoking the fake transport. Tests also exercise existing AI and cross-channel flows. A tiny eligibility change after the committed preflight and before network dispatch remains inherently possible without holding locks over HTTP; no external call is made inside a transaction. |
| WRK-004 ambiguous Meta delivery                 | `providers.ts` permits bounded retries for explicit HTTP 429 rejection only. Network interruption, timeout, malformed success and 5xx stop with `delivery_outcome_unknown`; a reclaimed `sending` request does not replay. Lost worker ownership cannot mark a successor claim complete.                                                                      | Mocked transport tests and persisted PostgreSQL unknown-outcome tests prove no second adapter invocation. Exactly-once remote delivery is **not claimed**; interrupted sends require receipt/provider reconciliation before an operator resends.                                                                                                                                                          |
| WRK-005 conflicting idempotency input           | `packages/ts/crm/src/whatsapp-outbound.ts` hashes normalized request semantics and takes a tenant/key transaction advisory lock. An existing matching key returns the existing request; different content/provider/actor/conversation fails closed. Legacy records without fingerprints are not assumed equivalent.                                           | Real PostgreSQL duplicate and differing-content tests pass. Fingerprints are hashes, not plaintext content. No automatic requeue of old records.                                                                                                                                                                                                                                                          |
| WRK-006 changed environment sender              | Worker passes the durable channel Phone Number ID to the Meta adapter; adapter compares with its configured sender before HTTP.                                                                                                                                                                                                                               | Fake HTTP test verifies mismatch produces `sender_configuration_changed` and no request. WABA/token asset ownership remains a separately authorized provider check.                                                                                                                                                                                                                                       |
| WRK-007 replay extending service window         | `webhook.ts`, `webhook-store.ts`, `messaging.ts` retain valid source occurrence time and derive the service window from that instant, not worker time. Missing source time does not invent a new window; old replays cannot extend it. Future timestamps beyond five minutes are rejected.                                                                    | Parser tests and old/replayed inbound PostgreSQL test pass. Existing stored envelopes without timestamps cannot establish a new free-form window; a fresh valid inbound or approved template is required. This does not rewrite historical message chronology or solve late failed-receipt precedence.                                                                                                    |
| WRK-008 simulator in nondevelopment environment | `main.ts` explicitly enables worker simulations only in `PLATFORM_ENV=development`; store defaults to disabled. Prequeued simulated flow/broadcast/follow-up, simulator outbound and simulator AI generation fail closed.                                                                                                                                     | Dedicated PostgreSQL prequeued simulation test passes. Web admission gates are owned by the application review. Existing mixed historical aggregates are not scrubbed.                                                                                                                                                                                                                                    |
| WRK-014 shutdown closes pool during send        | `worker.ts` drains the bounded active action before closing persistence; signal interrupts the idle wait, not an uncancellable provider request.                                                                                                                                                                                                              | Latch-based lifecycle unit test verifies the pool stays open until in-flight processing settles. Host/orchestrator grace period must exceed action deadlines; SIGKILL remains an uncertain-outcome case.                                                                                                                                                                                                  |

User-visible safe explanations added in `apps/web/src/i18n/messages/en.json` and
`he.json`; existing Inbox layout is untouched. Failure metadata remains allowlisted
in `packages/ts/crm/src/whatsapp-diagnostics.ts`; no tokens, message bodies or full
phone numbers are introduced into logs.

## Executed evidence

All commands used the candidate's installed dependencies and pinned Node 24.20.0.
The only PostgreSQL target was the independent readiness container on
`127.0.0.1:55439`. Live suites create an owned UUID-named fictional database,
apply full Alembic history, seed a non-login fictional operator, use
`platform_web`/`platform_messaging` runtime roles, inject fake providers, and
drop their own database in cleanup.

| Command                                                                                                                                                  | Actual result                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm --filter @or-on/crm build`                                                                                                                         | Passed                                                                                              |
| `pnpm --filter @or-on/messaging-worker typecheck`                                                                                                        | Passed                                                                                              |
| Scoped `pnpm exec eslint` for worker source/tests and changed CRM files                                                                                  | Passed                                                                                              |
| `pnpm --filter @or-on/messaging-worker test`                                                                                                             | 51 passed, 30 live tests skipped when no explicit test DB variables supplied; skipped is not passed |
| `pnpm --filter @or-on/crm exec vitest run src/webhook.test.ts src/whatsapp-diagnostics.test.ts`                                                          | 17 passed                                                                                           |
| `READINESS_POSTGRES_URL=... pnpm --filter @or-on/messaging-worker exec vitest run tests/readiness.live.test.ts`                                          | 11 passed; fresh migration through the current three-successor candidate graph                      |
| `CROSS_CHANNEL_TEST_DATABASE_URL=... pnpm --filter @or-on/messaging-worker exec vitest run tests/call-followup.live.test.ts tests/ai-reply.live.test.ts` | 13 passed; fake AI, fake Meta and fake call dispatch only                                           |

Initial execution exposed multi-statement prepared migration calls in candidate
successors; those were split and full clean migrations rerun successfully.
The existing AI fixture assumed batch claiming; it now asserts the extra
individual job turn rather than weakening delivery assertions. The historical
`database.live.test.ts` fixture was likewise updated for one-at-a-time draining
and an explicit fictional service window; its dedicated legacy preview command
has not been rerun in this subtask. Parent readiness suites own full application
build, catalog/manifest verification, upgrade-from-existing-head, downgrade,
container recovery and end-to-end browser checks.

## Remaining release blockers / limitations

- WRK-009–013 remain open unless independently closed by another readiness change:
  frozen voice-version enforcement, dispatcher crash/idempotency and finalization,
  recording URI/size bounds, provider webhook body bounds, semantic call consent
  and enforceable spend caps. No real conversation quality claim is made.
- Human takeover has an epoch for queued replies and post-generation writes;
  auto-call admission rechecks AI mode and actor but does not yet carry an epoch
  through the dispatcher/SIP effect or enforce the saved flow version there.
- Active actor/tenant checks and UI/RLS permissions need the independent complete
  role matrix; the focused tests above are not all-role penetration evidence.
- Unknown Meta outcomes intentionally stop rather than risking duplicate sends.
  A complete operator reconciliation workflow and remote provider acceptance
  audit are still needed before unattended production retry operations.
- Local test success is not staging deployment success, real-provider success,
  cloud IAM validation, queue drain under SIGKILL, or performance/capacity proof.

Next: parent merges the candidate evidence and reviews/promotes only after the
user's runner is stopped; execute the full isolated readiness and image/recovery
gates before a separately approved staging deployment.
