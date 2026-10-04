# Actual inbound SIP allowlist failure and containment

The single bounded negative-source test failed on 2026-10-04 at 22:58 UTC.
Configuration acceptance/readback did not establish enforcement.

The owned `oron-dev` host sent exactly one SIP INVITE over TCP to verified
project `sip:12ecwwpmj7c.sip.livekit.cloud`, addressed to ProTouch DID `***4553`.
It used a fictional caller in the reserved North American 555 range, valid
SIP/SDP, and no carrier credentials. It did not request a PSTN call. GCP instance
metadata independently confirmed external source `34.165.22.57`, outside every
one of the eight configured Twilio signaling CIDRs.

The provider returned `100 Processing`, `180 Ringing`, then **`200 OK` with
LiveKit SDP**. The probe immediately sent ACK and BYE. The signed provider event
`EV_cDb9PJgCgNfp` identified the exact tested resources:

- Inbound trunk `ST_aJJSDZMGTeJ8`.
- Dispatch rule `SDR_AcS72sUqk2ZM`.
- SIP call `SCL_jvBm7LScNH7F`.
- SIP Call-ID `poc-acl-8fbca2e03a1547feaf8cb1eed92fbe12@oron-dev.invalid`.

The application created one failed ProTouch session,
`f60c63b6-dec3-5dc9-b8cf-2b79e1ce6e30`, with no contact or recording/transcript
artifacts. The join receipt was quarantined and the leave receipt processed.
Later source review established that the failed session/quarantine came from
agent startup failure: the then-current dispatcher resolved the called DID but
did not compare the signed provider rule against the stored DID rule. The
simulator marker alone was therefore not an admission barrier on that release.
An authenticated positive probe must wait for the separately tested, deployed
rule-binding guard; it cannot rely on the old marker behavior.
No active call or probe room remained. Application quarantine does not make the
carrier ACL test pass: the source had already been admitted into LiveKit.

Containment removed only the newly created dispatch rule after ownership and
trunk checks. Readback confirmed zero Cloud dispatch rules. An audited CAS
restored the exact existing phone row's original simulator marker, preserving
tenant, DID and flow. The inbound trunk remains without a dispatch rule for
provider inspection. Or-On, both outbound trunks, credentials, and Twilio's
existing inbound origination were not changed. Probe and audit records remain.
The preparation/cutover helpers now refuse application while this containment
receipt exists; a newly reviewed secure fix is required before another attempt.

Receipts under `.artifacts/poc-rescue-local`:

- `protouch-negative-sip-acl.json`: one actual request and explicit 200 response.
- `protouch-negative-sip-acl-admission.json`: signed ingress, exact resource IDs,
  scoped session, and source-address metadata.
- `protouch-inbound-acl-containment.json`: provider rule removal and no probe room.
- `protouch-inbound-binding-contained.txt`: committed compensating CAS and audit.

LiveKit's [current inbound documentation](https://docs.livekit.io/telephony/accepting-calls/inbound-trunk/)
says that `allowed_addresses` needs project enablement. Whether this project's
behavior results from that entitlement or another provider issue is unconfirmed.
It must not be bypassed with an unrestricted trunk. Obtain provider-confirmed
enforcement or separately review an authenticated inbound alternative, then
repeat a bounded source-rejection test before the carrier cutover.
