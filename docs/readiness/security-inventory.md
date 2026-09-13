# Identity, tenancy, OAuth, and billing readiness inventory

Audit date: 2026-09-12. This is a **read-only source review** of the existing
dirty worktree for the production/staging assignment. No database, provider,
payment, message, cloud, or Git mutation was performed by this audit. Findings
are not claims of a reproduced exploit or a passed runtime test. The main
readiness evidence register must record subsequent fixes and executions.

## Source and effective-policy basis

Reviewed the complete production/staging assignment, `MASTER_PROMPT.md`, root
and relevant scoped instructions, current progress entries, the auth package,
BFF authentication helpers, API route inventory, CRM API-key and billing
repositories, OAuth credential/flow implementation, and effective Alembic
function definitions. Current source includes the recently added tenant
deletion revision `eb2660eb37ec`; this audit does not rewrite historical
migrations. Existing PostgreSQL/route tests were inspected, not executed here.

## Findings requiring action

| ID | Severity / status | Evidence and impact | Required verification / remediation |
| --- | --- | --- | --- |
| SEC-001 | **High / failed** | `db/alembic/versions/b56eb0a0aca1_add_scoped_public_api_keys.py:67`, `packages/ts/crm/src/api-keys.ts:122`, and `apps/web/src/app/api/v1/contacts/route.ts` resolve active API keys without requiring an active tenant. `eb2660eb37ec_add_guarded_tenant_deletion.py` revokes sessions/channels/invitations/work, but does not revoke API keys. Contact RLS in `a929e3f55c7a_add_canonical_crm_foundation.py` compares tenant context, not active-tenant status. Consequently an existing key can still resolve a deleted tenant and access retained contacts through the public API. No successor override of `resolve_api_key` was found. | Add successor database guards for active tenants and revoke keys during deletion; fail closed for previously deleted tenants too. Test active/suspended/deleted tenant keys, revocation, retained data not exposed, read/write scopes, and concurrent deletion in isolated PostgreSQL. |
| SEC-002 | **High / failed** | `apps/web/src/app/api/email/oauth/[provider]/start/route.ts` stores only `{state,verifier}` in the pending cookie. Callback looks up the **current** tenant's credentials and writes into the **current** tenant. There is no initiating tenant/user/session binding. Switching tenant or signing in as another user while authorization is open can bind a mailbox to the wrong workspace when those workspaces share an OAuth client registration. | Persist a single-use, expiring, integrity-protected pending authorization bound to initiating tenant, user, session and exact callback. Reject changed identity before external exchange and again before persistence. Test cross-tenant switch, account switch, replay/concurrent callback, expiry, denial, malformed state and no provider traffic on refusal. |
| SEC-003 | **High for enabled billing / failed** | Stripe callback in `apps/web/src/app/api/webhooks/stripe/route.ts` matches paid session ID/tenant/amount/currency but does not check session mode, expected Stripe customer, or `metadata.topup_id`. `billing.complete_stripe_topup` in `f8be561f06de_add_ai_oauth_tenant_and_campaign_.py:244` has no customer/expected-transaction argument. Payment-source setup retrieves a payment method without checking SetupIntent status/customer against the expected setup transaction. | Match verified event to durable expected checkout/setup records, customer, tenant, mode, currency, amount and transaction ID. Restrict wallet/ledger writes to narrow monetary functions. Add isolated concurrent credit/replay/mismatch tests, verified setup-customer checks and failure/recovery tests. Leave real billing disabled until verified. |
| SEC-004 | **Medium / failed** | `packages/ts/crm/src/billing.ts:createCampaignTopup` handles `(tenant_id,idempotency_key)` conflicts by returning the old row without comparing amount/currency/actor. The API then sends the **new request amount** to Stripe using the old top-up identifier. Retry after partial failure or changed input is not a stable replay contract. | Reject key reuse with different canonical input before calling Stripe. Return/recover the same valid checkout for identical retries. Verify provider acceptance followed by DB failure, concurrent requests and persisted checkout reconciliation using fakes. |
| SEC-005 | **Medium / failed** | `features/finance/stripe-server.ts:verifyStripeSignature` converts timestamp with `Number` but does not reject non-finite values. Stripe webhook reads unlimited `request.text()`, calls `JSON.parse` outside its error boundary, and casts nested values without shape validation. `features/auth/request.ts:jsonObject` checks only declared Content-Length before buffering; missing/lying lengths bypass the application limit. | Implement actual streamed byte limits and strict webhook schema/timestamp validation; return safe deterministic errors. Test oversized/chunked bodies, signed malformed JSON, malformed metadata, non-finite timestamps and provider/DB failure. Signature verification is present; this is not a claim that invalid signatures currently pass. |
| SEC-006 | **Medium / failed** | Invitation acceptance in `apps/web/src/app/api/auth/invitations/accept/route.ts` commits acceptance, then separately logs in the new account. If login/session creation fails, the invitation is already consumed and the prior browser session cookie remains. Existing-account acceptance clears browser cookies but does not revoke the previous server session and login chooses the first membership, not necessarily the invited tenant. Current mocked tests cover only two successful transitions. | Implement recoverable post-accept login behavior without accidental old-user continuation; retain an invitation-tenant destination for authenticated existing users. Test session replacement and failures with real PostgreSQL/cookies, acceptance/revocation races, existing account, disabled account and accepted-link reload. |
| SEC-007 | **Medium / blocked for production** | Account email change (`api/account/profile`, `platform.update_current_user_profile`) requires current password but changes the login identity immediately without verifying the new address. No MFA/WebAuthn, self-service recovery, per-session user management or authenticated invitation email delivery implementation was found in this bounded inventory. Login has credential lockout/dummy hashing, but no centralized unauthenticated request-rate limit was found; password-change verification likewise has no bounded failed-attempt surface. | Record these as distinct production controls, not silently implemented features. Add bounded safe existing-flow improvements; obtain product/security decisions for MFA/recovery/delivery rather than inventing trust channels. Private restricted staging can be evaluated separately. |
| SEC-008 | **Medium / failed** | OAuth credential persistence keys token records only by tenant + provider and updates the newest token in place (`features/email/oauth-server.ts`). Connecting a second mailbox for the same provider can overwrite the credential record already referenced by the first channel. `key_version='env:v1'` is written but read ignores key version; key rotation has no recovery path. Cookies are created with provider-specific paths but deleted without an explicit matching path. | Define one mailbox/provider or account-specific credentials explicitly, use AAD binding to tenant/credential kind, version-aware key lookup/rotation, and exact-path cookie cleanup. Test replacement versus independent accounts and missing/rotated keys. Never expose decrypted values. |
| SEC-009 | **Medium / blocked** | OAuth callback marks email channel `active` after obtaining tokens, but no mailbox sync worker, mail-send API, token refresh or disconnect endpoint was found. UI copy both offers actual OAuth connection and says sign-in remains off until sync is configured. Requested Gmail scopes include modify/send despite no implemented mail actions. | Clearly separate authorization connected from mailbox operational state; avoid claiming a working email client. Implement narrow disconnect/revocation as an existing-flow improvement or document its blocker; keep mailbox sync/send as separately scoped implementation and minimize scopes to demonstrated needs. |
| SEC-010 | **Medium / blocked** | Current threat model still has Phase-1 assertions such as no WhatsApp send adapter, no upload path, and no encrypted credential persistence, despite current implementations. It also contains an expired 2026-09-09 dependency exception review date. | Reconcile the threat model against current boundaries and current dependency scan evidence. Do not carry expired exceptions into a production-ready decision. |

