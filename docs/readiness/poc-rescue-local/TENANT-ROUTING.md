# Tenant and runtime inventory

Read-only evidence: ignored remote-inventory.txt, wa-remote-trace.txt and wa-live-boundary.txt in .artifacts/poc-rescue-local. No credentials included.

| Boundary | Or-On | ProTouch |
|---|---|---|
| Active tenant | 00000000-0000-0000-0000-000000000001, or-on-dev | 633d9906-3866-4ddd-b85c-99c525bd3cb3, protouch |
| WhatsApp channel | 3ad0fb44-731e-45ae-b397-5d649e1cb6bc | 425601b5-2abc-4b9a-912c-731e6705446f |
| Meta phone ID | 1312069101984418 | 1284902841381185 |
| Display number | ***5689 | ***4553 |
| Runtime credentials | Primary scoped account | Additional account protouch in web and worker |
| Real/AI flags | Enabled | Enabled |
| Durable ledger sample | 88text+190status | Zero including after user test |
| Meta registration | CONNECTED/CLOUD_API, is_on_biz_app=false; code verification EXPIRED | VERIFIED/PENDING/NOT_APPLICABLE, is_on_biz_app=false; ordinary registration rejected because existing WhatsApp Business phone app owns number; user requires preservation |
| Effective WhatsApp agent | v4 `072b9420...`, Flow `0b501aad...`, new-conversation process `098b05e3...`; see WHATSAPP.md for full references | Profile b9bd6d66-f75e-4c99-a60a-23078a656f1f; published v1 9a9bfdbf-4c46-4bd4-842f-2bfb8c4cb173; service.intake |
| Model | Default gemini-2.5-flash | Selected model null, uses default gemini-2.5-flash |
| Opening catalog | Independent check pending | Empty; no opening-menu configuration |
| Twilio trunk | TKf369cbbb3d6fac68d4d2cc97c8f1d79d | TK8063d67ba0b48332a7a49024dbb164aa |
| Termination address | oron-campaign-1543.pstn.twilio.com | Absent; proposed protouch-oron-4553.pstn.twilio.com |
| LiveKit outbound | ST_hMBmL3fQMdFu; only***5689 | Absent; separate scoped trunk proposed |
| Live call/reply acceptance | Pending | Pending |

Deleted ProTouch c59d42fb-2e8a-4d3e-b739-37158f6ce473 must not be used. Original local DB has different tenants and proves no live bindings. Shared infrastructure does not authorize shared caller ID. Candidate VOICE_OUTBOUND_ROUTES_JSON binds tenant/account/trunk/address/sender and rejects missing or mismatched ownership.

ProTouch AI authorizer is an active platform superuser accepted by the existing authorization function; missing direct membership is not a fault. Missing inbound receipt precedes AI routing. Callback https://dev.or-on.io/api/webhooks/whatsapp/protouch is subscribed to messages on app2636656843431645, WABA992519473248296.

## Running DEV release

Application revision:42eebac2d423bb70a0c69690e8d2899beab12249. Schema:fc6e851f3ba0.

| Image | Immutable digest |
|---|---|
| web | sha256:dedf6afa3abd205eac9886dbd2e1254703348550c798e020d0dbede78df39983 |
| worker | sha256:7577de7d310ef9a80806e66d1cb06e0deaf3d9d6c52d1847cdb7dc32eebf862d |
| dispatcher | sha256:e596b3e0016b610eefb90661e789deeee044b3522c85fed7bcc13fafb1d377f9 |
| control-api | sha256:a0f4c3996c767bfb5c9558319813c3418f6158ddd0d3afec015bf7b4667ef440 |
| PostgreSQL | sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af |
| Caddy | sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 |

Host oron-dev/project website-478708/zone me-west1-b: e2-medium4GB;38GB disk, approximately25GB free, swap in use at inspection. This is one snapshot, not before/after performance evidence. Artifact bucket is in the same region with7day soft deletion; independent retention/off-host application recovery unproved.
