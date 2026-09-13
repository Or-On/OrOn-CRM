# Readiness risk register

Status is scoped to the candidate under `.artifacts/readiness/candidate`, not the
user's running checkout. Source inventories remain the full discovery record.

| Finding | Severity | Status / evidence |
| --- | --- | --- |
| Inactive tenant API keys continued resolving | High | candidate verified-local: active-tenant lock held through operation; revoke trigger/backfill; real RLS tests |
| OAuth state not bound to tenant/user/session | High | candidate verified-local helper/RLS checks; one-use server state, fresh callback identity, pinned public origin, per-mailbox encrypted credential; provider login not exercised |
| Payment events not fully bound to expected checkout/customer/mode | Critical for enabled billing | candidate verified-local: expected records and strict completion function, replay/concurrency/mismatch tests; real billing remains off |
| Top-up idempotency reused with different amount/currency | High | candidate verified-local: compare original immutable request and use persisted values; real PG concurrency tests |
| Invitation acceptance failure left prior administrator cookies | High | candidate verified-local mocked route tests clear old cookies; accepted-but-login-required state |
| Claims crossed worker/provider scopes and expired while batched | High | candidate verified-local: scoped SQL claims, one-job processing; worker PG suite |
| Queued send ignored changed consent, actor, sender and AI ownership | High | candidate verified-local: final eligibility, ownership epoch and sender binding; narrow race/side-effect limits remain |
| Unknown Meta outcome automatically retried | High | candidate verified-local: timeout/network/ambiguous5xx outcome terminal and reconciliation-required;429 bounded retry |
| Shutdown closed database during in-flight work | High | candidate verified-local: drain before pool close, unit barriers; abrupt kill/reconciliation still pending |
| CRM row import failure produced misleading result | Medium | candidate verified-local: real PG savepoints/fatal-error propagation |
| Python User omitted image columns | Medium | candidate verified-local retained-model parity tests |
| Settings overflow; Overview tablet chart collapse | Medium | candidate verified-local: responsive browser tests and before/after screenshots; Inbox unchanged |
| Simulation endpoints/analytics mixed into staging | High | candidate admission/execution gates verified; existing mixed historical analytics still require provenance review |
| Unpatched NLTK3.10.3 PYSEC-2026-3740, expired exception | High dependency gate | BLOCKED: full voice dependency audit fails; no patched release per maintainer advisory; no renewed waiver |
| Container OS high/critical scanner findings | High/critical release gate | BLOCKED: all four exact final images fail high threshold after available narrow patch; no blanket dismissal or unsupported crypto rebuild |
| Auto-call model decision lacks independent consent/cost budget | High for enabled autonomous calls | BLOCKED: autonomous flags remain off; needs product-approved bounded action/consent and spend policy |
| Email sync/send, MFA/recovery/verified email change | Production gaps | BLOCKED for promises requiring these capabilities; not implemented by connecting OAuth alone |
| Host deployment/bootstrap, authenticated release smoke and cloud recovery | Staging gate | guarded manual pipeline and local rehearsals prepared; real GCP execution pending explicit authorization/configuration, authenticated smoke and media/key recovery not proven |
| Broad workflow/browser/fault coverage incomplete | Release gate | BLOCKED until recorded negative cases, no invented pass for discovered-only paths |
| Active developer runner prevents safe application merge | Safety blocker | Candidate tested separately; stop requested. No live queues, user DB or runtime source were changed by candidate fixes |

The database downgrade gate permits dropping new billing bindings only while no
new recovery data exists; populated bindings refuse downgrade. Operational rollback
uses compatible prior images, never an automatic schema downgrade or restore over
new writes. Historical Or-on revisions remain preserved.
