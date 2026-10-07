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
   replacement for those live versions. Provider/model selection still follows
   deployment settings. The reviewed voice quality revision below adds a bounded
   speaking pace and pronunciation dictionary through normal agent publication.
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

## Current connection and scoped form delivery (2026-10-06)

The operator confirmed that Coexistence was completed and that the phone's
WhatsApp Business app must remain available. The new Meta account exposes phone
ID `1375531052308611` as `CONNECTED` on WABA `2492471334563786`; app
`2636656843431645` is subscribed. These IDs replace the historical IDs below in
both private web/worker settings and ProTouch's existing channel. Do not run
ordinary registration/deregistration or disconnect the mobile app.

Meta approved the operator-authorized utility template
`protouch_service_request_link_v1` (`he`, ID `2161432928062922`). Its sole BODY
parameter is the private digital service form URL. General tenant template access
and opening menus remain disabled for ProTouch; Or-On retains its own policy.

After deploying revision `e6a91c4f208b`, an operator may enable the reviewed row in
`service.whatsapp_form_template_policy`, bound to the ProTouch tenant, its active
Meta channel, the exact template identifiers and `https://dev.or-on.io` origin.
Verify the provider's approval and the channel/account binding before activation;
record an audit event. The migration enables no exceptions automatically. Disable
this row to revoke future template admission and queued delivery. Application
roles cannot edit this policy.

The voice agent collects only name and free-text fault, saves those caller-reported
facts and obtains agreement to send the form to the transport-verified caller.
Within an existing WhatsApp window the worker sends a text link; otherwise it
uses only the scoped template. Both paths use the same intake idempotency key.
The database verifies the exact caller, tenant, channel, template, form hash,
expiry and system-message provenance. Submission, not the phone call or a plain
WhatsApp reply, creates one case and linked ticket. A repeated submission returns
the existing receipt. Name, location, free-text fault and photos remain in the form.

Acceptance must cover a first-time caller with no WhatsApp conversation, a
least-privileged voice admission, worker delivery, web-role submission and summary
completion. Confirm real Meta delivery receipts, one dashboard ticket and photos,
then verify the AI answers again after the pending form is submitted. Never treat
an HTTP acceptance alone as delivered or mark the full voice path verified without
a real call. Test traffic is limited to the operator-authorized recipient.

## Direct WhatsApp service forms (2026-10-07)

The approved flow also accepts a direct WhatsApp service enquiry. Publish the
revised WhatsApp agent prompt and its WhatsApp process binding after deploying
`f2c7a9d41860`. Keep the separately reviewed voice v4 binding unchanged.
The `service_form` decision is offered only with `service.intake` and the enabled
form-mode field-service policy. An owned job and a verified inbound sender are
required; the model cannot choose a recipient or provide the URL. Issuance,
outbound admission and the intake receipt commit together. Delivery rechecks
ownership, consent, tenant/channel authority, the exact form hash and expiry.
A newer message cannot discard an already committed form as a stale prose reply.

No case is created on greeting, a promise, a link request or a plain WhatsApp
confirmation. The customer submits the existing digital form to create one
WhatsApp-sourced case and linked ticket. Duplicate submission returns the same
reference. General ProTouch templates remain disabled.

Service managers have Inbox and Voice in their navigation. Overview exposes
pending human requests and pending forms independently of submitted tickets.
A human-owned conversation must be handled by staff or explicitly returned to
AI; publishing an agent must not silently take it over. Inspect actual message
and delivery evidence before replaying a historical request, and obtain explicit
authorization before sending recovery messages to real customers.

Acceptance uses signed fictional inbound events, the canonical machine principal,
a recording fake provider, web-role submission, duplicate submits, delivery races
and revocation during inference. Real customer acceptance must be reported
separately from these provider-free checks.

## Voice consent revision v4 prepared on 2026-10-07

