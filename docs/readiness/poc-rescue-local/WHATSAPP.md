# WhatsApp verification — 2026-10-04

## Actual source and first provider failure

The original checkout `3582027b` was six commits behind the deployed source. Remote image revisions and the deployed marker report `42eebac2d423bb70a0c69690e8d2899beab12249`; the deployed database reports migration `fc6e851f3ba0`. The parent merged that source before continuing repairs. The earlier 433-test result and media/parser recovery changes against the old checkout are historical evidence only. The duplicate local recovery flag was removed in favor of upstream tenant flags, admission, fencing and recovery implementations.

Read-only running-service, database and Meta checks on October 4 established:

- Active ProTouch tenant: `633d9906-3866-4ddd-b85c-99c525bd3cb3`. The other `protouch` tenant, `c59d42fb-2e8a-4d3e-b739-37158f6ce473`, is deleted. Active channel `425601b5-2abc-4b9a-912c-731e6705446f` routes phone `1284902841381185` in WABA `992519473248296`.
- Running web and worker containers have real WhatsApp and AI enabled with distinct ProTouch credentials. Tenant activity, WhatsApp entitlement and enabling-actor authorization all return true. Missing direct tenant membership is not an authorization failure: the existing function accepts this active platform superuser.
- Meta confirms actual display-phone suffix `4553`, `code_verification_status=VERIFIED`, but `platform_type=NOT_APPLICABLE`, `status=PENDING`, `is_pin_enabled=false`, `is_on_biz_app=false`, and no `last_onboarded_time`.
- Application `2636656843431645` has an active messages callback at `https://dev.or-on.io/api/webhooks/whatsapp/protouch`. Public verification GET returns HTTP 200 and the exact challenge. Read-only API and application-subscription queries succeed.
- After the user sent a real controlled inbound, ProTouch still had zero durable inbound events, conversations and jobs. The observed first failure is before application ingestion, consistent with pending Cloud API registration. No fake inbound was inserted.
- Retained Or-On data contained 88 text events and 190 status events, with successful AI/send jobs on October 4. These are message counts, not a deduplicated turn denominator or response-rate measurement.

See [the scoped registration plan](PROTOUCH-REGISTRATION-PLAN.md). Registration is a separate provider operation; later approved execution evidence must update this finding. The initial local environment lacked ProTouch's additional account, but the deployed environment has it. The local observation was not used to overwrite deployed configuration.

After explicit user approval, the parent attempted the scoped registration and then repeated it once with the same protected PIN after reconciling the explicit rejection. Both were rejected with HTTP 400, code 100/subcode 2388001. Meta's returned user-facing reason says the number is already registered to an existing WhatsApp account and must be disconnected there first. This conflicts with any inference that `is_on_biz_app=false` proves no existing account. Registration remains pending; no further POST or deregistration is authorized by these diagnostic results. The user must identify the existing installation/provider and approve the appropriate migration/disconnection. Sanitized evidence: `wa-registration-rejection-detail.txt`, provider trace `A6p8XWhd8LwAceVs6Vh5sZj`.

The user then confirmed an active WhatsApp Business phone app. The next evaluated path is Meta Coexistence to preserve it; no automatic app disconnection/deletion. The registration plan records the parent's authenticated primary-documentation findings and the current missing Embedded Signup/history/echo integration. `is_on_biz_app=false` alone must not be used as evidence that the phone app is absent.

## Historical funnel investigation

Read-only 30-day investigation at 20:52 UTC found all 35 unmatched inbound receipts marked processed, each with one attempt, dated September 13–19. Seven audited conversation deletions exist. Twenty-eight AI jobs reference those audited deleted conversations: 24 succeeded and four died. Twenty-three successful-send requests and all three dead-send requests no longer exist; 14 of 18 intake trigger messages are gone. These facts demonstrate missing retained evidence, not 35 proven ingestion losses. Exact provider-receipt-to-deleted-message attribution cannot be reconstructed from the retained rows.

