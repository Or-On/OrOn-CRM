# ProTouch agent setup

`infra/tenant-configurations/protouch.agent.json` is the reviewed draft for
ProTouch. The repository does not load this file automatically. It contains the
agent's Hebrew service-intake behavior and public provider identifiers, with
both real channels disabled. Keep all provider credentials in the deployment
secret manager, never in this file or an agent prompt.

## Apply to the ProTouch tenant

1. Sign in to the **ProTouch** tenant and confirm its tenant ID and slug. Check
   that Contacts, Agents & Flows, Tickets, Field Service, WhatsApp, and Voice
   are enabled. Review its existing field-service configuration before changing
   it; the separate `protouch.field-operations.json` is also a draft example.
2. The ProTouch tenant on dev already has a published Hebrew service-intake
   agent assigned as the default WhatsApp agent and a published telephone
   intake flow (verified in the tenant admin session on 2026-09-30). Preserve
   them. Use `protouch.agent.json` only as an offline reference, never as a
   replacement for those live versions. The agent has no per-tenant LLM, STT,
   or TTS override, so deployment runtime values remain authoritative.
3. Review the actual ProTouch DID, LiveKit inbound/outbound trunk and dispatch
   bindings before enabling real calls. The caller ID, SIP domain, and username
   in the draft are references only; they do not provision a trunk, associate
   a DID, or authenticate a SIP connection. Keep the Twilio account SID and
   credentials solely in the deployment secret manager.
4. Keep the existing primary `WHATSAPP_*` settings for Or-On. The web and worker
   support a separate `WHATSAPP_ADDITIONAL_ACCOUNTS_JSON` private runtime
   value containing an array of accounts with `key`, `phoneNumberId`,
   `wabaId`, `graphApiVersion`, `accessToken`, `appSecret`, and
   `webhookVerifyToken`. Use `key: "protouch"`, the supplied ProTouch Meta
   identifiers and credentials, and the tenant-specific verify token.
   The dev deployment uses root-owned host-mounted service environment files
   under `/opt/oron-dev/shared/config`; follow `docs/deployment/dev-gcp.md`
   for rendering and deploying private configuration. Never print the JSON in
   command output or put it in Git. Put the same value in the web and
   messaging-worker environments, recreate both containers, then confirm the
   new route is reachable before asking the ProTouch Meta administrator to
   register it.
5. The ProTouch Meta administrator should register callback
   `https://dev.or-on.io/api/webhooks/whatsapp/protouch`, use the tenant-specific
   verify token, and subscribe to WhatsApp message events. The app secret is
   used by our server to verify signatures; it is not the verify token. Only
   send these instructions once the new route and private runtime configuration
   are deployed. Separately subscribe the app to the ProTouch WABA through
   Meta's `/{waba-id}/subscribed_apps` edge; selecting the `messages` field in
   the app dashboard does not create the WABA subscription. The callback
   validates the account's phone-number ID as well as its app signature.
6. Bind the ProTouch phone-number ID to a `messaging.channels` row belonging to
   the ProTouch tenant, after checking the unique provider/account binding is
   unclaimed. The row must be `kind='whatsapp'`, `provider='meta'`,
   `status='active'`, and its configuration must contain the same
   `phoneNumberId`, `wabaId`, and `graphApiVersion`. Enable inbound media
   mirroring for customer photos. Check this binding and runtime config
   together; the account-specific webhook alone does not create a channel.

## Dev activation status (2026-09-30)

The ProTouch Meta account is installed in the root-owned web and
messaging-worker runtime files. The app named **Pro Touch Agent** is subscribed
to the ProTouch WABA, and its `whatsapp_business_account` webhook uses the
ProTouch callback with the `messages` field subscribed. Meta recognizes phone
number ID `1284902841381185`; the access token has both WhatsApp management
and messaging permissions. The callback passed verify-token challenge and
signed POST checks; invalid tokens and signatures were rejected. The active
ProTouch tenant owns one Meta channel for that phone number, with inbound media
mirroring enabled, and the published WhatsApp agent is assigned. The channel
was activated with an audit record after the operator explicitly chose to go
live without a controlled inbound test. Or-On's primary provider settings were
left intact.

No live customer message or outbound reply has been verified yet. Arrange a
controlled inbound text and photo from an approved number, confirm they appear
under ProTouch with the right service-intake behavior, then verify an outbound
reply and handoff. The phone name status reported by Meta is
`AVAILABLE_WITHOUT_REVIEW`; this is not an end-to-end delivery test. Do not
activate real telephony until its tenant bindings and inbound/outbound tests
pass.

## Local verification

With local PostgreSQL running, the `protouch` mode in the ignored local
verification runner creates a disposable database, runs migrations, creates
fictional tenants, publishes the profile through the normal CRM path, checks
tenant isolation, and deletes the database afterward. It makes no Meta,
Twilio, or LiveKit requests. The standalone manifest test checks the draft's
identity, permissions, non-secret references, and disabled activation flags.

After the live bindings are available, verify a synthetic inbound WhatsApp
message and a test call from approved numbers. Confirm ProTouch identity,
service-intake behavior, photo association, and handoff, and confirm that
Or-On traffic is unaffected. Record the actual published agent and flow
version IDs in the deployment change record.
