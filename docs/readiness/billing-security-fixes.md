# Billing event binding and invitation recovery

Date: 2026-09-12. Implemented only in the isolated readiness candidate while the
user's development runner remains active. No real Stripe request, charge,
message, telephone call, webhook subscription, cloud access or user-data mutation.

## Implemented controls

- Generated Alembic successor **74e4f347dbbd**, parent **6d9561f45598**. No imported
  or existing historical revision changed. Manifest head/table/function inventory
  updated. `billing.topups.expected_customer_id` binds each new intent to its
  Stripe customer; CRM admission/idempotency is maintained by the application
  audit implementation in the same candidate.
- Webhook accepts only structurally valid, exactly signed raw UTF-8 bytes, bounded
  to 256 KiB regardless of Content-Length. Timestamp must be one finite positive
  integer within five minutes; multiple v1 signatures support key rotation.
  Malformed body/schema/signature => fixed 400; oversized body => 413; disabled or
  transient DB/provider failure => fixed 503; unexpected expected record => 409.
  Neither provider bodies nor raw DB errors are emitted/logged.
- Paid checkout requires `mode=payment`, tenant UUID, topup UUID, expected customer,
  provider session ID, integer minor amount and currency. Atomic locked database
  matching credits wallet, records ledger and audit exactly once. Delayed unpaid
  checkout completion does not credit; paid `checkout.session.async_payment_succeeded`
  uses the same tuple and idempotent primitive.
- New forced-RLS `billing.payment_setup_requests` stores tenant, requesting actor,
  expected customer, idempotency key, session ID and terminal SetupIntent. Setup
  requests exist before external checkout, and session binding commits before
  URL release. Principal is freshly resolved and matched after external waits.
- Setup webhook requires `mode=setup` + purpose + request ID. Expected stored
  tenant/request/session/customer is checked before external retrieval; retrieved
  SetupIntent must be succeeded with matching ID/customer and a card owned by that
  same customer. Safe card metadata is validated again in PostgreSQL. No provider
  HTTP occurs inside a PostgreSQL transaction.
- Profile row locking serializes setup completion. Duplicate delivery is a no-op;
  an older setup cannot overwrite a more recently requested successful card.
- Runtime web role cannot directly change wallet funds, ledger entries, topup
  amount/status or call legacy unbound financial functions. Permitted wallet
  initialization/no-op currency upsert and pending checkout admission retain
  column-scoped privileges. Provider verification remains the webhook service's
  trusted responsibility; DB matching alone is not proof of a real payment.
- Invitation acceptance survives subsequent auto-login, cookie-write or repository
  teardown failure: old session cookies are cleared and result says accepted but
  not signed in. Existing form sends user to normal sign-in. Account/password
  created by committed acceptance remain valid; no repeat invitation needed.
- Shared authenticated `jsonObject` now enforces the existing **16 KiB actual
  byte** limit for chunked/missing/lying Content-Length, rejects malformed UTF-8
  and non-object JSON, and returns fixed parse errors without private body text.
  Valid boundary-sized content and Hebrew text remain accepted.

## Recovery and compatibility

Historic topups have NULL expected customer intentionally: there is no trustworthy
offline inference for a formerly created Stripe session. Already credited history
is retained; **old pending checkout/setup events fail closed**. Before enabling
billing, review every pending old checkout against Stripe in a separately
authorized reconciliation; do not guess customers, replay charges or patch money
balances to force success. Setup begun before this release should be recreated
with a new reviewed request (card setup has no charge).

If provider checkout succeeds but local attach fails, repeat the identical request
within Stripe's idempotency retention to obtain/bind the same session. A changed
session is not silently substituted after provider key expiry: investigate and
reconcile, because multiple payable sessions can otherwise credit incorrectly.

Downgrade is supported only **before any bound topup or setup request exists**.
It locks affected tables, refuses if recovery data exists, and otherwise restores
the exact predecessor API grants/schema. Existing empty-database head-to-Or-on-
head downgrade/reupgrade test stays unchanged and passes. Populated rollback uses
reviewed compatible images or backup restore to a new database; never erase live
financial evidence for a schema rollback. Migration/application images must ship
together: old webhook images cannot invoke the revoked weak primitives.

