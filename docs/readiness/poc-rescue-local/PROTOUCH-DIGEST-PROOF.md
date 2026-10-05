# ProTouch digest authentication proof and settlement failure

At 2026-10-04 23:56 UTC, a single bounded non-PSTN SIP suite ran against release
`79a4a84d1df4e00bad2e7821b5673c102bba55b5`, schema `9e43a5b02d81`.
The original suite result is **failed**. No customer was called, no carrier
number was rerouted, and no database DID binding was committed.

The reviewed preparation changed only retained inbound trunk `ST_aJJSDZMGTeJ8`:
dedicated inbound credentials replaced its ineffective eight-address policy.
Actual installed-SDK serialization verified the eight explicit removals before
the update. One new explicit-trunk rule, `SDR_qwuvuQ9waXV7`, was created with no
automatic agent. The original unsafe deleted rule was not recreated. Protected
credential copies matched locally and remotely; LiveKit's password readback was
redacted, so it was not treated as proof of the password.

## Actual bounded provider results

Probe: `poc-digest-b654d69ad5d644fcba0a56ed65531b0d`.
Verified TLS 1.3, fictional reserved-555 caller, exact owned DID and five INVITEs
total, including challenge retries:

| Case | Responses | Supported conclusion |
| --- | --- | --- |
| No credentials | 407 | Explicit authentication challenge; no admission |
| Wrong password | 407, 401 | Wrong digest rejected |
| Correct password | 407, 486 | Authenticated provider join occurred, then room closed; planned 200/quarantine assertion failed |

The exact correct-password SIP Call-ID ends
`-correct_password@oron-dev.invalid`. Signed event `EV_c89Zq4Bbwvy6`, ledger
`9891f656-881e-4413-9cb3-90f7a69d32d4`, identifies the intended trunk and new rule,
SIP participant kind, ACTIVE state, matching DID and ringing status. This is
evidence that the dedicated digest reached the intended provider route.
It is not evidence of a successful conversation or durable quarantine.

The participant-left event `EV_FQ3qAhyo3a9z` reports `ROOM_DELETED`; the Cloud
console independently reported SIP 486 with “room closed.” No application
session or caller contact identity was created. At 2026-10-05 00:00:58 UTC,
LiveKit listed zero rooms, including absence of the exact probe room. No cleanup
mutation was needed.

## Durable settlement defect

The joined receipt arrived at 23:56:07.326Z but settled as `processed` at
23:57:08.829Z, approximately 61.5 seconds later. Its final safe-error field was
null. The left event also settled `processed` after the delay. The original
receipt and this later readback are retained separately.

The new guard raises `inbound_rule_mismatch` after deleting an unbound room.
The existing `ops.settle_livekit_claim` function permits only the older set of
quarantine reasons. It rejects `inbound_rule_mismatch`,
`inbound_transport_mismatch`, and `missing_inbound_rule` with
`invalid_livekit_settlement`. A subsequent expired-claim retry can see the
participant already gone and settle the event as processed. This explains why
the terminal ledger state cannot be presented as durable guard verification.
An additive database migration and real PostgreSQL regression are required;
the failed suite must not be relabeled as passed.

## Separately scoped callback evidence

The authorized callback helper was already running when the hold instruction
arrived; it finished at 2026-10-05 00:01:39 UTC before cancellation. Unsigned,
tampered-body, foreign-account and invalid-signature requests each returned
403. Valid HMAC while the DID retained its simulator marker returned 503
`provider routing unavailable`. All five responses contained no XML or
configured credentials. No provider call lookup was exercised, so this is not
a completed-call rejection proof. It is evidence for release `79a4a84` only.

## Repair and separately proven activation

Release `0f003ccd0049e6c2b0bc8f19e17a80d7f339e198` deployed with additive schema
`af54b6c13e92`. Before the next proof, fresh read-only provider checks verified the
same protected secret and auth policy, exact retained rule, no overlapping
matcher, zero rooms, unchanged outbound inventory and complete original number
route. The provider policy's update timestamp, 23:53:56.338439Z, predates the
historical negative suite. Only the provider's empty media protobuf (zero wire
bytes) was normalized against its previously absent empty value.

The separately authorized positive-only probe
`poc-digest-f5da706e5f7b44308e846aba13a2b637` ran once at
2026-10-05 00:21:56–00:22:00 UTC, with exactly two INVITEs: 407 then 486.
Signed event `EV_ssdB8wwgcwsb`, ledger
`886a5126-06c0-488b-81c0-a7d43bf2b108`, matched the exact probe, trunk and rule and
settled **quarantined on attempt 1** with `inbound_rule_mismatch`. The matching
left event reported `ROOM_DELETED`. Application sessions, caller contact
identities, active calls and LiveKit rooms were all zero. The 486 is consistent
with deliberate guard deletion; the independently verified first-attempt ledger
result, not the SIP status alone, makes this repaired proof pass.