## Defense already present (source-confirmed, not newly runtime-verified)

- Passwords use Argon2id; opaque session/CSRF tokens are random and stored as
  peppered HMAC digests. Login performs dummy-hash verification for unknown
  accounts and returns generic credentials errors.
- `platform.auth_resolve_session` (effective qualified implementation in
  `5725968b8ae1_qualify_session_membership_role.py`) checks active user/tenant,
  current membership or database super-administrator, session idle/absolute
  expiry, and revocation. Tenant switch rotates session and CSRF tokens.
- `withCurrentTenant` resolves authenticated current membership, checks the
  canonical permission matrix, and sets transaction-local tenant/user/role.
  Its per-render React cache is not a process-global tenant cache.
- Mutating CRM BFF routes use authenticated CSRF plus origin/Fetch-Metadata
  controls. Platform tenant listing/creation/deletion has a separate server
  super-administrator check and database-side actor validation.
- API keys are generated with cryptographic randomness, stored as peppered
  digests, have read/write scopes and explicit expiry/revocation fields. Raw
  keys are returned only at creation; SEC-001 is an active-tenant lifecycle gap.
- Owner/admin/agent/viewer permissions are centralized. Admin cannot grant or
  manage owner membership; owner removal/self-removal protections exist.
  **Do not misclassify the unlocked count inside `manage_current_tenant_member`
  as proof of a last-owner bypass:** the earlier `protect_last_tenant_owner`
  trigger in `3efa5431c380` locks owner rows. Concurrent owner demotion can
  still need deadlock/retry testing, but a trigger provides actual defense.
