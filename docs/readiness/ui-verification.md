# Isolated production-build UI verification

Date: 2026-09-12. Local evidence only; not a staging deployment or provider acceptance test.

## Environment and scope

- Candidate checkout: `.artifacts/readiness/candidate`, preserving the dirty starting tree.
- Pinned Node 24.20.0, Next 16.3.3, real separate PostgreSQL cluster on loopback port 55439.
- `scripts/preview_ui.py --production --browser-login` creates and migrates a unique `oron_ui_preview_<UUID>` database, seeds only fictional data, and starts web3100 / fictional login3101 / read-only voice preview3102. No worker or real provider credentials are present. Teardown removes only owned database/logins/processes.
- This harness runs a **Next production build with development-environment fictional fixtures**, not a production deployment. `next start` emitted the warning about `output: standalone`; standalone-container acceptance is a separate main-agent check.
- The temporary login is a tenant **owner**, deliberately not platform superadmin. `/tenants` correctly showed access denied. Positive platform-admin tenant UI behavior is not proven by this run.
- Screenshots/metadata: `.artifacts/readiness/final/observations.json` and the PNG files alongside it. The first broad two-scenario capture was deliberately stopped after complete desktop EN/light and mobile HE/dark coverage. Later captures are risk-focused, not a claim of all-page/all-breakpoint combinatorial coverage.
- Captures only allow browser requests to the two owned preview origins. Functional scripts intercept application mutations with explicit failed responses; they do not send, call, issue real keys or mutate accounts.

## Observations and fixes

| Finding | Evidence | Outcome |
| --- | --- | --- |
| Settings account layout exceeded a 1440px viewport by87px | Initial capture inspection: document1527px. The existing harness overwrote the original PNG/entry on targeted recapture; a before image was not retained | Fixed two CSS grid minimum-track definitions in `apps/web/src/app/workspace-details.css`. New eight-scenario account captures have zero horizontal overflow. Visually inspected desktop EN/light, HE/dark and mobile EN/light; actions and full inputs remain available |
| Overview legacy browser selector no longer matched the implemented chart | `verify_workspace_ui_preview.mjs` queried removed `.overview-bars button`; current component uses `.overview-chart-hit-targets button`, still backed by14UTCdaily rows | Updated selector only; all14-day, keyboard, matching announcement and data-table assertions retained |
| Tablet Overview created implicit grid columns and obscured its accessible data-table control | Functional test at768px, `../brand-rebuild/workspace-failure-768-en-Overview-exact-daily-inspection-and-accessible-data.png`; visually inspected collapsed chart/tiny cards | Fixed all five overview cards to full-width automatic rows at the existing62rem mobile-shell breakpoint, in `apps/web/src/app/studio-replica.css`. Final768px screenshot visually inspected: chart and cards full-width; exact14-day keyboard/table test passes |
| Repeated resource404console notices | Focused captures show only `/api/account/avatar` and `/api/settings/logo`404s | Expected optional-image absence with working initials fallback, not hidden server failures. No change to authentication/image APIs. This remains console noise worth later refinement |
| Development fixture tenant admin route denied | `tenants-1440-en-light.png` | Expected owner-role denial; cannot count as positive superadmin UI acceptance |

## Final recorded evidence

- First production build `aOiaZeUDtlGcNCPcHkEKa`: all six web/dependency packages passed; Next compilation20.4s, TypeScript6.1s. Full page/tab desktop EN/light and mobile HE/dark capture completed.
- Settings-fix production build `pIKP46MH6lf2VqR2R7Wba`: compilation5.3s, TypeScript2.2s. Eight account screenshots cover EN/HE × light/dark ×1440/390; no overflow.
- Final build `k31ud0-n3liKDZ9DtRJ2r`: compilation5.3s, TypeScript4.5s. Targeted tablet screenshot and all final interaction/outage tests below used this build and a fresh UUID database migrated through74e4f347dbbd.
- Metadata indexes85captures across31distinct URLs, including tabs and fictional contact/conversation/call detail. All indexed captures have zero horizontal document overflow. It records the exact build per observation, so unchanged older captures are not falsely attributed to a later build.
-80navigation samples: observed response-start25–67ms, median32ms on the small fictional dataset. This is browser response-start timing, **not** total page completion or a production SLO. A cold Voice navigation took2330ms to DOMContentLoaded despite67ms response-start.
- Generated static chunk directory contained52files /1,961,606bytes on the initial completed build. This is total uncompressed generated chunk output, not per-route download size.
- Workspace interaction suite initially20/25passed; after correcting the stale selector24/25passed, exposing the genuine768px layout issue rather than weakening its assertion. Final rebuilt run **25/25passed** across1440EN/light,1024HE/dark,768EN/dark,390HE/dark and360EN/light. Includes exact daily chart inspection/accessible data, account/tenant form draft retention on failed responses, invitation focus/draft recovery and safe API-key failure. Evidence: `.artifacts/brand-rebuild/interaction-workspace.json`.
- Real optional voice outage: stopped only the owned preview3102 process tree after verifying its parent belonged to `preview_ui.py`. `scripts/verify_contact_outage_preview.mjs` passed2/2cases (1440EN/light and390HE/dark), HTTP200 with disabled calling and localized unavailable notice, contact edit dialog usable, zero overflow. Measured navigation470ms/179ms. Evidence: `.artifacts/readiness/contact-outage/results.json` plus2screenshots; desktop result visually inspected. No provider/database failures were mocked for this outage check.
- Visually inspected Overview desktop, owner-denied Tenants desktop, contact detail HE mobile, call detail desktop, Settings desktop EN/HE and mobile EN, and the tablet Overview failure image. The inspected call had an explicit simulator label and no playable recording; real audio playback was not exercised.
- Early preview logs contained `destination stream closed early` during rapid browser navigation/cancellation. No captured HTTP5xx or client uncaught-page errors were observed in those captures; the log noise is not being claimed absent or fully diagnosed.
- All owned preview processes/database/login were removed via the explicit helper stop endpoint; final harness exited0 and confirmed cleanup. No3100/3101/3102listeners remained. No developer fixture database was modified.

## Acceptance boundaries

Real provider actions, real recording playback, invoice/payment collection, OAuth provider consent, platform-admin positive flows, load-scale performance and comprehensive assistive-technology testing are not established by these local screenshots. Existing authentication/RLS/financial tests and the separate staging acceptance report remain required. No fixture data was added to the developer database.

Page coverage is not all-workflow acceptance. In this browser run, tenant creation/deletion, invitation acceptance/account switching, password/email changes, avatar upload, CSV upload/download, contact/conversation deletion, campaign/automation execution, flow publishing and WhatsApp-to-call transitions were not submitted end-to-end. The failed-response form checks prove recovery only, not successful writes. Viewer/agent/custom-role browser sessions were not exercised; positive tenant-owner behavior and one owner-denied admin page do not replace the separate role/API/PostgreSQL matrix. The complete route/action inventory identifies additional source-inspected versus unreviewed behavior in `application-inventory.md`.

Security successor `bfb741c767fd` and its authorization-lock helper were added after these visual tests. The results above are deliberately bound to the recorded build/head; final root-run acceptance covers the later security code. This workstream did not promote the candidate or edit live application paths.
