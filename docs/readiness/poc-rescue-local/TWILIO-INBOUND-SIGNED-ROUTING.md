# Signed Programmable Voice inbound routing

Local implementation, 2026-10-05. This record does not claim a carrier cutover or an inbound call acceptance. Production remained on the earlier `60f26bf` release during these tests. Provider changes and deployment belong to the reviewed operator procedure.

## Runtime boundary

`POST /twilio/voice/inbound` is default-disabled. Only this exact path is added to Caddy's dispatcher allowlist; dispatcher controls remain private. The handler authenticates all form fields using Twilio HMAC-SHA1 against one configured, port-free HTTPS URL. It rejects unexpected query strings, untrusted host/proxy authority, malformed signatures, duplicate fields, invalid encoding, oversized forms, and unknown account/DID pairs. Signing includes future provider fields. The official Twilio published signature vector is a regression fixture.

Before releasing XML it resolves the authoritative DID to an active tenant and owned published flow, requires a real dispatch-rule identifier, and checks the current Twilio Call resource. The read must match AccountSid, CallSid, PhoneNumberSid, To, From, inbound direction and an active state. A captured completed-call callback is denied; a legitimate active-call retry produces the same routing decision. The handler neither dials nor creates sessions. Reads are bounded, fixed to the Twilio API origin, do not follow redirects and do not log identifiers or responses. XML credentials are server-only, escaped by the serializer and returned with `Cache-Control: no-store` only after these gates.

Configuration belongs only in the dispatcher's protected environment:

- `ENABLE_TWILIO_INBOUND=false` until operator activation.
- `TWILIO_INBOUND_CALLBACK_URL=https://<reviewed-origin>/twilio/voice/inbound`.
- `TWILIO_INBOUND_ROUTES_JSON`: typed route array containing `tenant_id`, `account_sid`, `auth_token`, `phone_number_sid`, `did`, `trunk_id`, `sip_host`, `sip_transport`, `auth_username`, `auth_password`.
- SIP transport is pinned to `tls`. Hosts are supplied from verified provider configuration, never derived from a WebSocket URL. Account Auth Tokens and dedicated inbound digest credentials use redacted secret types. Duplicate DIDs, trunks or digest usernames are rejected; credentials for a shared account must agree.

## Authoritative SIP admission

The prior dispatcher resolved only the DID, so a simulator marker did **not** quarantine an actual SIP participant. The new fence runs before session persistence, contact work or agent launch. The signed `sip.ruleID` must exactly match the authoritative real `SDR_…` binding. Missing/simulator/foreign rules never admit a call. Configured TwiML DIDs also require the exact tenant and signed `sip.trunkID`; canonical DID normalization is shared by resolution, authorization and context. Active and pending outbound calls are preserved. A missing rule is quarantined without deleting the room because LiveKit intentionally leaves this attribute empty for outbound legs, including after dispatcher restart.

`platform_voice` can read the active status through the existing `platform.current_tenant_active()` function. A direct Tenant-table join was rejected by real PostgreSQL during development and replaced with this existing least-privilege interface. No migration or new grant is needed. Flow ownership and transaction-local tenant context are verified separately.

## Outbound ownership and transfer behavior

The outbound dialing path, sender allowlist, existing trunk and credentials are unchanged. The provisioning helper defaults to its existing strict `trunk_associated` proof. Explicit `account_owned` mode requires a pinned PhoneNumberSid and verifies the purchased number's exact account, SID, E164 and voice capability while retaining trunk-account, termination-domain and credential-list checks. It does not reattach the DID.

The dispatcher derives a per-call `sip_refer_supported` capability from the trusted inbound binding. Normal transfer and emergency transfer check it before opening any provider client. A later flow or emergency-target change cannot silently attempt unsupported REFER on TwiML inbound. The emergency tool preserves durable escalation and existing `transfer_failed` plus urgent-followup/staff-notification outcomes, skips the misleading transfer announcement, and tells the caller the request is urgent without claiming a human answered. Existing supported transport behavior remains covered.

## Evidence

- Combined dispatcher/webhook/runtime, pickup lifecycle, transfer/intake, provisioner and deployment-contract run: **314 passed**, no failures or skips. `.artifacts/poc-rescue-local/twilio-inbound-focused.log`.
- Subsequent handler/dispatcher/real-loopback provider run: **87 passed**; the added official signature vector and handler file then passed **25/25**. Peer-owned `test_twilio_call_lookup.py` contributes 18 real loopback tests, covering fragmented HTTP, active/terminal states, every identity mismatch, redirects and bounded malformed responses.
- Fresh migrated disposable PostgreSQL under actual `platform_voice`: **4 passed** (active, disabled, foreign flow, missing flow; unknown DID and context cleanup asserted). `.artifacts/poc-rescue-local/inbound-resolution-pg-fixed.log`. The original database was not modified.
- Independent peer review: 17 ignored probes passed; findings for non-ASCII signatures, partial response reads, DID normalization and missing authoritative rules were reproduced and fixed. No open blocking finding remained.
- Pinned Caddy `2.11.4` compiled-config and actual isolated TLS proxy proof: **6 routes passed**. Exact Twilio and LiveKit callbacks reached dispatcher; callback suffix/trailing slash, dispatcher command and readiness paths reached web. Caddy preserved Host and replaced forged forwarded host/proto with the real HTTPS origin. `.artifacts/poc-rescue-local/caddy-twilio-proof/receipt.json`; reproducible helper `.artifacts/poc_inbound_caddy.py`. Only local test certificate issuance was substituted; production route matchers were used. Owned containers/network were removed.
- Scoped Ruff clean; explicit-source Pyrefly **0 errors**. Root-pattern-only Pyrefly on Windows matched no files and was not counted as evidence.

The exact dispatcher image from source `79a4a84d1df4e00bad2e7821b5673c102bba55b5` passed the offline compiled proof with Docker networking disabled. It exercised actual runtime composition, signed XML, query/replay denial, private control authentication, four negative SIP admissions before any session or launch, valid binding admission with REFER disabled, and both transfer guards making zero provider calls. Receipt: `.artifacts/poc-rescue-local/release-79a4a84d1df4e00bad2e7821b5673c102bba55b5/compiled-inbound-proof.json`.

All five images were then published under that full SHA in the existing registry. Every immutable digest was pulled back and its source revision verified. The release archive passed the 13-member allowlist validation with no credentials. Archive SHA256: `a8bc3d9e9b81386fc75469b601414b0eb671a19eaa8a654bf3f51215b2101fdd`; immutable image references and full receipts are in that release folder's `release-receipt.json`. Schema remains `9e43a5b02d81`. This was publication only; no live configuration or provider routing was changed by this implementation task.

Real provider authentication negatives, correct-digest synthetic admission quarantine, ownership/CAS readbacks and the caller's inbound acceptance remain operator gates after deployment. Rollback restores the contained baseline: zero inbound dispatch rules and the original simulator DID marker, never a deleted unauthenticated rule.

## Provider references

- [Twilio request signing and official vector](https://www.twilio.com/docs/usage/security).
- [Twilio Elastic SIP caller ID ownership and number disassociation](https://www.twilio.com/docs/sip-trunking).
- [IncomingPhoneNumber voice routing precedence](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource).
- [LiveKit Twilio TwiML inbound and REFER limitation](https://docs.livekit.io/telephony/accepting-calls/inbound-twilio/).
- [LiveKit SIP participant rule/trunk attributes](https://docs.livekit.io/reference/telephony/sip-participant/).
- [Twilio SIP TwiML digest and TLS transport](https://www.twilio.com/docs/voice/twiml/sip).