| Retained historical job failure | Count | Creation period |
|---|---:|---|
| `field_service_intake_failed` | 18 | September 15–19 |
| `field_service_summary_failed` | 13 | September 15–16 |
| `call_http_500` | 1 | September 14 |
| `AI reply failed` | 3 | September 14 |
| `AI inbound trigger superseded` | 2 | September 19 and 23 |
| `ai_evidence_changed` outbound | 3 | September 13 |

The 53 retained inbound messages split into 37 with exact linked outbound messages, 15 without a retained AI job, and one with a dead superseded AI job. The 15 no-job messages occurred September 20 (five), 21 (eight), and 30 (two); only two have an unlinked human/system follow-up candidate within an hour. Current AI ownership does not prove ownership when each was received. The retained superseded job was created at 19:10 for a 06:44 trigger; the next retained inbound at 14:03 has an accepted reply. That proves a later reply exists, not an on-time response to the older turn. All retained handoffs are resolved (two) or cancelled (seven).

The parent's corrected `remote-baseline-30day-corrected.txt` is authoritative for provider acceptance: 37 exactly linked accepted/delivered responses among 88 unique inbound receipts, with the missing/deleted/ambiguous cohorts retained in the denominator. The historical errors precede the current deployment and were not automatically retried. Detail is in `wa-historical-causes.txt` and `wa-retained-cohorts.txt`; no customer message bodies were read.

## Effective WhatsApp agent and process

| Binding | ProTouch | Or-On |
|---|---|---|
| Default profile | `b9bd6d66-f75e-4c99-a60a-23078a656f1f` | `77eb1e6a-2e96-4264-8f6b-859b0dd963ae` |
| Published valid version | v1 `9a9bfdbf-4c46-4bd4-842f-2bfb8c4cb173` | v4 `072b9420-8f25-479f-a785-6a57dafd1120` |
| WhatsApp new-conversation process | `7a86c88a-439a-4541-9e39-51007cbf3f16` | `098b05e3-88d2-49d0-8c76-5764d00b838f` |
| Approved Flow | `c085668d-9bfd-4e94-9c3d-017b73b67ea3` | `0b501aad-4623-4916-a6a9-4bb58cd40d58` |
| Knowledge | No schema/source IDs | schema 1.0, source `a8cba9b5-ecd3-4114-8adc-c2f65b87934c` |
| Model | null version-specific configuration; running fallback `gemini-2.5-flash` | Same explicit environment fallback |
| Actual conversation | None reached ingress | Current AI-owned conversation uses v4 |

The historical Or-On v3 report is not reproduced in current WhatsApp data. Configured ProTouch v1 is not proof of a model call. Prompt fingerprints were retained without copying prompt text. Session-start admission exists behind `session_memory`; there are no deployed remediation-flag rows, so the new behavior remains off. Approved process pins must not be bypassed just to pick a newer version.

## Automatic opening and language

Current source already has a separate durable `whatsapp.opening_menu` workflow: exact live template approval, claim-bound send authority, retained generations and physical outcomes, template history, duplicate/stale-button protection, and independent media processing. Manual template selection is a separate UI capability.

Opening requires enabled tenant/channel configuration, published agent/approved Flow, machine principal/capability grants, verified destinations, and approved Hebrew and English templates. Deployed data has **no opening configurations or principal bindings**, and ProTouch's provider catalog is **empty**, with no next page. Automatic opening is therefore not active.

The menu uses new/first or 24-hour inactivity/reopen boundaries; memory sessions initially use 12 hours. These are distinct policies. Language prefers retained preference, then message script, then fallback. Device language is absent from the observed webhook contract and is not inferred from phone prefix. Explicit customer language-selection UX and separately recorded language-decision provenance still need verification; menu buttons currently choose services/support. Real approved templates and reviewed canary configuration are required before activation.

One surviving defect marked blocked/menu-gated jobs `succeeded` without performing the action. The local patch cancels those jobs under the current claim with an explicit `opening_menu_*` reason. A physically accepted opening offer alone takes the success branch. This uses the existing default-off menu gate and enables no tenant. The integration suite now creates independent fictional tenant/principal/Flow/template fixtures instead of requiring undocumented preexisting data. An inactive-principal case requires zero model/provider calls and explicit cancellation.