- Invitation database acceptance locks the invitation row and marks acceptance
  atomically with membership creation and audit. Subsequent acceptance is
  rejected. Invitation secrets are hashed. Revocation is restricted by a
  tenant-scoped management helper, not direct invitation-table access.
- Tenant deletion is retained-data soft deletion with audit, active-work
  refusal, queued-work cancellation, active-session revocation, and protection
  for current/final active tenant. It is not a privacy data-erasure feature.
- OAuth has PKCE S256, random state, HTTPS provider endpoints, HTTP-only
  cookie, timeouts and AES-256-GCM encryption before PostgreSQL writes.
  These controls do not substitute for SEC-002 identity binding.
- Stripe requests use hosted Checkout and provider idempotency keys; raw card
  data does not pass through Or-On. Webhook HMAC uses raw text and constant-time
  digest comparison; completed top-up locking and ledger-reference uniqueness
  provide a real replay defense. No credit is granted by redirect query flags.

## Feature/action inventory for integration into the master matrix

All entries below are **unreviewed-runtime** unless linked to a subsequently
executed readiness result; existing tests are coverage leads, not new evidence.

| Entry / actions | Role boundary and data | Implementation / coverage leads | Current limitations |
| --- | --- | --- | --- |
| `/login`, `/api/auth/login`; sign in, failure/lockout | Public request, PostgreSQL users/credentials, active membership; origin check | auth `service.ts`, `repository.ts`, `crypto.ts`; `auth.test.ts`, `service.test.ts`, `request-security.test.ts`; `db/tests/postgres/test_authentication.py` | Public abuse throttling and real cookie/error E2E need verification. |
| `/api/auth/session`, `/logout`, `/api/auth/tenant`; resolve, revoke, switch | Authenticated session; active tenant/role resolved on reads; CSRF on mutation | `features/auth/server.ts`, auth routes, c567/572 auth functions; lifecycle PostgreSQL tests | No UI session list/revoke-other-device; invitation transition SEC-006. |
| `/profile`; name, email, password, personal avatar | Every role may change own profile; password required for password/email change | account API routes; `management.ts`; identity-image repository/routes and upload tests | Address verification/recovery/MFA pending; image full browser cache cases owned by UI inventory. |
| `/tenants`, `/api/tenants`; list/create/delete | Platform super-admin only, database validated; tenant defaults/settings/wallet atomically created | CRM `tenants.ts`; f8/ac18/eb26 migrations; tenant route/UI/repository and PostgreSQL tests | Deleted tenant API-key bypass; deletion concurrent work/key tests missing. |
| `/users`, `/roles`, settings members/invitations; invite/revoke/change role/remove | Owner/admin management with owner-specific restrictions; users/memberships/invitation digest/audit | c567 + scoped invitation helpers; `test_platform_administration.py`, settings access/authorization tests | Built-in roles only; acceptance not delivery; concurrent accept/revoke and last-owner lock contention need execution. |
| `/invite/[token]`, `/api/auth/invitations/accept` | Public bearer invitation; active target tenant inspected, single-use DB acceptance | invitation route/form/page tests; PostgreSQL one-time acceptance tests | SEC-006; old session on post-commit failure; invited tenant not preserved at login. |
| `/settings` API keys; create/list/revoke, `/api/v1/contacts` read/create | Tenant manager issues tenant-scoped read/write key; API uses bearer scope | `api-keys.ts`, b56 migration; `test_phase4_messaging.py` | SEC-001; creation rate/audit, key lifecycle after member removal policy requires review. |
| `/email`, OAuth config/start/callback Google/Microsoft | Tenant manager only; tenant credential records; shared mailbox channels | email feature and OAuth API routes | SEC-002/008/009; no OAuth-specific tests found; no sync/send/refresh/disconnect client. |
| `/finance`, expense read/create/edit/cancel | Tenant manager; tenant RLS expenses and pagination | finance/expenses API routes, CRM `expenses.ts`, fad migration; tenant-product tests | Separate from wallet: verify timezone/amount/currency boundary and negative role cases. |
| `/api/billing/payment-source`, `/api/billing/topups`; setup card/check out/list balance | Tenant manager; `ENABLE_REAL_BILLING` plus Stripe configuration; wallet/profile/topups | finance Stripe adapter + billing repo + f8/d41 migrations; four adapter tests | SEC-003/004/005; no webhook/ledger integration test found; no refund/dispute/reconciliation worker. |
| Stripe webhook completed payment/setup | Public signed boundary, privileged narrow database functions | `api/webhooks/stripe/route.ts`, `complete_stripe_topup`, `record_stripe_payment_source` | Public request shape/size and expected customer/session/purpose must be hardened. |
| CRM contacts/deals/notes/custom-fields/import, Tasks, Calendar | `crm:read` for reads; `crm:write` mutation; `pipelines:manage` deal move; RLS | Corresponding API routes, `withCurrentTenant`, repositories | Authorization route test currently checks source strings for only a subset; executed API negative matrix needed. |
| Inbox/reactions/assignment/delete/send | `crm:read` reads, `messaging:operate` writes; tenant RLS; webhook separate signature boundary | Messaging routes and canonical repository/outbound adapter tests | Worker ownership/race/deletion semantics should be reviewed by messaging owner. |
| Campaigns/automations/agents/flows/handoffs | `crm:read` list; `campaigns:manage`/`flows:manage` mutations; operator handoff scope | corresponding routes, auth grant helpers | Per-worker reauthorization and simulator/staging exclusion need execution coverage. |
| Voice calls/recordings/campaigns/numbers/flows; signed internal API | `voice:read`/`voice:operate`; audience/capability-bound short-lived assertions | `api/voice/proxy.ts`, `features/auth/server.ts`, voice/dispatcher grant helpers | Downstream assertion/revocation/recording IDOR covered by voice inventory, not proven by BFF wrapper alone. |