The original negative authentication results are reused only as historical
evidence for the freshly verified unchanged provider policy. They are explicitly
attributed to `79a4a84`; a full authentication suite was not rerun against
`0f003ccd`, and the original failed suite was never rewritten.

New source-specific callback checks returned four 403 rejections and the expected
simulator-binding 503 without XML or secrets. An audited exact DID CAS was first
rehearsed with rollback and then committed, preserving tenant, DID and flow.
Its proof SHA-256 is
`ea39b96286055dae5b74480db264cc65b2e8c8b5293860da56ac3b284f810380`.
After real binding, a validly signed request naming the known completed/outbound
call returned 403 `invalid provider call`, proving rejection after provider
lookup without attributing it to one particular predicate.

Only after those gates, the reviewed Twilio number route changed to empty
TrunkSid, the exact `/twilio/voice/inbound` HTTPS callback and POST. Full readback
confirmed all other routing fields unchanged, with outbound LiveKit inventory,
Elastic origination, credential lists and termination domain preserved. No PSTN
call was placed by the operator helpers. Incoming human-call acceptance and
post-cutover outbound regression remain separate evidence.

## Post-cutover outbound regression

The parent submitted exactly one additional authorized call through normal CRM:
session `57d373de-1375-5ed8-917b-c975ab50f6d9`, created at 00:26:09.723Z.
Read-only provider verification matched source `***4553`, recipient `***7692`
and the unchanged Elastic trunk. Twilio `CA6cdfca66ac20f2d7fcca4f479353bacc`
reported failed, duration 0 and USD 0.00000. Signed LiveKit events for
`SCL_Eg2oCSr2dHts` show dialing, then ringing and `USER_UNAVAILABLE` at
00:28:06.960Z. These support an unavailable/unanswered destination; detaching
the DID is not an established cause. There was no further dial.

The application ended at 00:28:08.959Z with answered=false and both artifacts.
Artifacts and ringing are not evidence of a completed human conversation.
The exact inbound number route and rule remained unchanged, with zero active
application calls and zero provider rooms in the readback.

A separate issue remains under diagnosis: room-finished event
`ceccdd53-51ec-4809-ad61-bf2d7b823a7e` / `EV_4hczEHMmjVZF` exhausted eight
attempts and was quarantined as `dispatcher_attempts_exhausted`. Bounded
dispatcher logs contain only a room-already-gone 404 warning, and PostgreSQL
logs contain no error; the inner handler exception was not logged. The original
event is preserved and was not manually replayed or settled. It is not treated
as a benign duplicate without further reproduction.

Receipts: `live-voice-postcutover-{provider,result,errors,insights}.json`,
`protouch-room-finished-diagnostics.json`, and
`protouch-finalization-pg-errors.json` under the same evidence directory.

## Recovery state

The retained authenticated trunk and new rule remain in place, and the actual DID
binding is `SDR_qwuvuQ9waXV7`. The complete original carrier route and simulator
marker remain preserved for audited rollback. Full backup before repair:
`/opt/oron-dev/backups/dev_oron_platform-20261005T000233Z.backup.tar.gz`.
The application now has a capability floor: restore external number routing,
then the DB marker/new-rule containment, before reverting to a release without
the callback and admission guard. Never recreate deleted unsafe rule
`SDR_AcS72sUqk2ZM`.

Evidence under `.artifacts/poc-rescue-local/`:

- `protouch-digest-operator-receipt.json`
- `poc-digest-b654d69ad5d644fcba0a56ed65531b0d.json` — original failed suite
- `poc-digest-b654d69ad5d644fcba0a56ed65531b0d-readback.json`
- `protouch-digest-room-readback.json`
- `protouch-digest-callback-before-binding.json`
- `protouch-digest-offline-static-checks.json`
- `poc-digest-f5da706e5f7b44308e846aba13a2b637.json`
- `protouch-digest-policy-unchanged-0f003ccd0049.json`
- `protouch-digest-callback-before-binding-0f003ccd0049.json`
- `protouch-digest-callback-after-binding-0f003ccd0049.json`
- `protouch-digest-binding-bind-{rehearsal,committed}.json`
- `protouch-digest-{bind,cutover}-proof-gates.json`