## Local verification and limits

All local providers are fakes. UUID databases use the parent's isolated PostgreSQL 18.6 cluster and role-limited worker paths. The user's original database and provider keys are not copied. Global queue claimers need independent empty/seeded databases.

- Initial current-source worker run: **649 passed, 5 failed, 6 skipped**. Four diagnostic failures were caused by another suite's leftover queued jobs; one fairness failure by an unrelated seeded job. Dedicated fixture databases correct these, and the original failures remain in `wa-current.log`.
- Opening suite after self-contained fixture repair: **15/15 passed**. A fifth blocked-principal integration scenario was added to the final worker run.
- Final current-source worker suite: **69 files, 660 passed, one intentional Windows file-symlink skip, zero failures**. All five opening-worker cases ran. Worker typecheck passed.
- Negative regression against an isolated copy of `origin/main` fails the new blocked-principal cancellation assertion as expected: one failed, four deliberately unselected. The corrected implementation passes that scenario. Temporary source/test copies were removed; `wa-opening-negative.log` retains the exact assertion.
- `vitest.config.ts` discovers only source tests and runs files serially. Stale emitted `dist` tests must not count as extra source coverage.
- One file-symlink test intentionally skips Windows; directory-junction denial runs. Linux CI must execute the file-symlink case.
- Mocks establish no real-model quality, device typing latency, 48-hour canary, week-long memory shadow, or customer-response SLI.

## Current requirement evidence

The structured coverage matrix keeps discovery, implementation, local and live status separate.

| Requirements | Current source evidence | Remaining acceptance |
|---|---|---|
| PDF-010–016 | Expanded modalities/claims, ASR work, interactive history, unsupported-media response | Real media/ASR and mixed-turn device trace |
| PDF-017–019 | Unknown-route quarantine, exact endpoint/account checks, fresh credential projection, typing port | Real rotation and sub-second device typing; canaries off |
| PDF-020–022 | Protected-field-aware tolerant parser, bounded retry/fallback, 800-token budget, durable recovery task/alert | Real fallback model, phone alert and reply |
| PDF-023–028 | Callback task, business-hour handoff recovery, execution principals and admission alerts | Canary, revoked-principal phone alert, unattended-hour cohort |
| PDF-029–038 | Claim token/renewal, expired final attempt, fair admission, ingestion separation, debounce/priority, outbox, unknown-send protection, LISTEN/polling | Live burst/crash latency and every superseded turn's final outcome |
| PDF-039–046 | Tenant/version top-eight FTS chunks/facts, revocation, multisource grounding, numeric/action guards, bounded context | Hebrew real corpus, unavailable-fact UI reasons, real-model quality |
| PDF-047–050 | Session admission, version model route, persisted golden-evaluation gates | Live refresh, 30 anonymized real cases/agent, human Hebrew scores/nightly run |
| PDF-051–060 | Sessions, 20-turn context, summary cursors, provenance, CRM precedence, human controls | Policy, week shadow, 50 human-reviewed cases; flags off |
| PDF-079–081 | Extraction schema/budget/field validation/protected-key plumbing | Actual ProTouch extraction/decryption/rotation; key presence alone insufficient |
| PDF-115–122 | SLI/model-usage/recovery/quality-memory structures | Required actual response, latency, no-silence, human accuracy, extraction/summary thresholds |

## Sanitized evidence

Local ignored evidence in `.artifacts/poc-rescue-local/`: `remote-inventory.txt`, `wa-remote-trace.txt`, `wa-remote-ingress.txt`, `wa-meta-subscriptions.txt`, `wa-live-test-ingress.txt`, `wa-live-boundary.txt`, `wa-registration-plan.txt`, `wa-effective-version.txt`, `wa-current.log`, `wa-opening2.log`, and `wa-current-final.log`.

No deployment, flag activation, outbound send or tenant reset was performed by this WhatsApp investigation. The parent's two user-approved registration attempts were rejected as recorded above. A newly created restricted PIN file is retained for a later explicitly approved operation; its value is not in these reports. Do not deregister or delete the existing WhatsApp account automatically.