## Required negative verification set

1. Every API family above: missing/expired session, viewer/agent/admin/owner and
   super-admin, foreign object IDs, changed membership after page load, missing
   context and reused connection, CSRF/origin denial; assert both HTTP response
   and unchanged persisted rows.
2. Two tenants with same OAuth registration: start under A, switch to B, callback
   must make zero token requests and persist nothing; repeat for account switch,
   logout, expired/replayed state, simultaneous callbacks and provider denial.
3. Delete tenant B from A; confirm sessions/key access/inbound admission/jobs are
   denied while B's audit/finance history remains; test queued/running/lease and
   concurrent new work. Do not run this against the user's real tenant.
4. Invite new/existing/disabled users; accept concurrently and race revocation;
   assert correct browser identity, selected workspace and recoverable outcome
   after DB commit but login/cookie failure. Test owner invariants concurrently.
5. Stripe mocked valid and invalid raw signatures; matched and mismatched
   session/customer/tenant/mode/amount/currency/transaction; duplicate concurrent
   delivery credits once; malformed and oversized input yields a bounded safe
   failure; partial setup/checkout persistence recovers without double payment.
6. Email secrets never reach responses, logs, snapshots or test evidence; key
   version/rotation errors fail closed; provider reconnect does not redirect old
   channel references to another mailbox's credentials.

No live OAuth, email, Stripe payment, Meta send, telephone call, or cloud test is
authorized by this audit. Source review does not mark those integrations ready.
