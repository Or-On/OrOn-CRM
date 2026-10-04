# ProTouch isolated SIP credential repair

The user authorized live connection, and the root workstream reviewed this
specific repair before application. The approved test to recipient `***7692`
was rejected before ringing: Twilio alert `NO905651db31e501a5a08066c84b35170c`
reported error `32202` (bad user credentials) at `2026-10-04T22:33:40Z`.
The original locally supplied credential cannot authenticate this connection.

Apply only these scoped changes:

1. Create a new credential list named `oron-protouch-livekit-outbound-20261005`
   and a new credential for this integration. Generate its password locally,
   store it in an ignored file protected for the current OS user, and never
   print or commit the value.
2. Associate this new list only with ProTouch carrier trunk
   `TK8063d67ba0b48332a7a49024dbb164aa`.
3. Update only the authentication fields of the newly created ProTouch LiveKit
   outbound trunk `ST_Dc2P469Pn2ZU`. Preserve its sole sender `***4553` and
   current endpoint `protouch-9376.pstn.twilio.com`.
4. Read back both bindings, confirm the previous call ended, then make one
   authorized retry through the normal ProTouch CRM route to `***7692`.
5. After positive carrier authentication, remove only the `CL535451410b7642c6ee5ee3a5f58741c8`
   association added by this workstream from the ProTouch trunk, after a fresh
   comparison. Never delete or change that shared credential list.

Preserve the existing independently configured `CLe46abdd3161f89e8f06784bf8ab9ba88`
list and credential, all Or-On configuration, ProTouch's existing endpoint, and
all inbound origination. The failed attempt is retained as evidence. The first
repair attempt does not authorize repeated calls or resetting existing passwords.

Application receipt and sanitized readback are stored under
`.artifacts/poc-rescue-local/protouch-isolated-credential-repair.json`.
The generated secret is stored separately under `.artifacts/protouch/` and is
not included in that receipt. This document describes an approved repair; it is
not by itself proof of successful ringing or a completed conversation.

The repair was applied. Readback confirmed new list
`CLdac727520623ad93cccddde52d7159c1`, credential
`CRaf8f7d71eee6ea6fe0b3a7f2928e8ea2`, and the existing new ProTouch LiveKit
trunk. The authorized retry produced an active SIP participant and Twilio call
`CA92e7988f5427b50117d951ff64deb28a`, completed for 18 seconds with the correct
business sender and approved recipient. The temporary `CL535…` association was
then removed from ProTouch; the original `CLe46…` and new dedicated list remain.
No shared credential list was deleted or changed.

Recovery is backed by a byte-verified copy at
`/opt/oron-dev/shared/config/protouch-sip-outbound-recovery.env`, owned by root
with mode `0600`. The transfer's protected temporary copy was removed. No secret
value appears in these documents or receipts. This carrier success is separate
from the agent runtime/finalization defects discovered during the live call.
