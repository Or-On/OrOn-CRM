# Overnight UI and feature acceptance — October 5, 2026

This is the UI workstream of the 281-row requirement audit. It does not replace the requirement matrix or certify all routes from a build. Root owns the live browser and deployment; this workstream owns web changes, local API/DB/component tests, and the route checklist below. No customer message, telephone call, provider setup, signup, or live rebinding is performed here.

## Reproduced defects and repairs

| Defect | Reproduction | Repair | Verification |
| --- | --- | --- | --- |
| A current voice binding hides another stale binding | Two flows use v1 and v2 while v2 is published; the aggregate `max` check shows no warning. EN/HE component regressions failed. | Warn beside each stale flow, identifying its own version. | Included in focused 27-test pass and later 91-test pass. |
| New draft hides the published version in flow creation | Latest v3 is an unpublished voice-only draft; retained published v2 supports both channels. Both selectors offered nothing. | Bind selectors and empty-state action to `publishedVersionId`, version and published channels. | `overnight-flow-selector-red-actual.log`; focused agent suite passes. |
| WhatsApp eligibility differs from global publication | A newer draft/voice-only/unapproved publication hides an eligible default action or points stale-conversation rebinding to the wrong version. | Default action uses the server's eligible ID; stale/rebind labels and target use eligible ID/number. Global published badge stays separate. | `overnight-agent-default-red.log`, `overnight-agent-rebind-red.log`; CRM peer owns approval/query regression and web fixtures include the numeric eligibility projection. |
| Flow attachment is presented as effective live routing | The quality endpoint lists published attachments without proving selected process priority, approval, features or retained-flow availability. | Label it “Published voice flow bindings”; do not present attachment as proof of the effective runtime. | Voice workstream separately inspected exact compiled per-tenant resolution. |
| New flow silently starts with retained script version 1 | Numeric version input had `defaultValue="1"` regardless of actual library versions. | Require explicit version input and link to the published voice-flow library. Intentional existing pins remain unchanged. | Agent capability form regression asserts blank required version and library link. An integrated version picker remains a usability opportunity, not a claimed implementation. |
| Stale workspace settings can overwrite another tenant | Actual `platform_web` API/PG fixture opened A, switched authenticated scope to B, then submitted A's form; B's tenant name and business name changed. | Both business and support forms carry their rendered tenant ID; PATCH freshly authorizes and compares before any write. Localized error retains the form draft. | `overnight-settings-stale-red-actual.log` shows the fictional B values overwritten before repair; `overnight-settings-green.log`: 8 files / 91 passed, including actual PostgreSQL and credential preservation. |
| Auth suite discovers generated tests twice | Auth build emitted source tests into `dist`; Vitest discovered both copies, and the emitted shutdown test imported nonexistent `dist/process-database.ts`. | Explicit source test discovery; exclude test files from production auth compilation. No source test removed. | First run 95 passed / 1 failed across duplicated 96 tests; final unduplicated run recorded below. |

Current runtime facts are kept distinct: the voice workstream's read-only compiled resolver found Or-On agent **v4**, ProTouch agent **v1**, and retained voice-script pins **v1** for both. The script pin is a different version axis; Or-On also has newer retained scripts. Any reviewed live repin is owned by the root/voice workstreams. Archived agent profiles do not establish a current v3 regression.

## Route acceptance inventory

There are 37 `page.tsx` patterns. Earlier owner-fixture browser evidence at seven widths is in `UI.md`; it predates these overnight changes and is not silently upgraded to a fresh live pass. The “required live check” column is a page-by-page checklist for root's browser, not a list of passed actions. Full role, tenant, mobile and mutation acceptance stays open until individually evidenced.

