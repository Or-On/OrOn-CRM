# ProTouch live activation — October 5, 2026

The user's instruction to connect everything live authorized the previously
reviewed image publication, deployment and scoped ProTouch telephony activation.
This supersedes the earlier waiting-for-deployment-approval status for those
actions. It does not authorize deleting the WhatsApp Business phone account.
The user subsequently declined a new paid Coexistence subscription.

## Deployed release

The actual host `oron-dev` now runs source
`60f26bfe1775997da1fb5159ec9e09a08246068b`, schema `9e43a5b02d81`.
All five application images were published from the previously tested image
IDs, checked by immutable registry digest and OCI revision, then deployed using
the exact reviewed deployer. The archive SHA-256 is
`6d71a81e10748d5049a0124dee21181483be06e07faa083757729c3e51dc3cf8`.

This supersedes the first activation of `0331908`. The later release fixes
the two failures reproduced by the initial live calls: early-disconnect
finalization and a Soniox socket expiring before first speech. The combined
focused suite passed108 tests, independent review, Ruff and Pyrefly. The exact
built dispatcher produced real Hebrew audio after15 seconds before first text,
then after a closed-socket reconnection, with no provider errors or leaked tasks.
The second deployment completed at23:06UTC on October4 (02:06 local October5).

The deployment exited zero and proved all application/edge/database services
healthy, the expected running images, HTTPS readiness and HTTP redirect.
A separate post-deploy check passed release/schema/runtime health, matching
private field keys, real WhatsApp/AI runtime configuration, and private-object
read/write interoperability between web and messaging worker. No secret values
were emitted. Existing systemd units already matched the reviewed release.

Before deployment, a full database/private-object backup was created at
`/opt/oron-dev/backups/dev_oron_platform-20261004T222802Z.backup.tar.gz`.
The deployer also stopped writers and made its database-only migration backup.
An additional full backup before the voice repair is retained at
`/opt/oron-dev/backups/dev_oron_platform-20261004T225532Z.backup.tar.gz`.
After the successful60f call and inbound containment, another full backup was
created at `/opt/oron-dev/backups/dev_oron_platform-20261004T232100Z.backup.tar.gz`
before preparing the authenticated inbound alternative.
The original private configuration is retained under root-only
`/opt/oron-dev/protouch-go-live-private-r9h5kxx6`; its deployment log records the
exact operation. Previous releases/images remain available. Schema rollback
must follow the documented recovery/compatibility constraints, especially
before any Coexistence activation.

The voice-repair deployment log is
`/opt/oron-dev/protouch-voice-fix-60f26bfe1775997da1fb5159ec9e09a08246068b.wx6Mmt/deployment.log`.
Independent post-deploy checks of the60f release passed the same
release/schema/service health, protected configuration and cross-service
private-object boundaries.

## Telephony activation

Fresh provider inspection found an independently changed ProTouch termination
domain and credential association. The operation preserved those changes:
`protouch-9376.pstn.twilio.com` and the existing associated list remain in place.
It added the previously reviewed credential-list association and created a
separate LiveKit outbound trunk `ST_Dc2P469Pn2ZU`, limited to sender `***4553`.
The postflight dry run proposed no further changes.

The deployed dispatcher now has explicit routes for both active tenants.
ProTouch uses tenant `633d9906-3866-4ddd-b85c-99c525bd3cb3`, the new trunk and
sender `***4553`. Or-On retains its existing trunk and sender `***5689`.
The original dispatcher config was snapshotted before this single-key change.
The four existing real voice/WhatsApp/AI feature flags remained enabled.

The published ProTouch agent and voice flow, authenticated owner access,
`voice:operate` permission, and existing approved contact `***7692` with granted
voice consent were verified through the actual application. The controlled
outbound call result and inbound routing assessment are recorded separately;
provider creation alone does not prove a completed conversation.

The first controlled call, session `c45df0f7-8daa-5efa-ab32-0c739c77f5a1`, did
not ring. Twilio reported error32202, authentication failure. The locally
supplied SIP password was not valid. The scoped repair created a dedicated
ProTouch credential list and credential, associated it only with the ProTouch
carrier trunk, and updated only the new ProTouch LiveKit outbound trunk.
Existing credentials were not reset. After successful carrier authentication,
the temporary shared-list association added by this workstream was removed.
The new recovery secret is retained root:root0600 at
`/opt/oron-dev/shared/config/protouch-sip-outbound-recovery.env`, and in an
ignored, current-user-protected local file. See
[PROTOUCH-SIP-CREDENTIAL-REPAIR.md](PROTOUCH-SIP-CREDENTIAL-REPAIR.md).