## Coexistence support added locally on October 5

The user explicitly chose to preserve the WhatsApp Business phone app. Migration `8d32f4a91c70` and the new Coexistence importer provide default-off, exact WABA/phone/channel-bound receipts for account updates, history, contacts and phone-app echoes. Historical imports create useful CRM threads but never open a service window, grant consent, produce live memory attestation or enqueue automation. New human app replies immediately fence AI ownership; Cloud API message-ID matches and duplicate receipts preserve existing provenance and subsequent reviewed ownership changes. Account removal revokes only the affected channel.

`wa-coexistence9.log` verifies the fresh compiled CRM package against real PostgreSQL with the runtime web/worker roles: three tests pass, including a 205-message history burst, disabled queued receipts, account mismatch rejection, media-before-history retry, contact tombstones, Cloud API echo deduplication, human ownership, replay after AI resume and zero jobs/model/provider sends. Typecheck, scoped ESLint and Ruff passed. Full worker and existing CRM webhook regressions are being recorded separately. Earlier focused runs before the explicit CRM rebuild are not final-source evidence.

See [COEXISTENCE-GAP.md](COEXISTENCE-GAP.md) for boundaries and activation work. Pending provider asset IDs must be reverified against the actual Embedded Signup result and exchanged credential. No live subscription, deployment or Coexistence import was enabled by this implementation.

Review follow-up: human app replies also set a persistent handoff reason, preventing automatic default-agent reassignment on the next customer turn. The dedicated test first proves that default assignment works, then proves the app reply blocks it and that an explicit CRM resume remains possible. `wa-coexistence-human3.log` passes all four focused Coexistence/memory-context tests after making the latter fixture self-contained. The importer uses `FOR NO KEY UPDATE` on the channel so a concurrent live first-contact insert can acquire its foreign-key lock; the final fixture adds an actual competing-transaction probe. The earlier full run had 663 passes, one fixture dependency failure and one Windows-only skip; a fresh full rerun follows this checkpoint.

Final runtime checkpoint `0331908` adds capability-aware claims in migration `9e43a5b02d81`; four focused tests pass in `wa-coexistence-compat.log`. The actual old worker initially rejected the new receipt types, then left them untouched after the additive migration while processing ordinary text. New readiness rejects missing or denied four-argument capability. The actual concurrent first-contact probe also passes: live ingress obtains its FK lock while history waits on the identity, then durable retry retains both messages. Production worker build now excludes source test files and passes.

The actual old web parser still misclassifies historical media; full old-web rollback after Coexistence activation is explicitly unsupported. The normalized old ingress contract has lost the source field, so no heuristic database reclassification is claimed. See the compatibility section in [COEXISTENCE-GAP.md](COEXISTENCE-GAP.md). The fresh full suite at final head is recorded under `wa-coexistence-head9e-full`; the preceding run was deliberately stopped when the additive migration changed the runtime contract.

Verification follow-up: `wa-coexistence-head9e-full.log` completed with 662 passes, two failures and one Windows skip. A focused run without Coexistence reproduced shared FAIR-database leakage across session/fairness scenarios. Test fixtures now clone a migrated empty database per scenario, preserving global claim and blocked-model assertions, and always drop only their own UUID database. The bound-model fixture also waits up to five seconds for asynchronous credential admission instead of assuming it starts within 200 ms. All five affected files pass their 15 scenarios in `wa-fair-isolated2.log`; the full final run is `wa-coexistence-final-isolated`. These changes affect tests only; runtime remains `0331908`.

**Final complete worker result:** `wa-coexistence-final-isolated.log` passes all 70 source test files: **664 passed, one intentional Windows file-symlink skip, zero failures** (665 source cases; 398.64 seconds). Runtime is `0331908`; test-fixture isolation is `269665e`. This includes all five opening-worker cases, the Coexistence capability/concurrency scenario, session memory and all fairness/model-routing scenarios. Compiled `dist` tests are excluded. The harness removed its disposable databases; no provider credentials or external sends were used. Worker typecheck, scoped ESLint and documentation checks also pass. The separate Linux same-runtime spool check is recorded by the parent in final verification.