| Route | Features / required live check | Local evidence or explicit gap |
| --- | --- | --- |
| `/` | Dashboard scopes, cards and navigation reflect active tenant | Prior synthetic owner render; no fresh live claim |
| `/contacts` | Search, paging, consent labels, same-number tenant isolation | Prior fixture render; contact/API tests in web suite |
| `/contacts/[id]` | Exact contact, related activity, configured caller and consent denial | Prior fixture detail; contact resilience/voice API tests |
| `/leads` | Search, stage, owner, paging and detail link | Prior fixture render; lead UI/API tests |
| `/leads/[id]` | Field edits, saved state, history and tenant denial | Prior fixture detail; role/mutation browser gap |
| `/pipelines` | Board/list movement, failed operation recovery | Prior fixture render; board tests; live action gap |
| `/tasks` | Filters, completion, loaded-record limit and saved state | Prior fixture render; task tests; full-list paging gap remains explicit |
| `/calendar` | Tenant timezone, event detail, calendar navigation | Prior fixture render; no external meeting action |
| `/inbox` | List/thread/contact panels, draft retention, paging, AI reason/rebind, media, effective sender | Prior mobile/desktop fixture and detailed UI.md; current eligible-version fixture updated |
| `/tickets` | Search/filter/paging, contact names, touch cards | Prior actual-PG 55-ticket paging at seven widths |
| `/tickets/[id]` | Status/owner/next action, history, close/reopen, safe call context | Prior detail/foreign-tenant denial; mutation browser gap |
| `/operations` | Campaign/job state, failed/unknown send distinction, permission-aware retry | Prior fixture render; never replay unknown external sends as a test |
| `/orchestration` | Agent lifecycle, published versus eligible versus bound, all four tabs, explicit version selection | Overnight regressions above; no live publish/rebind from this workstream |
| `/flows` | Actual retained IDs/versions, source/validation/publish permissions | Prior fixture render; any publication requires reviewed content |
| `/voice` | Calls/agents/flows, effective sender, answer/outcome/artifact facts | Prior simulator render; actual live acceptance belongs to voice/root |
| `/voice/campaigns` | Progress, consent, pagination, simulator versus real flags | Prior simulator render; no campaign launch |
| `/voice/calls/[id]` | Exact tenant/session, answered state, transcript/audio and recorded version | Prior fixture detail; live receipt checks delegated to root |
| `/finance` | Honest unconfigured state, tenant totals, errors | Prior unconfigured render; no payment setup/transaction |
| `/email` | Provider switch clears secrets, private draft scope, stale-tenant save failure | Actual API/PG+component proof in CREDENTIAL-FORMS.md; current browser capture still missing |
| `/settings` | All nine tabs, business/support save/reload/switch, permissions, superuser badge | Overnight stale-scope fix; prior business save/reload; superuser live view required |
| `/settings/business` | Feature/process configuration, reviewed approval and version identity | Prior owner render; no new live configuration activation in UI workstream |
| `/users` | Role-aware team/invitation actions and errors | Prior owner render; no real invitation sent |
| `/roles` | Permission descriptions match authorized actions | Prior owner render; no live access expansion |
| `/profile` | Account scope versus tenant scope, validation, save feedback | Prior owner render; no credential change |
| `/tenants` | Superuser inventory; ordinary owner denial; active tenant distinct from global role | Prior owner denial only; root's superuser browser required |
| `/start` | Setup completeness reflects real configured capabilities | Prior owner render; no provider activation |
| `/system/health` | Readiness versus stale/failed check, timestamp, safe errors | Prior render; deployed runtime receipts separate |
| `/account/security` | Session list, labels, unavailable SMS/provider state, keyboard | Prior render; no MFA enrollment or live password reset |
| `/field-service` | Authorized technician/manager navigation and tenant cases | Earlier denied fixture is insufficient; populated authorized browser gap |
| `/field-service/cases/[id]` | Scoped case, attachments, appointments, report actions | Source/API tests; no prior populated browser proof |
| `/field-service/ocr` | Upload/review/validation/error and permission state | Earlier denied fixture; no live customer document upload |
| `/field-service/reports` | Report list, filters and permitted actions | Earlier denied fixture; authorized browser gap |
| `/field-service/reports/[id]` | Draft/finalized state, export, signature and permission controls | Source/API tests; no prior populated browser proof |
| `/login` | Validation, rate-limit/error, successful authorized login | Preview login previously passed; root owns supplied live admin login |
| `/invite` | Invalid/expired token, error focus, required fields | Prior invalid-invitation mobile view |
| `/en` | LTR locale transition and unchanged active tenant | Prior locale redirect checked |
| `/he` | RTL locale transition and mixed phone/date text | Prior locale redirect checked |

Cross-route checks: 320/375/390/430/768/1366/1920 widths; dialogs with Escape/focus return; visible keyboard focus; reduced motion; no document horizontal overflow; tenant A→B→A; owner/superuser/read-only/technician; failed save preserves draft and never reports success. Physical keyboard/safe-area behavior cannot be inferred from jsdom.

## Execution and browser limits

The current child browser tool returned empty app/browser inventory and `Browser is not available: iab`. Root has a separately available IAB and owns live inspection. This workstream did not fabricate screenshots or replace browser evidence with source assertions. Local database fixtures remain synthetic and are removed by `.artifacts/poc_rescue_verify.py`.

Focused results: `overnight-agent-ui-green.log` (27 passed), `overnight-settings-green.log` (91 passed), `overnight-version-final.log` (11 passed). Final full web verification passed **158 files / 950 tests / zero skips** against the isolated PostgreSQL fixture (`overnight-web-final.log`). The canonical auth suite passed **10 files / 48 tests / zero skips** (`overnight-auth-final.log`); its earlier doubled count included generated copies of the same source tests, not additional coverage.

After that full pass, two additional EN/HE component assertions verified that a stale settings error is localized and preserves the edited name without refreshing or reporting success. These and the final lint-only test corrections passed **3 files / 39 tests** (`overnight-final-components.log`); there was no further runtime change. Root `pnpm format:check`, `pnpm lint` and all **11 workspace typechecks** passed (`overnight-format.log`, `overnight-lint-final.log`, `overnight-typecheck.log`). The three final test files also passed Prettier and the complete diff passed `git diff --check`.

No skipped run is counted as verification: the first settings filter invocation selected no tests and was replaced by the documented real red/green run. Browser, role and route gaps above remain open despite these automated checks.