## Evidence

| Gate | Observed result |
| --- | --- |
| Stripe helper + webhook route + setup admission + invitation + shared JSON tests | **59 passed**, all provider HTTP mocked |
| `test_billing_event_binding.py` + existing `test_migration_history.py` | **22 passed**, actual disposable PostgreSQL on isolated localhost:55439 |
| PostgreSQL proof | Wrong tenant/topup/customer/session/amount/currency refused; one credit under 4 concurrent duplicates; mixed 4 concurrent card events select latest request; safe metadata, cross-tenant/no-context RLS; legacy execute/fund updates denied; populated downgrade fails without losing ledger |
| Existing migration downgrade gate | Fresh head → a41d2f6c2925 → head passed, unchanged assertion |
| Web typecheck | Passed; local tool reports Node25 host vs repository Node24 requirement. Linux release-image build remains authoritative |
| Ruff migration + PG tests | Passed |
| Affected ESLint/format | Passed; no real provider validation inferred |

## Residual limits and release gates

Real billing must remain disabled until authorized Stripe test-mode checkout,
signature delivery, setup/customer ownership, refund/accounting reconciliation and
deployment secret configuration are exercised. Mocks prove boundary behavior,
not real Stripe account connectivity. Historic pending records require explicit
review; no automated online reconciler or refund workflow was added.

Existing-account invitation login still chooses its ordinary membership default;
an invitation-specific tenant destination is a separate UX/auth follow-up. No new
MFA, account recovery, email verification, or email invitation delivery provider was
invented. Clearing old browser cookies does not revoke unrelated sessions on other
devices. These remaining authentication controls limit public production readiness.

Stripe behavior referenced from [official webhook guidance](https://docs.stripe.com/webhooks)
and [SetupIntent success guidance](https://support.stripe.com/questions/confirm-success-of-a-setupintent).

## Follow-up concurrency review and final head

Independent review found a remaining transaction gap between fresh session
resolution and the protected write, plus concurrent first-created OAuth
credentials. Generated successor **bfb741c767fd** after **74e4f347dbbd** adds narrow
`platform.lock_current_authorization(uuid,text,boolean,integer)`. Final manifest
head is **bfb741c767fd**, with **57 revisions** including unchanged Or-on history.

`withFreshCurrentTenant` now revalidates inside its actual write transaction and
holds shared row locks in order **tenant → user → membership → auth session**.
This aligns tenant deletion's tenant-first order; membership removal and session
revocation wait for already-authorized writes. A revocation/deletion that wins
first denies the new write. It checks tenant/account active state, current role,
superuser state, exact session/tenant/user, rotation count and expiry after any
lock wait. Only `platform_web` can execute; explicit `pg_catalog` search_path.
It does not hold a database transaction open across provider HTTP. This change
applies to the fresh OAuth/billing boundary, not a claim that every pre-existing
cached app handler now uses the locking protocol.

OAuth credential save takes a transaction advisory lock on tenant + provider +
credential kind + mailbox-derived identity before update/insert. Concurrent first
saves for one account no longer create competing encrypted rows. Distinct
mailboxes retain distinct records. Historic duplicate/orphan secrets are not
deleted automatically; encrypted legacy records remain for explicit review.
Key-version validation is fail-closed, but key rotation and adding tenant-bound AAD
to old encrypted envelopes remain separate controlled migration work.

Follow-up verification: **32 PostgreSQL tests passed** across fresh authorization,
billing event binding and original migration history; actual `pg_stat_activity`
lock waits prove role change, tenant suspension and revocation cannot overtake
the protected transaction. New mocked helper tests prove denied authorization
never invokes mutation; combined bounded application suites **62 passed**.
OAuth credential concurrency test used actual isolated PostgreSQL and six
simultaneous saves: five same-mailbox operations yielded one record and the sixth
mailbox a distinct record. Combined with existing OAuth state tests: **8 passed**.
Graph/static verification: **7 passed**, root `0001`, existing branchpoint
`8eda5976c920`, one final head `bfb741c767fd`. No cloud/provider call occurred.
