# ProTouch Cloud API registration: reviewed scope

Observed on 2026-10-04, deployed source `42eebac2d423bb70a0c69690e8d2899beab12249`, schema `fc6e851f3ba0`. This document is a plan, not evidence of a completed change.

**Execution update:** After explicit user approval, the parent created a root-owned mode-0600 PIN reference and attempted registration. HTTP 400/code 100/subcode 2388001 was returned. After reconciling the rejected state, one repeat with the same PIN captured Meta's reason: the number is already registered with an existing WhatsApp account and must be disconnected first. Provider trace `A6p8XWhd8LwAceVs6Vh5sZj`; sanitized evidence `wa-registration-rejection-detail.txt`. The phone is still pending. No further registration attempt, deletion or deregistration follows automatically. The user must identify whether the existing installation is consumer WhatsApp, Business App, or another provider and choose an authorized migration/disconnection path.

The read-only `is_on_biz_app=false` field did not prove absence of another WhatsApp account; the registration rejection is now the actionable provider evidence. The user subsequently confirmed that the number is active in the WhatsApp Business phone app. The protected PIN reference is retained without printing its value.

**Current decision point: preserve the Business phone app through Coexistence where eligible.** The parent read Meta's authenticated [Business App onboarding documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/), updated June 26. This path requires eligible Tech Provider/Solution Partner configuration, Embedded Signup with session logging and `featureType=whatsapp_business_app_onboarding`; after that flow the documentation says to skip `/register`. It also requires timely contacts/history synchronization and the additional `account_update`, `history`, `smb_app_state_sync`, and `smb_message_echoes` webhook flows. The plain registration operation below is suspended; do not disconnect or delete the Business phone app to get around the rejection.

Read-only source review found no Embedded Signup/session-logging path or durable handlers for those additional event families. Current webhook parsing handles `value.messages` and `value.statuses`; an otherwise signed unrecognized shape with neither produces `accepted: 0`, without retained Coexistence evidence. No proven history/echo import, business-sender provenance, cross-device deduplication, or import-without-AI-trigger policy exists yet. Ordinary customer-message support is separate from complete Coexistence support. Eligibility/onboarding and the required durable integrations need their own reviewed implementation and tests before claiming the app and CRM are synchronized.

## Exact provider boundary

| Binding | Verified value |
|---|---|
| Active tenant | `633d9906-3866-4ddd-b85c-99c525bd3cb3` |
| Channel | `425601b5-2abc-4b9a-912c-731e6705446f` |
| Account key / phone ID | `protouch` / `1284902841381185` |
| WABA | `992519473248296` |
| Meta application | `2636656843431645` |
| Display phone | suffix `4553`, matched against Meta |
| Registration | `status=PENDING`, `platform_type=NOT_APPLICABLE` |
| Ownership / two-step verification | `code_verification_status=VERIFIED`, `is_pin_enabled=false` |
| Existing Business App / onboarding | `is_on_biz_app=false`, `last_onboarded_time=null` |
| Callback | Active `messages` subscription to `https://dev.or-on.io/api/webhooks/whatsapp/protouch`; public GET verification returns HTTP 200 with the exact challenge |

The user sent a real controlled inbound from the authorized test handset. The subsequent read-only trace still contained no ProTouch inbound event, conversation or job. Tenant activity, WhatsApp entitlement and the enabling actor authorization all evaluated true. The first observed failure is before durable ingress; changing the agent or weakening tenant authorization cannot fix provider registration.

## Proposed operation

1. Re-read the exact phone and WABA binding and registration fields. If already `CLOUD_API`/`CONNECTED`, perform no write. Stop if the state differs from the reviewed pending state.
2. Since Meta explicitly reports no existing PIN, an authorized operator can create a new six-digit PIN, save it to a restricted recoverable secret reference, and pass that reference to the registration operation. Do not expose the value in chat, logs, process arguments or repository files. Do not guess, reset or overwrite an existing PIN if fresh provider state changes.
3. Use the existing ProTouch access credential for one `POST /v23.0/1284902841381185/register` containing `messaging_product=whatsapp` and the PIN. This activates registration and two-step verification; it does not require changes to the primary Or-On account, webhook URL, tenant flags or application images.
4. Re-read provider state and require `CLOUD_API`/`CONNECTED`. A timeout is an unknown outcome: read state before considering another registration attempt. Provider rejection codes are recorded without response bodies or credentials.
5. Ask the authorized test handset to send a fresh inbound; retain provider message ID, ingestion ID, job ID, effective agent version, outbound receipt and delivery status. Distinguish Meta acceptance from handset delivery. Test Or-On independently to confirm its account binding remains correct.

The prepared local helper `.artifacts/poc-register-protouch.py` defaults to read-only, has exact account and full phone guards, accepts a protected PIN file reference and never retries a registration mutation automatically. The reviewed new PIN destination is `/opt/oron-dev/shared/config/protouch-whatsapp-registration-pin.txt` (root-owned, mode0600). `--apply --create-pin --pin-file <that-path>` exclusively creates it only while fresh provider state confirms no PIN and no Business App. It cannot overwrite an existing file or follow a symlink. The generated value is flushed to durable storage before the single POST. Its presence is not authorization to run `--apply`.

The existing additional-account configuration contains no registration PIN, and the scoped registration-PIN environment variable is absent. That is separate from the authoritative provider result `is_pin_enabled=false`.

If the provider requires renewed Embedded Signup or reports a restriction, stop with its sanitized code and complete the provider-required step. Do not deregister another installation or switch accounts to make the test pass. Deregistration is a separate consequential action and is not an automatic rollback.

## Evidence and primary documentation

Local sanitized evidence: `.artifacts/poc-rescue-local/wa-remote-trace.txt`, `wa-remote-ingress.txt`, `wa-meta-subscriptions.txt`, `wa-live-test-ingress.txt`, `wa-live-boundary.txt`, `wa-registration-plan.txt`. No secret values or customer message bodies were collected in these files.

Meta's [registration reference](https://www.postman.com/meta/whatsapp-business-platform/request/zb2u18b/register-phone) documents the registration endpoint and six-digit PIN. Its [registration overview](https://www.postman.com/meta/whatsapp-business-platform/folder/zuoeksl/registration) explains that account registration and two-step verification are enabled in the same call. The [Cloud API documentation](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=request-13382743-071cfa60-0704-41d2-bca2-36ba6bd33dfe) notes the Embedded Signup registration window. These are Meta's official Postman workspace; direct developers.facebook.com retrieval returned HTTP 429 during this session.
