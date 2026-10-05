# ProTouch authenticated inbound operator plan

Status: the reviewed carrier route was activated on `0f003ccd` / schema
`af54b6c13e92` at approximately 2026-10-05 00:25 UTC. The DID is bound to the new
authenticated rule and the exact Twilio number routes to the signed callback.
The earlier `79a4a84` proof remains failed; after its settlement repair, a separate
positive-only proof durably quarantined the caller on the first attempt, with no
application session/contact or surviving room. See
[the exact proof history](PROTOUCH-DIGEST-PROOF.md). One post-cutover outbound
regression reached ringing but ended `USER_UNAVAILABLE`, answered=false; it is
not a successful conversation. Incoming PSTN acceptance remains pending.

LiveKit explicitly documents inbound TwiML with SIP username/password and a
webhook as an alternative to a TwiML Bin. Elastic SIP origination cannot supply
that authentication. TwiML inbound does not support SIP REFER; the existing
Elastic path continues handling outgoing calls.
Sources: [LiveKit inbound trunk](https://docs.livekit.io/telephony/accepting-calls/inbound-trunk/),
[LiveKit Twilio integration](https://docs.livekit.io/telephony/accepting-calls/inbound-twilio/).

Twilio permits an account-owned DID as outgoing caller ID and states that
disassociation from a trunk retains the number in the account. Moving this
number's incoming handling therefore preserves the documented caller-ID basis;
the outbound tenant route, LiveKit trunk, Elastic trunk and dedicated credentials
remain unchanged. The provisioner needs an explicit pinned-PN account-ownership
mode rather than removing its ownership check. The number API gives TrunkSid
precedence over VoiceUrl, so merely setting a callback without detaching the
incoming association would not activate it.
Sources: [Twilio trunking](https://www.twilio.com/docs/sip-trunking),
[IncomingPhoneNumber](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource).

Account-specific pricing readback at 2026-10-04T23:17Z identified the existing
PN as local: Programmable Voice inbound USD 0.01070/minute versus Elastic local
origination USD 0.0067/minute. The public SIP leg rate is USD 0.004/minute.
The indicative Twilio bridge total is USD 0.0147/minute, an increase of
USD 0.008/minute (USD 8 per 1,000 billable minutes), before existing DID rental,
LiveKit/AI, tax and billing increments. The SIP public rate is not an
account-specific quote. This uses the existing account and requires no new
subscription. The user has been informed of this usage difference.
Sources: [Twilio pricing API](https://www.twilio.com/docs/sip-trunking/pricing-trunking-resource),
[Israel Voice pricing](https://www.twilio.com/en-us/voice/pricing/il).
Receipt: `.artifacts/poc-rescue-local/twilio-programmable-inbound-pricing.json`.

## Exact scope and prerequisites

- Active tenant: `633d9906-3866-4ddd-b85c-99c525bd3cb3`.
- Existing Twilio number: `PN0a62bfdaaf8f2a393860ab1c6bc3f466`, masked `***4553`.
- Retained inbound LiveKit trunk: `ST_aJJSDZMGTeJ8`.
- Verified project SIP host: `12ecwwpmj7c.sip.livekit.cloud`.
- Callback: `https://dev.or-on.io/twilio/voice/inbound`.
- Current contained baseline: zero dispatch rules; original simulator DID marker;
  unchanged carrier origination `sip:34.165.22.57:5060`.
- Full backup: `/opt/oron-dev/backups/dev_oron_platform-20261004T232100Z.backup.tar.gz`.

The exact new release must preserve the DID's dispatch rule through
PhoneResolution and compare it with signed `sip.ruleID` before starting any
session/model. It must also enforce the configured TwiML trunk/tenant and
per-call REFER restriction. `60f26bf` does not have this admission guard.
The earlier simulator marker was not itself a security barrier; that probe's
failed session resulted from agent startup failure.

TLS certificate and hostname verification against the actual Cloud host on
port 5061 passed with TLS 1.3. This was a handshake only, not an authentication
or call test. The plan pins TLS with no silent TCP fallback. Both providers
document TLS signaling; media encryption is a separate setting and this proof
must not be described as proving SRTP.
Sources: [Twilio SIP](https://www.twilio.com/docs/voice/twiml/sip),
[LiveKit secure trunking](https://docs.livekit.io/telephony/features/secure-trunking/).
Receipt: `.artifacts/poc-rescue-local/livekit-sip-tls-readonly.json`.

## Controlled sequence

1. Review the plan at `.artifacts/poc-rescue-local/protouch-digest-operator-plan.json`.
   Its `approved_guarded_revision` stays unset until the new release, tests and
   actual private/public readiness checks are verified. Run the GET-only review:
   `.venv/Scripts/python.exe .artifacts/poc_protouch_digest_operator.py --phase review`.
2. Protected local preparation stores the original full routing fields and
   outbound invariant hashes in `.artifacts/protouch/inbound-operator/baseline.json`.
   Dedicated inbound credentials and runtime routes use separate user-only ACL
   files. Root-only remote copies are `protouch-inbound-digest.json` and
   `protouch-inbound-operator-routes.json` under `/opt/oron-dev/shared/config`.
   Secret contents are never printed or committed. The operator requires a
   matching remote 0600 backup before its first provider write.
3. After the new admission guard is deployed, `--phase prepare-auth --apply
   --expected-source <full SHA>` updates only the retained trunk's dedicated
   username/password and removes the exact eight preflight-matched addresses
   using `ListUpdate(remove=originalCIDRs)`. An offline actual-SDK serialization
   check verifies those eight removals and no other list changes; empty-list
   assignment is not relied on. The original
   eight CIDRs remain in the protected snapshot and incident evidence. One new
   explicit-trunk individual rule is created, with no automatic agent dispatch.
   The DID database marker still remains simulator. No parallel same-DID matcher
   or wildcard rule is allowed.
   LiveKit readback masks the password as exactly eight asterisks. This is
   accepted only after the recorded owned update with matching unique username
   and protected backup hash; it is never reported as password verification.
   Correct/wrong SIP digest evidence supplies that independent verification.
4. The reviewed one-shot remote probe takes a stable `--probe-id`, full source
   and exact newly created rule. It sends one unauthenticated case, one wrong
   password case, and one correct digest case, at most five INVITEs including
   challenge retries. It uses a fictional reserved-555 caller and never requests
   a PSTN leg. Responses must match exact Call-ID and CSeq. The correct case ACKs
   immediately, waits at most four seconds for the signed quarantined join, and
   attempts BYE in `finally`. No timeout counts as rejection. The helper refuses
   to rerun an existing probe receipt.
5. Verify explicit negative rejections, correct 200, signed exact trunk/rule
   attributes, no application session/agent/contact, and actual room absence
   through LiveKit. Cleanup may remove only rooms named in the exact probe
   receipt or independently matched by its exact SIP Call-ID. Before DID binding,
   callback unsigned/tampered/foreign/invalid-signature tests must return 403,
   and valid HMAC must return routing-unavailable 503 while the marker remains
   simulator. That 503 does not test the provider call lookup. The local proof
   combiner checks source/rule/probe equality and produces the `bind` phase gate.
6. The remote binding helper rehearses, then commits, an audited exact DID CAS
   from simulator to the newly proven rule. It preserves tenant, DID and flow.
   The preflight runs the actual compiled inbound configuration resolver and
   confirms the intended effective agent and latest canonical automation, so an
   old published row merely continuing to exist does not satisfy the gate.
7. After audited binding and before carrier routing changes, test the known
   completed/outbound CallSid with valid HMAC and exact configured To. Require
   403 `invalid provider call` without XML/secrets. Do not attribute rejection
   to one individual status/direction/number predicate. The proof combiner adds
   this distinct receipt for the `cutover` phase; the early 503 cannot satisfy it.
8. `--phase cutover --apply --expected-source <full SHA>` requires all proofs,
   no active calls, exact protected runtime configuration hash, and fresh
   unchanged ownership/routing. It changes only this PN's TrunkSid to empty,
   VoiceUrl to the exact callback and VoiceMethod to POST. All other routing
   fields and outbound invariants are compared before and after.
9. Actual incoming-call acceptance remains a separate controlled human test.
   Provider configuration readback is never reported as successful PSTN service.

## Recovery and idempotence

Unknown provider outcomes are read back before resuming. New credentials are
reused from the protected operation state; neither a timeout nor a rerun rotates
them. Existing rules must match the exact owned name, metadata and trunk.
Independent routing drift stops both cutover and rollback before mutation.

At zero active calls, restore the exact saved Twilio number routing first.
Then use the audited reverse CAS to restore the simulator marker, delete only
the new digest dispatch rule and confirm zero rules. Keep digest authentication
on the retained trunk. Never recreate unsafe deleted rule
`SDR_AcS72sUqk2ZM`. Disable callback configuration only after the DID no longer
points to it.

Only `restore-number`, binding `--mode restore`, and `contain-auth` may use the
narrow recovery gate when an application is unhealthy. Exact deployed/image
source, queryable PostgreSQL, schema, zero active database sessions and original
DID tenant/flow ownership remain mandatory. A fresh read-only LiveKit room-list
request must also prove zero rooms in the entire configured project; any room
blocks these recovery actions, even if the database says zero. The token has
only the room-list grant. Restoring the database marker additionally checks the
carrier's complete original number-routing snapshot first. All activation and
proof phases retain healthy-application and effective-runtime-binding checks.
Offline fixtures reject attempts to use the recovery exception for prepare,
bind, cutover, or an arbitrary readiness bypass.

Once the DID uses the callback, the application has a capability floor: do not
roll back to `60f26bf`, `0331908b`, or another version lacking this endpoint and
binding guard until external number routing has been restored. Initial release
rollback before provider cutover is a different, safe phase. Restoring the old
carrier destination restores configuration, not proven inbound availability.

Current readback on deployed `bdaa5a3244c68cc6ba1d043807d4220bb62a12c1` /
`af54b6c13e92` preserves the activated exact carrier callback, DID binding,
dedicated digest policy and outbound configuration. A separate real non-SIP
RTC lifecycle verified the durable `roomEndReason` parser repair without a
phone call. This does not replace incoming PSTN acceptance; the latest passive
inspection at 00:56:21 UTC on 2026-10-05 still found no incoming session since
cutover. See [the actual proof history](PROTOUCH-DIGEST-PROOF.md).
