# ProTouch WhatsApp Business App Coexistence

The user explicitly chose to preserve ProTouch's WhatsApp Business phone app and connect it to the CRM through Coexistence. Local support is implemented behind an account-specific, default-off configuration. No provider subscription, deployment, onboarding or live import is claimed by these changes.

## Provider boundary remains open

ProTouch's number ending `4553` is active in the phone app, but its Cloud API phone ID `1284902841381185` remains `PENDING` / `NOT_APPLICABLE`. Plain `/register` returned code 100/subcode 2388001 because an existing WhatsApp account owns the number. **`is_on_biz_app=false` does not establish that the physical phone app is absent.** The earlier interpretation was incorrect; it must not justify removing the phone account.

Or-On's existing account is independently `CLOUD_API` / `CONNECTED`, with `is_on_biz_app=false`. That verifies ordinary Cloud API use, not Coexistence. ProTouch already has a separate Meta application; merely creating another app does not complete Coexistence onboarding.

Meta's authenticated [Onboarding WhatsApp Business App users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/) documentation, updated June 26, describes eligible Tech Provider/Solution Partner setup, Embedded Signup with session logging and `featureType=whatsapp_business_app_onboarding`. **Skip `/register` after this flow.** Contacts/history synchronization has a 24-hour window. An eligible third-party provider is an alternative to becoming a Tech Provider. The user does not authorize registering Or-On as a Tech Provider or deleting/disconnecting the phone app.

## Local implementation

Migration `8d32f4a91c70` adds `platform.whatsapp_coexistence_accounts`, with exact tenant/channel/WABA/phone ID/business-phone binding and `enabled=false`. Runtime roles can read bindings but cannot alter or enable them. A reviewed activation must verify the asset IDs returned by the actual Embedded Signup flow and the exchanged credential, then bind and enable only the intended account before requesting synchronization. The currently pending phone ID/WABA must not be assumed to remain the final Coexistence assets.

The existing HMAC gate runs before parsing or persistence. Both webhook endpoints now pass their configured phone ID and WABA. The database acceptance function independently matches the tuple to an active tenant and its channel. Unknown/mismatched bindings fail without a partial receipt. Supported fields are `account_update`, `history`, `smb_app_state_sync`, and `smb_message_echoes`; ordinary live-message parsing excludes these fields, including historical media callbacks under `value.messages`.

Accepted changes retain their payload and body digest in the durable inbound queue. Stable content fingerprints prevent repeated receipts; messages also use provider-ID uniqueness. History threads, contact sync, echoes and media callbacks are split into batches of at most 100 records. Phase/chunk/progress and declined-history errors remain in the receipts. The worker handles these event types through a dedicated importer, before its live-inbound path.

- Historical messages retain timestamps and inbound/outbound direction. New historical threads are closed, human-owned and unread-free. Existing thread status/ownership, consent and service windows remain unchanged. No imported message receives a live sender-verification/memory proof. No AI, opening menu, call, typing, media-download, ASR or OCR job is created.
- Phone-app sends are outbound messages from a human (`sender_type=user`, with no invented CRM user ID), carrying `whatsapp_business_app` provenance. Receipt acceptance immediately advances existing AI conversation ownership to human. Recognized Cloud API message IDs retain their original provenance and ownership. Receipt replay cannot undo a subsequent reviewed AI resume.
- Contact synchronization records app-contact state and out-of-order-safe timestamps. Removal creates an app-contact tombstone; it does not delete CRM contacts or grant WhatsApp consent. Existing CRM names are preserved.
- Media imports retain provider references and an unavailable-media placeholder, never fetch arbitrary URLs or provider media. A media follow-up can enrich only the same channel/customer's historical record. An early follow-up retries through the durable queue until its history message exists; exhausted retries remain visible through the existing failure alert path.
- `PARTNER_REMOVED` / `ACCOUNT_OFFBOARDED` revoke only the bound channel in the receipt transaction, even when importing is disabled. `ACCOUNT_RECONNECTED` is retained but never automatically re-enables sending. Other tenants/accounts remain unchanged.

Disabled receipts are retained with `importEnabled=false` and processed without importing. Enabling the capability later does not silently replay those receipts or duplicate their effects. Any recovery/import of retained disabled receipts requires a separately reviewed operation; there is no automatic bulk replay command in this change.

## Verification and remaining activation work

The dedicated real-PostgreSQL test uses fictional accounts and actual `platform_web` / `platform_messaging` roles. It exercises HMAC rejection, cross-account and unknown database-binding rejection, default-off receipts, 205-message history bursts, duplicate/out-of-order imports, media follow-ups, contact tombstones, Cloud API echo deduplication, immediate human fencing, replay after AI resume, account-only revocation and zero automation/model/provider sends. It also checks unknown consent, closed/unread-free history threads and a null service window.

Before activation, finish the authorized provider onboarding path while retaining the phone app, review exact account bindings, enable the local capability only for ProTouch, then subscribe the documented fields and synchronize within Meta's allowed window. A controlled real phone-app send and real customer inbound must prove provider-to-CRM direction, deduplication, human ownership and normal reply behavior. Local fixture success is not live Coexistence acceptance or a handset-delivery claim.
