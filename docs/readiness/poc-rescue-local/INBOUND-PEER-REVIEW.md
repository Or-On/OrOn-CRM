# Independent authenticated-inbound review

October 5, 2026. Reviewed candidate source `79a4a84d1df4e00bad2e7821b5673c102bba55b5`, including the independent test checkpoint `8e1a0a0`. This is local source, regression and loopback evidence. It does not establish deployment, provider digest enforcement, carrier cutover or successful live inbound calling. The last verified live baseline for this review is `60f26bf`; WhatsApp remains PENDING.

The independent probes first reproduced the existing DID-only admission defect and three separate defects in the new implementation. Each now has its own coverage row:

| ID | Reproduction | Verified correction |
|---|---|---|
| DISC-028 | Missing or foreign signed `sip.ruleID`, and missing or simulator authoritative rules, all reached session startup. | Preserve `dispatch_rule_id` in authoritative resolution; require exact real rule identity before session/contact/agent work. Four negative dispatcher fixtures deny admission. Actual PostgreSQL tests under `platform_voice` verify active tenant, flow ownership and transaction-local context cleanup. |
| DISC-029 | A 28-character non-ASCII signature raised `TypeError` inside constant-time string comparison. | Reject malformed signature encoding before comparison, database resolution or provider lookup; return 403 without XML. |
| DISC-030 | A valid provider JSON body split after nine bytes triggered a false verification failure because `read(n)` returned the available fragment before EOF. | Consume bounded chunks through EOF. Real loopback tests accept fragmented active calls and reject foreign identity, terminal status, redirects, oversized and malformed responses. |
| DISC-031 | A formatted equivalent DID resolved to the configured tenant but missed the raw-text route comparison, admitting a foreign trunk and defaulting REFER support to true. | Use the same canonical DID for resolution, configured route checks and call context. The exact trunk/tenant check now refuses this case before session or agent work. |

Missing rule identity is quarantined without deleting the room: an outbound SIP leg after dispatcher restart also lacks this attribute. Other rule mismatches close the inadmissible room. This exception prevents teardown of an existing outbound call; it does not permit new inbound admission.

The review also inspected signature validation before database/provider reads, the fixed provider API origin and disabled redirects, typed route/secret isolation, and the normal/emergency action-time REFER gates. Unsupported transfer preserves the truthful urgent-followup path without opening a provider client or promising a human connection. The source uses the existing `platform.current_tenant_active()` capability without broader table grants.

Verification on the frozen candidate:

- **35 passing executions**: 17 independent admission/isolation probes plus 18 tracked real-loopback provider cases. These overlap in coverage and are not 35 distinct product requirements. Command: `uv run --no-sync pytest .artifacts/poc_twilio_inbound_peer_review.py packages/py/oron-dispatcher/tests/test_twilio_call_lookup.py -q -p no:cacheprovider --tb=short`.
- The implementation workstream recorded **314 passing combined regressions**, a later **87-case handler/dispatcher/provider run**, **25 handler cases** including the published signature vector, **13 transfer cases**, and **4 actual PostgreSQL cases**. These suite counts must not be added together. [Implementation evidence](TWILIO-INBOUND-SIGNED-ROUTING.md) identifies their scope and artifacts.
- Six isolated TLS/Caddy routing cases passed: only the exact provider callbacks reached dispatcher, and forged forwarded authority was replaced by the actual proxy origin. This was a local proxy proof, not a production callback test.
- Independent tracked tests passed Ruff and formatting checks. Implementation checks report scoped Ruff clean and explicit-source Pyrefly with zero errors.

Sanitized receipts are in `.artifacts/poc-rescue-local/twilio-inbound-peer-before.json`, `twilio-inbound-peer-after.json` and `twilio-inbound-peer-final-79a4a84.json`. Tests use fictional identities and local HTTP servers; no real provider was called by this review. No blocking finding remained in the reviewed source after these corrections.

The prior [provider ACL failure](PROTOUCH-INBOUND-ACL-FAILURE.md) remains unresolved by this local result. Containment depends on removing the provider dispatch rule, not on the old simulator marker. Follow the [authenticated inbound plan](PROTOUCH-AUTHENTICATED-INBOUND-PLAN.md) for exact-image and provider admission gates. Actual secure inbound acceptance and the broader per-DID call/listening requirements remain open.

## Subsequent deployed probe and database settlement review

The preceding review records the evidence available before deployment. Release `79a4a84` was subsequently deployed on schema `9e43a5b02d81`, with healthy image readback and an independent postcheck. The [bounded digest probe](PROTOUCH-DIGEST-PROOF.md) at 2026-10-04 23:56 UTC reached the intended provider trunk and rule with correct authentication, then the application guard deleted the unbound room before any session or contact was created. The original suite **failed**: the join receipt became `processed` with no safe reason about 61.5 seconds later. This is not durable quarantine acceptance or a successful incoming call. The owned authenticated trunk/rule now remain, while the DID retains its simulator marker and the carrier retains its original routing.

**DISC-032** records the missed database contract: the guard's three new safe reasons were absent from `ops.settle_livekit_claim`. The live SQL exception was not captured; actual PostgreSQL tests separately reproduced `invalid_livekit_settlement` (`22023`). The earlier source/loopback review did not exercise these new reasons through the actual SQL settlement function. The prior successful authorization fixtures therefore did not establish this durable outcome.

Independent review of repair `0f003ccd0049e6c2b0bc8f19e17a80d7f339e198`, additive migration `af54b6c13e92`, confirmed that the new function is identical to its predecessor after removing only `OR REPLACE` and the three added constants. Owner, grants, fixed search path, exact claim and unexpired-lease fences, retry/exhaustion behavior and updates are unchanged. Downgrade intentionally keeps the additive safe vocabulary for mixed application rollback; no existing ledger entries are rewritten.

The actual-role red baseline has **6 failures**. The repaired clean-migration/new-and-existing contract run has **11 passes**; a separate run including concurrent claims, expired/replaced leases, restart replay, signed ingress, roles and ledger contracts has **14 passes**. These runs overlap. Tests cover invalid reasons against an active claim, independent account/worker/token mismatches, exact reason and one-attempt settlement, cleared lease, duplicate finality, following room events and zero session/agent startup through the real pump and dispatcher. [Settlement repair evidence](LIVEKIT-QUARANTINE-SETTLEMENT.md) records the test artifacts.

No local migration-review blocker remains. Repair deployment and a new reviewed provider proof remain pending in this record. Incoming PSTN service and WhatsApp delivery remain unverified; the failed provider suite is preserved unchanged.
