# Application readiness feature matrix

The reviewed candidate source has now been applied to the original checkout;
see [merged-tree verification](application-merge.md). Existing candidate evidence
below retains its original scope. User database migration/restart and release
approval remain pending.

Updated 2026-09-12. Baseline: [baseline.md](baseline.md). **Release status: BLOCKED.**
Source inventories are complete as discovery/risk-review artifacts; that is not
an all-action behavior pass. Fixes are in the isolated candidate, not the running
checkout. Original runtime source has not been merged. The main workstream's
consolidated local run completed the code/test/build gates below and then failed
the expired NLTK security gate; this is not a green release or staging approval.

## How to read status

- **Inventory complete / source-inspected**: entrypoints, actions, dependencies,
  role boundaries and known gaps have been recorded. Detailed inspection scope
  remains explicit in each inventory; discovery alone is not execution.
- **verified-local (scoped)**: only the named assertions executed on the isolated
  candidate. PostgreSQL tests use a separate fictional database; provider HTTP is
  mocked unless explicitly stated otherwise. Mock success is not provider proof.
- **blocked / not behavior-verified**: a required supported workflow has no full
  current acceptance evidence, or a known defect/security gate remains open.
- **deferred-with-reason**: a deliberately absent capability, not a successful
  empty result. Nothing in this report is **verified-staging**.

The original inventories are baseline source snapshots. Their old unreviewed or
failed labels are superseded **only for the specifically evidenced fixes here**;
they remain useful for exact paths, method lists, source/test links and open gaps.

## Coverage and evidence index

| Area                                                  | Completed inventory / current evidence                                                                                                                                      | Current state                                                                                                                        | Next exact gate                                                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Web and shared TypeScript application                 | [Application inventory](application-inventory.md): 25 pages, 69 route files, significant actions and shared packages; [application fixes](application-fixes.md)             | Inventory complete; scoped fixes verified-local; full action acceptance blocked                                                      | Run successful writes and negative-role cases listed below on an isolated merged build                                                       |
| Identity, tenants, invitations, roles, billing, OAuth | [Security inventory](security-inventory.md); [application fixes](application-fixes.md); [risk register](findings.md)                                                        | Inventory complete; selected state/financial/authorization controls verified-local                                                   | Complete all-role API/browser matrix, invitation tenant destination and public-account safeguards; separately authorized provider acceptance |
| WhatsApp, voice, orchestration, jobs                  | [Worker inventory](workers-inventory.md); [risk register](findings.md)                                                                                                      | Inventory complete; nine bounded worker findings repaired/tested; voice/automatic-call blockers remain                               | Close WRK-009–013, prove restart/reconciliation, then authorize controlled provider E2E                                                      |
| Database                                              | Worker inventory + scoped application/security/worker PostgreSQL evidence                                                                                                   | Canonical Alembic graph has 57 revisions and one head `bfb741c767fd`; selected upgrade/RLS/locking tests verified-local              | Main consolidated graph/catalog/runtime suites on final merged source; deploy matching schema and code together                              |
| Infrastructure and recovery                           | [Deployment inventory](deployment-inventory.md), [recovery](deployment-recovery.md), [Terraform](terraform.md), [CI](staging-ci.md), [secret retrieval](staging-secrets.md) | Inventory complete; local images/startup/restart/restore and static infrastructure checks verified-local; cloud blocked              | Resolve scan gates; approve project/host, review plan/IAM/secrets, execute protected deployment and authenticated smoke                      |
| UI and accessibility                                  | [UI verification](ui-verification.md), accepted Studio design                                                                                                               | Scoped verified-local: 85 indexed page/tab captures, 25 interaction checks, two optional-voice-outage checks; not all workflows/a11y | Successful mutation/role matrix, 1920px, assistive technology, actual production-env/container authenticated checks                          |
| Performance                                           | [Measurements](performance-report.md)                                                                                                                                       | Scoped verified-local: real RLS contact query benchmark; not capacity/SLA proof                                                      | Larger associated data, HTTP/auth, mixed writes, pool/resource exhaustion and large inbox/boards                                             |
| Cleanup/provenance                                    | [Cleanup plan](data-cleanup-plan.md), [candidate hash manifest](candidate-changes.md)                                                                                       | Inventory/plan complete; packaging hygiene implemented; no user-data cleanup executed                                                | Review exact read-only provenance report and restore evidence before any separately authorized deletion                                      |
| CRM improvements                                      | [Ranked proposals](crm-improvements.md)                                                                                                                                     | Review complete; import/resilience fixes verified-local; other enhancements deferred                                                 | Prioritize pagination, timezone, validation and conflict detection after security/release blockers                                           |

