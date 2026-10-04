# ProTouch outbound provider plan and live application receipts

The user confirmed business sender `***4553` and approved one test recipient
`***7692`. Remote DB inventory confirms active tenant
`633d9906-3866-4ddd-b85c-99c525bd3cb3`; the older deleted ProTouch tenant must
not be used. The user subsequently explicitly authorized live connection and
deployment. The historical proposal below is retained to explain the preflight
and drift detection; it is not the final credential binding.

On the authorized fresh preflight, Twilio already had endpoint
`protouch-9376.pstn.twilio.com` and credential list
`CLe46abdd3161f89e8f06784bf8ab9ba88`. Those independent changes were preserved.
The operation created only ProTouch LiveKit trunk `ST_Dc2P469Pn2ZU` and initially
associated the existing supplied credential list. The first controlled call was
rejected before ringing with Twilio `32202`; that supplied credential could not
authenticate. The subsequent reviewed [isolated credential repair](PROTOUCH-SIP-CREDENTIAL-REPAIR.md)
created list `CLdac727520623ad93cccddde52d7159c1` and a dedicated credential, bound
only to ProTouch. The temporary shared-list association was removed after a
positive carrier call. Existing credentials were not reset.

The single authorized retry used actual published ProTouch agent
`9a9bfdbf-4c46-4bd4-842f-2bfb8c4cb173` and flow
`4b4d1bd3-98c8-4faa-b486-28b8e6a104bb`, both version 1, through authenticated
CRM admission. Twilio call `CA92e7988f5427b50117d951ff64deb28a` completed an
18-second connection from `***4553` to `***7692`. This proves carrier
authentication and that caller identity; the agent encountered a separate
runtime failure, so successful full conversation acceptance is still pending.
The generated credential has a protected ignored local copy and a verified
root-owned `0600` recovery copy under the live private configuration directory.

Both active tenant routes are in the ignored validated
`.artifacts/poc-rescue-local/voice-outbound-routes.json`. Or-On remains on
`ST_hMBmL3fQMdFu`. Its carrier and LiveKit configuration hashes matched the
pre-change snapshots. Detailed receipts are `protouch-outbound-receipt.json`,
`protouch-isolated-credential-repair.json`,
`protouch-isolated-credential-cleanup.json`, and the two live call receipts
under `.artifacts/poc-rescue-local`.

## Historical proposal before the fresh provider check

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
authorization before provisioning infrastructure. Both were supplied by the
subsequent live-connection instruction and scoped operator review. Do not rerun
the historical plan to overwrite the now independently verified active binding.
