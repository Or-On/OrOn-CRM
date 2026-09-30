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
2. In **Agents & Flows**, create a profile using the `agent` object from
   `protouch.agent.json`: Hebrew locale, Voice and WhatsApp channels, and only
   `service.intake` and `ticket.open` permissions. Review and publish the
   resulting version in this tenant. Check its default WhatsApp assignment
   explicitly; publishing the first eligible profile can set the default.
3. For voice, create and publish a ProTouch retained voice flow, then a
   connected flow pinned to the published agent version and exact retained
   voice-flow version. Copy the _reviewed settings_ of the Or-On voice flow
   where appropriate. Tenant isolation prevents pointing at Or-On's flow IDs.
   The draft sets no LLM, STT, or TTS override, so deployment runtime values
   remain the source of provider configuration.
4. Review the actual ProTouch DID, LiveKit inbound/outbound trunk and dispatch
   bindings before enabling real calls. The caller ID, SIP domain, and username
   in the draft are references only; they do not provision a trunk, associate
   a DID, or authenticate a SIP connection. Keep the Twilio account SID and
   credentials solely in the deployment secret manager.
5. Bind the Meta phone-number ID to the ProTouch WhatsApp channel after
   checking that no other tenant owns it. The business ID, WABA ID, display
   name, and Graph version are references only. The current web and messaging
   worker use shared `WHATSAPP_*` environment values, so do not replace those
   values with ProTouch's IDs or credentials while Or-On uses the deployment.
   A tenant-aware credential and sender routing path must be reviewed before
   both tenants can use distinct real WhatsApp accounts on one deployment.

The Meta access token and app secret are still unavailable. Do not activate
the ProTouch WhatsApp channel until they are supplied through the secret
manager, the display name is approved, and a tenant-scoped webhook and
outbound sender are verified. Do not activate its real telephony path until
tenant bindings and inbound/outbound tests pass. Leave the shared deployment
provider settings and kill switches as they are for Or-On.

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
