# ProTouch WhatsApp Business App coexistence gap

The user confirmed that ProTouch's number ending `4553` is active in the WhatsApp Business phone app. The CRM's phone ID is `1284902841381185` in WABA `992519473248296`. Meta reads show `VERIFIED`, `PENDING`, `NOT_APPLICABLE`, `is_pin_enabled=false`, `is_on_biz_app=false`, and no last-onboarded timestamp. **`is_on_biz_app=false` does not prove the phone app is absent**; it must not justify account deletion. The plain registration attempts were rejected with code 100/subcode 2388001 because an existing WhatsApp account owns the number.

The parent read Meta's authenticated [Onboarding WhatsApp Business App users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/) documentation, updated June 26. It describes the Coexistence route: eligible Tech Provider/Solution Partner setup, Embedded Signup with session logging and `featureType=whatsapp_business_app_onboarding`. After this flow, **skip `/register`**. Contacts/history synchronization has a 24-hour window, and the integration must handle `account_update`, `history`, `smb_app_state_sync`, and `smb_message_echoes`. Provider eligibility and the user's current onboarding state are separate from application-code readiness.

## Current code boundary

- `packages/ts/crm/src/webhook.ts` parses `value.messages` and `value.statuses`, without a dispatch contract for those four Coexistence event families.
- `webhook-store.ts` persists only parsed inbound/status envelopes. A validly signed shape with neither recognized array returns zero accepted events; there is no durable unknown-Coexistence receipt to process later.
- No Embedded Signup/session-logging implementation, durable history/contact sync, phone-app outbound echo reconciliation, or explicit business-sender provenance was found in the reviewed application, worker and configuration code.
- Existing provider-message deduplication for customer ingress does not prove cross-device outbound echo deduplication. Historical imports must not be mistaken for fresh customer turns and trigger AI, follow-up calls, or another physical send.
- Ordinary Cloud API customer-message support and the menu integration tests do not verify complete Coexistence.

## Required implementation and verification before activation

Confirm provider eligibility and the authorized onboarding flow while preserving the phone app. Then define tenant/account-bound durable receipt types and validation for the additional events, outbound direction/actor classification, deduplication and synchronization cursors, bounded import/retry behavior and no-model/no-send handling of imported history. Verify duplicate/out-of-order delivery, restart/recovery, signed cross-account rejection, app-sent echoes, concurrent app/CRM activity and reconciliation of actual customer turns. Keep this behind an explicit tenant capability and observe its canary before expanding.

This document records a gap and a concrete next implementation boundary. It does not authorize deletion, deregistration, another plain registration request or live feature activation, and no new Coexistence feature was implemented during this audit.