The latest reviewed v3 call asked permission again after the caller had already
agreed. Pipecat had committed the caller text and started early inference before
its asynchronous `on_user_turn_stopped` callback advanced the consent fence.
The tool therefore rejected a real affirmative as stale. Re-entering the consent
node then replayed its spoken question.

For form-mode intake, `ServiceIntakeContext` now observes non-speculative caller
context after the ownership gate and before inference. System evidence refreshes
and tool re-entry do not manufacture a caller answer. The delayed turn-stop
callback cannot overwrite that committed text. Consent is asked once; retries
preserve its fence. Both saved facts and a fresh explicit affirmative are still
required, and queued delivery still does not open a ticket.

The form-mode turn planner also holds short model responses until tool intent is
known, discarding even complete acknowledgements preceding a silent tool call.
Other voice agents retain normal streaming. The closing gives only the short
form-submission instruction and goodbye. Consent uses the Latin brand WhatsApp;
the previous pointed Hebrew brand replacement was removed. Pace remains 1.06.

Publish the reviewed agent quality and retained `protouch.voice.json` v4 together
through the normal review path, then update only inbound/outbound voice bindings.
Keep existing WhatsApp pins and Or-On bindings. Regression coverage includes early
committed answers, delayed callbacks, speculative text, context replay, ordinary
streaming and complete tool preambles. Six controlled fake-customer scenarios
passed against the existing model. Synthesis measured consent at 2.39 seconds
versus 4.27 seconds for the preceding wording, and the closing at 4.78 seconds.
These are phrase durations, not end-to-end call latency or human listening
acceptance; confirm pronunciation on the next authorized real call.

## Voice quality revision v3 prepared on 2026-10-07

The preceding `protouch.voice.json` was the retained v3 composition published
alongside the voice quality in `protouch.agent.json`. Both are reviewed source
files, not automatic live configuration. Publish a new immutable agent version,
then bind the approved inbound/outbound voice processes to its canonical voice
flow and retained script v3. Preserve unrelated configuration and the existing
WhatsApp process/conversation pins; this is a voice revision.

The previous three inbound calls exposed partial recognition saved as facts,
negative screen symptoms mistaken for refusal, spoken gender slash forms, and
long consent/closing explanations. The form runtime now requires a fresh explicit
consent answer, asks its own short neutral question after durable capture, and
ends through a guarded finish tool. The v3 composition has no unconditional
`support_done` route. Hesitation alone cannot become a fault or name. Actual
delivery and case creation still require their original receipts.

The pronunciation dictionary preserves the underlying Hebrew words and sets
pace to 1.06. Controlled evaluation with the existing model passed separate
facts, partial recognition followed by a negative symptom, combined facts, and
explicit refusal. Soniox synthesis measured the new consent line at 4.27 seconds
versus 10.84 seconds for the old wording with its slash replaced by a spoken
conjunction. This is a phrase-duration comparison, not a claim about end-to-end
call latency or human listening acceptance. Local voice/flow/dispatcher tests
passed (1,327); default provider evaluations remain opt-in.

One reviewed first-time caller's template was admitted but failed worker
eligibility because the new WhatsApp identity was `unverified`. The worker's
load and pre-send checks now permit that state only for the narrowly authorized
phone-origin form template with general template access disabled. They recheck
the transport-bound recipient, consent and exact unexpired form token, and
leave the identity unverified. Invalid/revoked identities and ordinary unverified
template recipients remain blocked. The worker integration fixture now starts
with an unverified phone identity, as real first-time inbound callers do.

Form language follows the latest received customer preference, using inbound
receipt order rather than provider timestamps or random message IDs. The worker
and form integration checks passed (19), including a delayed English request,
Hebrew defaults, first-caller delivery and rejected recipient/template changes.

After deployment, verify the exact agent/script binding through the production
resolver, then check the next real authorized call, delivery receipts and form
submission. Do not repin an active call or replay a failed message to an
unapproved customer as a test.

## Historical dev activation status (2026-09-30)

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