## Verified-local fixes — precise boundaries

| Finding / behavior                      | Implemented and observed                                                                                                                                                                    | Evidence and remaining boundary                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APP-001 contact dependency isolation    | Optional voice request has bounded timeout; failure renders real CRM detail with localized notice/disabled calling; contact edit dialog remains usable                                      | Unit/API assertions plus actual stopped preview voice service: two browser cases returned200, no overflow, editable core data. CRM failure/auth denial is not disguised. [Application evidence](application-fixes.md)                  |
| APP-002 CSV integrity                   | Row savepoints recover from a real PostgreSQL row failure; truthful counters; bounded safe errors; infrastructure failures abort whole import                                               | First/last valid rows survive invalid middle row in real PostgreSQL; orchestration tests separately mocked. Browser CSV upload/import success has not been submitted in this run                                                       |
| APP-003/004 simulation admission        | Exact `PLATFORM_ENV=development` required for the listed simulator web entrypoints and messaging-worker execution; empty legacy automation reports simulator/no-op                          | Staging/production/missing/test refusal tests and prequeued-job PostgreSQL case pass. Historical mixed analytics and the separate control-API simulator surface remain under the worker audit; no real campaign execution added        |
| APP-005 / SEC-004 financial idempotency | Tenant key binds amount/currency/provider/requester/customer; checkout uses persisted values; existing session cannot be replaced                                                           | Actual concurrent PostgreSQL tests and mocked route tests pass. Provider checkout runs outside DB transaction; post-provider write rechecks identity/authorization. Real payment not exercised                                         |
| Billing webhook/setup binding           | Signed bounded raw body; expected customer/session/tenant/mode/purpose/amount/currency; atomic one-time wallet credit; matching successful card SetupIntent                                 | 22 PostgreSQL billing/history tests and59 mocked boundary tests in security report; later authorization/billing/history run32 passed. No real Stripe validation, refunds or historic pending reconciliation                            |
| OAuth/fresh authorization               | One-use tenant/user/session-bound OAuth state; fresh write transaction holds tenant→user→membership→session locks; credential first-save advisory lock                                      | Eight OAuth-state/credential cases include real six-way credential concurrency;32 PG authorization/billing/history tests and62 bounded mocked tests. Real provider consent/refresh/disconnect and legacy envelope migration not proven |
| Invitation post-accept failure          | Clears previous browser cookies if acceptance committed but auto-login/cookie persistence fails; reports accepted but login required                                                        | Mocked route recovery tests pass. Successful invited-account browser transition and invited-tenant destination still require acceptance                                                                                                |
| Tenant/API-key lifecycle                | Inactive-tenant key access is revoked/denied with active-tenant lock and successor backfill                                                                                                 | Main risk register reports isolated RLS regressions. Does not imply every tenant-delete/job race or every handler uses the new fresh-write protocol                                                                                    |
| Worker claims, eligibility and outcomes | Provider/queue-scoped claims, just-in-time single job, final consent/actor/channel/ownership/window checks, sender binding, semantic key fingerprint, original inbound time, shutdown drain | Worker51 unit tests;11 readiness PG cases;13 AI/follow-up PG cases using fake AI/Meta/call dispatch. Unknown outcomes stop for reconciliation; no exactly-once remote delivery claim                                                   |
| Retained user model                     | Nullable avatar BYTEA/TEXT/TIMESTAMPTZ columns represented in SQLModel                                                                                                                      | Eleven model tests and main retained-model parity evidence; no schema redesign                                                                                                                                                         |
| Settings and tablet Overview            | Fixed minimum-track overflow and implicit tablet columns; Inbox visuals unchanged                                                                                                           | Eight settings theme/locale/viewport captures; final25/25 interactions pass, tablet image visually inspected. Before Settings PNG was overwritten by harness, explicitly documented                                                    |

