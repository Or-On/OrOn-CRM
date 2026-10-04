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
