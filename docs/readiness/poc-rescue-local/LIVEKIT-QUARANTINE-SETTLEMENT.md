# Inbound guard settlement repair

On the deployed `79a4a84` release, the contained correct-digest SIP probe was rejected without an application session or contact. The room was deleted, but its join ledger row later became `processed` with no reason after about 61.5 seconds. The live receipt did not capture the original SQL exception; that exception was reproduced locally.

The dispatcher emitted `missing_inbound_rule`, `inbound_rule_mismatch` or `inbound_transport_mismatch`. The existing `ops.settle_livekit_claim` SQL allowlist did not accept them. After the guard deleted the room, settlement raised `invalid_livekit_settlement` (`22023`). The claim remained processing until its 60-second lease expired; the retry's current-participant check found the deleted room and completed the event. This explains why the safety fence worked while its durable diagnostic was lost. Past live receipts are preserved as observed, not rewritten.

Additive revision `af54b6c13e92`, following `9e43a5b02d81`, adds exactly those three safe constants. The function's provider/account/event/worker/token/unexpired-lease fences, tenant-null restriction, exhaustion/backoff behavior, owner, fixed `pg_catalog` search path and grants are unchanged. No direct table access is added. Downgrade retains the additive safe vocabulary so a mixed application rollback does not reintroduce failed settlement for still-running guards.

Evidence before publication:

- Red baseline on a fresh database at the predecessor schema: **6 failed**, all `invalid_livekit_settlement`. This includes three actual `platform_voice` claim/settle cases and three real `DurableWebhookPump` → `Dispatcher` guard chains. `.artifacts/poc-rescue-local/inbound-quarantine-red.log`.
- Clean upgrade from base, new cases, existing ledger contracts and single-head graph: **11 passed**. `.artifacts/poc-rescue-local/inbound-quarantine-green.log`.
- New cases plus existing concurrent claims, expired/replaced leases, restart replay, signed ingress, role restrictions and webhook ledger tests: **14 passed**. `.artifacts/poc-rescue-local/inbound-quarantine-fences.log`.
- New tests reject free-text and `processed` plus reason while the claim is still active; independently reject foreign account, worker and token; assert final `quarantined` status, exact safe reason, one attempt and cleared lease; duplicate receipt cannot reopen the decision and a following room event proceeds without waiting for lease expiry. No session or agent launch occurs on any negative guard case.
- Independent peer comparison confirmed that removing only the three constants and `OR REPLACE` makes the new function body identical to the predecessor. Scoped Ruff and whitespace checks passed.

All test databases were disposable and removed. The original development database and production data were not modified. Publication and activation require exact built migrator/runtime proof and the operator's subsequent digest admission check; these local results alone do not establish live acceptance.
