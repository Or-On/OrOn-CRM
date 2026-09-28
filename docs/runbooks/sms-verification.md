# Customer phone identification and SMS verification

This is a reusable platform capability. It does not change tenant entitlements,
ProTouch's presentation, staff roles, or existing password sign-in for accounts
that have not enrolled. Real SMS sending defaults off.

## Customer calls

Caller identification uses the canonical, tenant-scoped phone/WhatsApp identities
and the existing server-pinned call/contact binding. A matching caller number is
an association, not proof of identity. Conflicting matches do not select a customer.

In Settings → Support, enable **Require SMS verification during customer calls**
(`identityVerification.smsOtp: true`). This setting applies to normal calls and
WhatsApp-to-voice continuations. The agent requests consent, invokes
`send_caller_sms` without a destination argument, and collects the six-digit code.
Only the stored identity pinned from the transport can receive the SMS; neither
caller speech nor model output can redirect it. New transport-created identities
can prove possession; invalid/revoked identities cannot.

Normal calls unlock their customer context after successful SMS verification.
Continuations additionally retain all configured identity factors. The database
prevents the previous factor verifier from unlocking a call before SMS succeeds.
Unknown/ambiguous callers, missing numbers, unavailable delivery, exhausted checks
and declined verification keep customer information locked and require human
follow-up (or the configured end-call policy). A successful check applies only to
the exact tenant, call and contact. It does not globally mark a person verified.

## Staff sign-in

Every authenticated staff role, including technicians, can open **SMS sign-in
verification** from the account menu (`/account/security`). Enrollment requires
the current password and a code sent to the proposed international-format number.
One verified number belongs to one platform account. Enrolling revokes that
account's other existing sessions; the enrolling session remains usable.

Subsequent sign-ins require email/password, then the SMS code. No session cookie
is issued before both steps succeed. Tenant membership, lockout, application scope,
session expiry, CSRF and session rotation continue through the existing auth service.
Disabling verification requires the current password plus a code sent to the
currently enrolled number. To replace a number, disable using the old number first,
then enroll the new number. Shared technician accounts should enroll only when
their staff can access that account's chosen verification phone.

If a user loses that phone, an administrator must verify their identity through
the organization's recovery process before a reviewed, audited credential reset.
There is deliberately no password-only recovery or disable endpoint.

## Provider configuration

The initial delivery adapter uses the
[Twilio Messages API](https://www.twilio.com/docs/messaging/api/message-resource).
`SmsSender` is a provider port, so another carrier can be supplied without changing
the database verification rules. Codes are generated and checked by the platform;
Twilio Verify is not required.

Configure these secrets in both the web and dispatcher runtimes:

```dotenv
ENABLE_REAL_SMS=false
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
SMS_FROM_NUMBER=
SMS_OTP_PEPPER=
```

Use an SMS-enabled Twilio sender in international format and an independent,
random HMAC key of at least 32 characters. Keep the same OTP key across both
runtimes. The key is distinct from staff-session and customer blind-index keys.
Only enable `ENABLE_REAL_SMS=true` after the carrier is configured and a deliberate
provider test is authorized. Voice/WhatsApp flags do not enable SMS. An enrolled
staff account cannot fall back to password-only login when SMS is unavailable.

Codes expire after five minutes; OTP challenge tables store only challenge-bound HMAC digests,
and cannot be replayed. Challenges are purpose-bound; enrollment and disabling
also bind the authenticated staff session. Staff proofs are invalidated when the
password changes or the account is locked/disabled. Calls bind the pinned identity
again at verification and refuse ended calls or revoked identities.

The database serializes requests, enforces a 60-second destination cooldown and
five sends per destination/account per rolling hour, supersedes earlier challenges
for the same purpose, and limits checks to five (customer checks also honor the
call's configured attempt cap). Delivery is not automatically retried. Codes,
full destinations and provider bodies must not appear in diagnostic logs or audit
metadata. Carrier acceptance means queued delivery, not a delivery receipt.

Customer calls retain the platform's existing audio recording and transcript policy.
A caller's spoken code can therefore appear in those private call artifacts and,
if enabled, speech tracing. Apply the same restricted access and retention controls
as other identity information; SMS verification does not redact existing call artifacts.

Private staff credentials/challenges have forced RLS and no runtime table grants.
Web and voice runtimes can execute only their respective bound functions. Verification
audits contain purpose and result, not codes. Challenge rows contain destinations
and digests: treat them as private authentication data and include them in the
deployment's retention and access-control policy.

## Local validation

Use a disposable localhost PostgreSQL database upgraded with Alembic. Run
`db/tests/postgres/test_sms_verification.py` and the existing handoff gate tests
with `TEST_DATABASE_URL`; run auth `sms.postgres.test.ts` with
`AUTH_TEST_DATABASE_URL` pointing to an owned `oron_ui_preview_<32 hex>` database.
The TypeScript journey uses an injected fictional sender. Provider adapter tests
mock HTTP; no ordinary test invokes Twilio or sends real SMS.
