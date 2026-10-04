# ProTouch outbound provider plan — awaiting explicit provisioning authorization

The user confirmed business sender `***4553` and approved one test recipient
`***7692`. Remote DB inventory confirms active tenant
`633d9906-3866-4ddd-b85c-99c525bd3cb3`; the older deleted ProTouch tenant must
not be used. Source repair and this read-only review do not activate calls.

Actual read-only carrier evidence:

* `TK8063d67ba0b48332a7a49024dbb164aa`, named `protouch`, owns `***4553`.
  It has no termination domain and no associated credential list.
* Existing list `CL535451410b7642c6ee5ee3a5f58741c8` contains username
  `Protouch`. Its password is already in the ignored, authorized local file
  `.artifacts/protouch/provider.env`; the script never prints/copies it to Git.
* The Or-On carrier trunk owns `***5689` and the current LiveKit outbound
  trunk permits only `***5689`. ProTouch inbound origination currently targets
  a different server from Or-On. Inbound routes are outside this change.

The reviewed JSON is [protouch-outbound-plan.json](protouch-outbound-plan.json).
The dry-run script has been run against the actual provider and proposed
exactly these three changes, without performing any mutation:

1. Set the existing ProTouch trunk's currently empty termination endpoint to
   `protouch-oron-4553.pstn.twilio.com`.
2. Associate its existing credential list, retaining its existing credentials.
3. Create a separate LiveKit outbound trunk `protouch-twilio-outbound`, with
   only business sender `***4553`, that endpoint, and the existing ProTouch
   SIP credential.

This preserves Or-On's trunk, number, credentials and routing. It does not
purchase a number, create a carrier account, change DNS/IAM, update inbound
origination, deploy code, edit the live dispatcher configuration, or dial.

Review command (read-only):

```powershell
.venv/Scripts/python.exe scripts/provision_voice_outbound.py --plan docs/readiness/poc-rescue-local/protouch-outbound-plan.json --provider-env .artifacts/protouch/provider.env --livekit-env .env --receipt .artifacts/poc-rescue-local/protouch-outbound-receipt.json
```

Only after the explicit infrastructure approval, the same command with
`--apply` performs those three changes. The script first rechecks the carrier
account, sender-to-trunk ownership, credential username, existing endpoint and
LiveKit inventory. Conflicting state blocks all mutations. Progress is saved
to the ignored receipt; a retry recognizes an existing matching trunk and
does not create another. Unknown network outcomes require rerunning the
read-only review before deciding whether to resume.

The receipt contains the new non-secret tenant route. It must be added to the
dispatcher's `VOICE_OUTBOUND_ROUTES_JSON` alongside the separately verified
Or-On route, followed by an authorized dispatcher restart. Then validate one
call from each tenant and simultaneous calls to the approved recipient, with
provider call IDs, published agent/flow versions, actual recipient-observed
caller ID, and recordings. Those checks are not yet performed.

Rollback is scoped to this receipt: remove only the newly created LiveKit
outbound trunk, remove only the newly added credential-list association, and
restore the ProTouch trunk's prior empty termination domain if this operation
set it. Keep the carrier number, credential list/password and all inbound
origination entries. Restore the prior dispatcher route configuration before
removing a route's provider trunk. Read current provider state first, and do
not overwrite a subsequent independent change.

`infra/AGENTS.md` requires a separately reviewed plan and explicit
authorization before provisioning infrastructure. This document and the
read-only output provide that concrete review surface; no provider mutation
has yet been authorized by merely confirming sender and recipient identity.