Counts above are separate scoped runs and must not be summed as unique coverage.
Application PostgreSQL rerun passed88 tests in19 files with one legacy
alternate-database test skipped. Focused web suite passed78 tests; billing unit
suite passed9. The main workstream subsequently reported107 database-suite tests
passed in66.67s at the final57-revision `bfb741c767fd` head; this is database-suite
evidence, not a full consolidated gate pass. UI evidence is bound to build `k31ud0-n3liKDZ9DtRJ2r` through
`74e4f347dbbd`; later auth-only successor `bfb741c767fd` has separate tests, not
retroactively claimed visual evidence. These scoped runs are not retroactively
attributed to later builds.

### Final consolidated local result

Main workstream reported on2026-09-12: formatting, lint, typechecking,619
TypeScript tests (48 skipped),834 Python tests (108 skipped), contract/migration
checks, production build, peer checks and pnpm audit passed. The consolidated
command then **failed the expired NLTK advisory gate**. No skipped case is counted
as passed; the separate107-test actual PostgreSQL suite is the live-DB evidence,
not the unit-test totals. Four generated-contract before/after SHA-256 values
were unchanged. A candidate-filesystem secret-pattern scan covered1042 files
with zero findings; this is not a full-history or universal secret absence proof.

Offline database verification reported57 revisions,22 preserved Or-on revisions,
one head `bfb741c767fd`, and deterministic PostgreSQL SQL of247490 bytes with
SHA-256 `5b900b7340ad43470ab71d7946bbd64a6770266777626b1373988cad300c8269`.
An eventual conflict-safe merge must rerun relevant gates; no tested candidate
hash is evidence of an untested future merge or a real-provider operation.

## Significant action acceptance register

Source paths, API methods and permission mappings are fully indexed in the
application/security/worker inventories. The rows below track execution gaps,
not merely whether a page was visible. A browser screenshot or failed-response
recovery test never establishes successful persistence.

