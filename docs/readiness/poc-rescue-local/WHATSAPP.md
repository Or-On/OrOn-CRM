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

