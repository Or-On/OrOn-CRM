# Verification ledger

Evidence belongs to the exact source indicated. Local DB runs use fictional isolated PostgreSQL databases, not live provider acceptance. Detailed logs and screenshots are in ignored .artifacts/poc-rescue-local.

| Current merged source check | Result | Scope/limit |
|---|---|---|
| db_verify.py offline | Passed; 138 revisions, one head `8d32f4a91c70` | Graph/rendered SQL/security contract; final migration peer review continues |
| Harness python-aligned, fullpytest | 2295passed,3failed,17skipped | Failures: old revision counts2, SLI DBprefix1. Model gates explicitly skipped |
| Harness python-aligned-recheck | 21passed,0skipped | Corrected all3 failures; actual PostgreSQL SLI denominator |
| CRM full suite | 740passed,1failed,0skipped | Memory test depended on externally published fictional agent |
| Harness crm-memory-current | 1passed,0skipped | Self-contained rolled-back fixture; provenance/auth assertions preserved |
| Agent/dispatcher/runtime | 1293 passed, 17 model gates | All gated scenarios separately exercised with actual providers; see VOICE.md |
| Worker before Coexistence | 69 files / 660 passed; one Windows POSIX-permissions skip | Actual DB gates enabled; new Coexistence suite recorded separately |
| Web before final webhook pooling adapter | 157 files / 937 passed | Includes prior 99 focused UI tests; no DB-backed browser replacement implied |
| Auth before verifier profile | 18 files / 91 passed | Real PostgreSQL; six final pool tests separately pass |
| Final pool/verifier adapters | Six actual-DB pool tests; 36 webhook adapter tests; signature-proof DB regression passed | Exact DSN/profile bounds, tenant RLS, lazy privileged verifier and receipt retention on verifier failure |
| Browser | 25/50/55tickets,contactnames beyond500,savedsettings,draft/back/deeplink and tenantdenial | UI evidence retains device/role limits |
| Deployment tests | Initial71/72; correctedorderinggroup21passed | Controlled EXITrollback failures/drainorder; not live rollback |
| Architecture | Passed | PostgreSQL/Alembic/package boundaries |
| Actual cloud/provider reads | SSH/images/schema/Twilio/LiveKit/Meta succeeded | See registration attempts below; no provisioning/deployment mutation |
| User real ProTouch inbound | No durable receipt; provider PENDING | No AI reply claimed |

Run suites with `uv run --no-sync python .artifacts/poc_rescue_verify.py <unique-label> <command-and-arguments>`. Harness strips provider secrets, disables real providers, migrates fresh DB, creates separate empty/seeded clones for claim-sensitive suites and drops only owned UUID DBs. Worker Coexistence and final container checks remain in progress.

## Container and deployment evidence

Python images were built from Git archive `525be698cf2bcbedf0a008b94809e5d69c9a12a6`, with immutable image IDs and OCI revision labels recorded in `python-image-build-results.json`. Dispatcher and control API report live/ready 200 in the owned Compose project, run as UID 100 with restricted PostgreSQL roles, and have real-provider flags false. Twenty valid fictional WAV/transcript lifecycles passed with preserved staging on failure, zero staging after successful completion, and read-only artifact access from control API. The memory snapshot covers that artifact probe, not the complete voice pipeline.

A fresh PostgreSQL container with delayed initialization reproduced three samples where a Unix socket was ready but TCP was unavailable. The new TCP healthcheck stayed unhealthy until the final server became reachable. The exact disposable regression container was removed; existing containers/volumes were retained. Evidence: `container-stack/pg-health-regression.json`, `python-runtime-acceptance.json`, and `python-artifact-lifecycles.json`.

Later pricing/migration/source changes require final image rebuilds; these older images do not certify the evolving tree. Caddy signed ingress, dependency failure, enriched encrypted restore, final shutdown and previous-image compatibility remain distinct pending gates.

## Real provider boundary

The user-approved ProTouch `/register` operation was rejected with HTTP 400, code 100/subcode 2388001. One reconciled repeat with the same protected PIN captured the existing-account reason. No registration success, external send or deregistration occurred. The user then confirmed the Business phone app and required preservation; ordinary registration is suspended. Latest read-only comparison: Or-On is `CONNECTED/CLOUD_API/is_on_biz_app=false`; ProTouch is `PENDING/NOT_APPLICABLE/is_on_biz_app=false`. This means Or-On is not the proven Coexistence example the user expected. See [COEXISTENCE-GAP.md](COEXISTENCE-GAP.md) and [registration history](PROTOUCH-REGISTRATION-PLAN.md).

The corrected historical baseline contains 88 unique inbound customer messages and 37 exact accepted/delivered reply links; its accepted-only p50/p95 and retention limitations are detailed in [BASELINE.md](BASELINE.md). Status callbacks were wrongly included by the prior SLI query; five actual PostgreSQL regressions now pass. Neither the raw ratio nor accepted-only percentiles certify the required turn-level response SLI.

## Historical local baseline

Auth66,Python1962,CRM641 and worker433passed before merging deployed42eebac2. They prove only that earlier tree. Its text-only media defect and weaker rollback are not attributed to current runtime. First personal SSH denial was resolved through an already-authorized service account.

No live callerID/AIreply,actual-device keyboard,30day causalSLI,48hourcanary,human-scored Hebrew golden set or independent off-host restore certified.