| Surface / significant actions                                       | Local execution established                                                                        | Still blocked / not behavior-verified                                                                                                               | Actionable next gate                                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login, locale entry, `/start`, session/logout/tenant switch         | Fictional owner login and locale/theme navigation exercised; auth suites cover named cases         | Complete expired/locked/disabled account, cookie/session rotation and every tenant-switch role/browser state not proven                             | Two-tenant owner/admin/agent/viewer plus superadmin sessions; verify current identity and DB effect after each mutation                              |
| Invitation inspect/accept, new/existing account, revoke             | Post-commit failure/cookie recovery tested                                                         | Existing-account default may choose ordinary membership rather than invited tenant; full successful browser acceptance/revoke races not established | Issue fictional invitation, accept as new/existing user, reopen session and assert exact account/tenant; race revoke/accept                          |
| Profile name/email/password/avatar and shell avatar                 | Pages inspected/captured; failure recovery and existing model/image tests                          | Successful upload/cache propagation and account changes not E2E-proven; verified email change/recovery/MFA absent                                   | Authorized fictional account save/reload/login/logout tests; define and implement public-account verification/recovery requirements                  |
| Tenant directory/create/delete/switch                               | Owner-denied admin page observed; DB/security regressions scoped separately                        | Positive platform-admin CRUD, typed-delete, last-owner and concurrent queued effects not proven by UI run                                           | Create isolated tenant with defaults/wallet, switch, remove with active sessions/jobs and assert deny/retained audit behavior                        |
| Users, role matrix, invites/member removal/API keys                 | Invitation/API-key failed-response focus/draft recovery; selected key lifecycle tests              | Full permission-to-action matrix and successful role/member/key browser actions not proven                                                          | For every significant route assert allowed role succeeds, every forbidden role/foreign ID fails with unchanged rows; test revocation after page load |
| Contacts list/search/create/import                                  | Real savepoint recovery; contact repository load benchmark; pages captured                         | Browser create/import completion, pagination beyond50/100, full search, name/email/custom-value validation remain gaps                              | Submit fixture CSV with actual invalid row, reload exact counts; boundary validation and >limit cursor tests                                         |
| Contact detail/edit/notes/custom fields/consent/archive/call dialog | Core rendering/edit dialog survives actual voice outage                                            | Successful edits, consent persistence, archive/deletion and call admission not submitted end-to-end; stale edits unresolved                         | Save/reload each field, concurrent writers, cross-tenant IDs; retain caller privacy and no live call without authorization                           |
| Inbox read/history/unread/assignment/status/reactions/delete        | Source/UI coverage plus named messaging/worker DB regressions                                      | No complete successful Inbox-action browser pass; latest100 queue search cap; reaction provider propagation and attachments unsupported/unverified  | Isolated receive→display→reply→receipt→unread reset; human takeover/revocation/deletion races; notification interaction and paging beyond limit      |
| Real WhatsApp text/template/webhook                                 | Fake HTTP error/idempotency/eligibility tests and actual DB effects                                | Live Meta token/assets/window/template/signature/delivery and uncertain-outcome reconciliation not exercised                                        | Separate explicit single-recipient authorization, real signed inbound and receipt, recorded result; never infer delivery from queue success          |
| AI WhatsApp reply→call follow-up                                    | Thirteen isolated AI/follow-up PG cases use fake adapters                                          | Independent call consent/spend policy, immutable voice version and ownership epoch across SIP remain open; no real conversational E2E               | Close WRK-009/013, then bounded user-approved scenario with preserved conversation context and durable evidence                                      |
| Messaging campaigns/legacy automations                              | Nondevelopment refusal and explicit no-op semantics tested                                         | These endpoints remain simulator-only; real campaign run cannot be advertised                                                                       | Keep blocked in staging; separately scope real campaign behavior/caps/consent before implementation                                                  |
| Agents, connected flows, publish, handoff                           | Source inspected and scoped flow/worker tests; graph view captured                                 | Successful author→validate→publish→run→handoff browser path and permission races not fully executed; canvas not arbitrary graph editor              | Build fictional published agent/flow, pin immutable versions, run supported graph and inspect every durable node outcome                             |
| Pipelines/deal stage move                                           | Source/page inspected; existing repository tests available                                         | Pipeline/stage/deal creation API absent; unbounded board queries and concurrent stage edit not closed                                               | Define supported lifecycle; test permitted/foreign/same-pipeline move; measure larger board before pagination decisions                              |
| Voice overview/numbers/campaigns/flow validate+publish              | Fictional pages/flow controls and selected retained Python/DB tests                                | Real number/trunk reconciliation, published-flow execution and caller permission matrix not provider-tested                                         | Complete isolated control/dispatcher contract failures, then separately authorized provider configuration/single-call smoke                          |
| Recent call details/recording/transcript/cost                       | Fictional call detail renders with honest simulator/no-recording label                             | Real audio playback/quality, costs, artifact URI/size/read bounds, restart-finalization and SIP recovery unresolved                                 | Close WRK-010–012; authorized recording range/IDOR/size tests; measured call/receipt/accounting checks                                               |
| Tasks                                                               | Source/UI and existing repository coverage                                                         | Successful create/edit/complete/cancel browser flow, tenant-vs-browser timezone/DST, stale writes and >500 records not proven                       | Explicit timezone semantics and DST fixtures; persistence/action/role matrix; cursor or truthful bounded behavior                                    |
| Calendar                                                            | Source/UI; existing timezone/tenant repository tests                                               | Full successful create/edit/cancel/all-day browser/DST matrix not run; reminders/recurrence absent                                                  | Two operator timezones; all-day/end bounds, edit conflict and retained cancellation; scope reminders separately                                      |
| Finance expenses                                                    | Source/UI and repository coverage                                                                  | Successful CRUD/currency/timezone/negative-role browser flow not run                                                                                | Create/edit/cancel fictional expenses; assert per-currency totals, cursor ordering and forbidden access                                              |
| Wallet/card setup/top-up                                            | Strong scoped DB/mocked boundary tests above                                                       | Real Stripe test-mode flow, history/customer migration, refunds/disputes/reconciliation not done                                                    | Reconcile legacy pending intents, approve provider test mode, exercise exact setup/payment/duplicate/mismatch outcomes                               |
| Email credentials/OAuth                                             | Scoped one-use state, fresh auth and encrypted credential concurrency tests                        | No mailbox sync/compose/send/refresh/disconnect implementation; live consent not exercised                                                          | Keep connection-only claim; separately define mailbox capability and key rotation/refresh/revocation requirements                                    |
| Settings workspace/member/key/appearance/notification views         | Account layout repaired; theme/locale and failed-response draft recovery pass                      | Successful workspace/member/key writes and notification preference backend not established                                                          | Submit each fictional form and reload; role denial, origin/CSRF and field validation; don't advertise absent preferences                             |
| System Health                                                       | Current-page core/API/DB observations render and refresh                                           | Not provider/queue/worker availability, historical SLA or delivered alert evidence                                                                  | Inject bounded failures in owned stack, verify stale/unavailable states and operator alert delivery                                                  |
| Error/loading/empty states and shared controls                      | Representative captures, keyboard chart/focus recovery, no horizontal overflow in indexed captures | Full503/timeout/expired-session/retry, screen-reader/contrast/reduced-motion and all viewport combinations not covered                              | Risk-based failure-state routes, keyboard-only critical paths, EN/HE assistive-tech review and1920px verification                                    |
| OpenLive visual/Live Lab/video UI                                   | Source/persistence retained, no false page capability                                              | deferred-with-reason: user explicitly postponed visual integration                                                                                  | Separate approved phase; do not infer finished video calling from voice or live-grant contracts                                                      |