The second controlled call, session `fc93b04d-7f3e-56ab-a5ef-8bebe1864c56`,
reached the approved recipient. Twilio call
`CA92e7988f5427b50117d951ff64deb28a` completed with18 seconds after answer,
using exact sender4553, recipient7692 and the ProTouch carrier trunk. This
proves carrier authentication and routing, **not successful AI conversation**:
Soniox TTS closed its idle socket while the phone rang, then the first speech
context emitted no audio and triggered the runtime failure announcement.
The first call also exposed an early-disconnect finalization race. Both fixes
are deployed in60f26bf; the corrected call was separately accepted below.
The failed first call was reconciled through an audited operator correction
to failed/not-answered with carrier-authentication-failure outcome, preserving
the original events and end time.

The third controlled call on60f26bf passed the actual outbound acceptance:
session `0af0ed12-555f-5cc8-bc4e-47a033fe1be8`, Twilio call
`CA6ed0c3249d2ce35f29e0baeb558232bb`, exact ProTouch carrier trunk and
sender4553/recipient7692. The provider completed23 seconds of answered time
from23:10:03 to23:10:26UTC. The user explicitly confirmed that it arrived and
the agent conversed in Hebrew in response to the caller-ID/Hebrew question.
The canonical session ended with answered=true and support outcome; no TTS or
finalization error appeared in the bounded logs, and no active call remained.

The authenticated [CRM call detail](https://dev.or-on.io/voice/calls/0af0ed12-555f-5cc8-bc4e-47a033fe1be8)
returned200 and displayed an audio player. Its protected recording is a
2,695,964-byte stereo24kHz WAV (28.0825 seconds, nonzero audio). Its transcript
contains three nonempty Hebrew lines. Both artifact requests returned200 with
private/no-store headers; the other tenant received404 and anonymous access401.
The effective agent is ProTouch `9a9bfdbf-4c46-4bd4-842f-2bfb8c4cb173` v1.
This verifies one ProTouch call, not multi-tenant concurrency or load acceptance.
Application telephony cost remains unknown/unpriced; the separate actual carrier
receipt reports USD0.06060, without treating that as a complete application bill.

Inbound remains separately pending. The existing DID row has the correct
ProTouch tenant and published voice flow, but a simulator dispatch marker.
Twilio's current origination points to the owned `oron-dev` VM, which has no
SIP5060/5061 listener. After the user logged into LiveKit, its Console verified
project `p_12ecwwpmj7c` and exact URI `sip:12ecwwpmj7c.sip.livekit.cloud`.
The project webhook was configured for `https://dev.or-on.io/livekit/webhook`,
using the existing key privately matched to the dispatcher. A real LiveKit
Console test delivered signed `room_started` event `EV_eugWmGhovZmm`, returned
HTTP200 and reached durable `processed` state in one attempt at22:46:34UTC.
An independent unsigned request returned401.

A restricted inbound trunk and explicit dispatch rule were prepared, and the
exact DID was bound by an audited CAS. However, one controlled SIP test from
the owned VM outside all eight allowed carrier CIDRs received200OK and entered
that exact trunk/rule. The rule was immediately removed and the DID's original
simulator marker restored by an audited compensating CAS. No PSTN call was
made and no active probe room remains. Carrier origination was never switched.
The trunk remains without a dispatch rule for inspection; both outbound paths
are unchanged. Readback acceptance of an ACL is not enforcement proof.
See [PROTOUCH-INBOUND-ACL-FAILURE.md](PROTOUCH-INBOUND-ACL-FAILURE.md).
The Console shows the existing Build plan and the configured addresses, but no
project-enablement control. Inbound activation requires verified enforcement
or a separately reviewed authenticated alternative.

## WhatsApp status

Fresh Graph API and authenticated WhatsApp Manager agree that ProTouch phone
`1284902841381185` remains `PENDING`; it is not connected to Cloud API.
Or-On's separate phone remains `CONNECTED`/`CLOUD_API`.
The ProTouch Business phone app is preserved. No ordinary `/register` retry,
phone deletion, new provider account, subscription or new terms acceptance was
performed. The existing Twilio account has only its shared WhatsApp sandbox.

The prepared [external provider option](PROTOUCH-COEXISTENCE-PROVIDER-OPTION.md)
was declined because the user does not want a new subscription. WhatsApp live
CRM activation remains blocked by the required supported Coexistence onboarding;
deployed application health must not be reported as WhatsApp delivery success.

## Evidence

Ignored local receipts are under `.artifacts/poc-rescue-local/`:
`release-60f26bfe1775997da1fb5159ec9e09a08246068b/release-receipt.json`,
`soniox-image-preview-60f26bfe/image-receipt.json`,
`protouch-outbound-receipt.json`, `voice-provider-before.json`,
`voice-provider-after.json`, `voice-outbound-routes.json`,
`live-voice-profile-preflight.txt`, and `live-voice-app-preflight.json`.