## Release gates, in order

1. **Safe merge blocked while runner active.** Keep existing changes; compare
   [candidate hashes](candidate-changes.md), stop only with user authorization,
   review/apply exact source delta, then reverify merged contracts/tests/build.
2. **Dependency/image security blocked.** [Image report](image-security.md) retains
   unresolved high/critical vendor findings. Voice dependency advisory
   `PYSEC-2026-3740` has an expired exception; no invented waiver or downgrade.
3. **Supported-workflow acceptance incomplete.** Execute the action register with
   both positive persistence and negative HTTP/DB assertions. Public account
   safeguards, voice recovery/artifact bounds and autonomous consent/cost controls
   are explicit product/security gates, not optional cosmetic polish.
4. **Cloud staging not authorized/executed.** Local Compose startup/restart and
   tiny fresh/fictional restore drills pass; they do not validate actual IAM,
   DNS/TLS, secrets, alerts, media recovery, load sizing or authenticated deployment.
   Follow [deployment/recovery gates](deployment-recovery.md), not `dev.py` with
   inherited real credentials. No claim of staging or production approval.
5. **Providers remain separate.** No live Stripe/OAuth/WhatsApp/telephone/cloud
   action was executed for this task. Real-mode flags are not enabled to hide
   empty states. Each controlled provider smoke needs separate authorization.

## Preservation evidence limitation

The baseline records442 dirty paths and958 tracked/nonignored files, not full
pre-task content hashes. Initial baseline `pnpm test` rebuilt generated CRM
`dist`; this was recorded and is not source mutation evidence. Current original
hashes can be checked against the later candidate manifest and tool action
history shows no runtime-source merge, but **cryptographic equivalence to every
pre-task byte cannot be claimed**. Original-only infrastructure/docs work and
two staging test files must be preserved independently of the candidate.

Read-only check at2026-09-12T17:37:23Z compared all65 recorded original-file hashes
in the then-current delta manifest and found zero changes; all25 proposed added
paths were still absent from the original. This proves preservation since that
manifest snapshot only, not full pre-task equivalence. No tests/builds or runtime
merge were performed during this documentation refresh.
