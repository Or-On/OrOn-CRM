# Unified agent reset — local verification and activation package

Status: **Implemented locally; activation review blocked by required browser acceptance**.
Implementation commits: `957b1b5`, `5f3e89c` and `e5937d0` on
`codex/unified-agent-reset`, based on
`a78d3b9cd3b1de1e1ab918729fd87e1401efa326`. No production configuration or data has
been changed by this work. The original checkout remains separate.

## Scope and business source

The supplied plan contains the shared OrOn service-discovery requirement and
five detailed tasks. Tasks 6–8 were absent and are not claimed as implemented.
ProTouch retains its distinct digital-service-form workflow.

The resolved OrOn tenant is `00000000-0000-0000-0000-000000000001`. The retained
profile is `77eb1e6a-2e96-4264-8f6b-859b0dd963ae`. The service catalog is the
existing tenant support profile, exported as business facts to
`infra/tenant-configurations/oron.service-catalog.json`, with its source hash.
The canonical business definition remains
`infra/tenant-configurations/oron.whatsapp-lead.agent.json`; the historical
filename does not restrict its new voice and WhatsApp capabilities. No platform
runtime chooses behavior from the tenant's slug or company name.

The compiled instructions use `composeAgentInstructions` for both channels.
Voice publication retains `voiceInstructions` from that compiler; the retained
executable shell is `infra/tenant-configurations/shared-agent.voice-flow.json`.
It has no second service script, hard-coded questionnaire or separate closing.

## Confirmed defects and corrections

- The old tenant definition forbade substantive service discussion and treated
  any answer as a service choice. It has been replaced by discovery, discussion
  and receipt-backed finalization stages, with an immutable completion policy.
- Old global redirects and voice flow instructions could compete with the
  configured business purpose. Shared generated policy now redirects to services.
- A Hebrew action detector matched “מאושר” as “אושר”, rejecting an honest price
  limitation and a valid service comparison after generation. Word boundaries
  now preserve that answer while retaining unsupported-action rejection.
- Saving fields and finalizing were too easily conflated. Finalization requires
  persisted readiness, permitted contact and a durable review item. A failed
  save cannot enter an endless same-turn action loop.
- A valid neutral Hebrew service answer could be discarded for a slash-form
  pronoun; a narrow grammatical repair preserves that answer before all remaining
  grounding checks. Failed lead writes now return the canonical honest failure
  without another model call. Voice failures are announced once per failed turn.
- Explicit voice model references were not resolved through the tenant's bound
  encrypted credential. The voice projection now validates the immutable call
  binding and current authority, then reserves quota for each physical attempt.
- A model-name replacement did not update Gemini parameters or retry behavior.
  Capability mapping is shared through generated policy; fallback recomputes
  settings and never replays a response after partial speech or tool output.
- The new profile inherited a 256-token voice quality budget even though the
  multi-field tool evaluations used 2,048. The reset now stores the reviewed
  2,048-token budget in its new immutable quality snapshot, preserves the old
  version, and rejects an explicitly configured model with a lower cap. Typed
  worker configuration now propagates the token ceiling and request deadline
  to the default and explicit routes; reviewed explicit settings still override
  these defaults. The reset rejects an explicit model cap below its reviewed
  profile budget rather than silently raising a custom limit.
- Field intake now resolves explicit tenant model credentials and limits, with
  a fresh authority/snapshot/quota check for every physical attempt, including
  fallback. A missing or disabled explicit route cannot borrow a deployment key.
- Field-service semantic validation ran after attempt success. It now runs
  inside each attempt. Attempt start/completion audit records distinguish
  unknown usage after a crash; permissions are checked before fallback too.
- A definite failure of the outbound job could leave intake admission looking
  successful. Terminal send failures now propagate to intake visibility. Staff
  recovery allocates a new immutable attempt; unknown outcomes prohibit resend.
- Staff recovery for a form originating in WhatsApp incorrectly assumed a
  voice session. It now uses the immutable original inbound sender and channel.
- The form picker replaced previous selections and the address had no city
  contract. New forms append photos and require street/city; versioned legacy
  tokens retain their existing submission contract.

## Runtime mapping and cutover

| Surface                | Before                                                      | Prepared behavior                                                            |
| ---------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| OrOn WhatsApp          | short-enquiry v6, pinned old chats                          | reviewed shared agent version and canonical flow                             |
| OrOn voice             | v4 bound to retained scripted v3, deployment model default  | same shared agent with reviewed executable shell                             |
| ProTouch               | tenant-specific service form                                | same business purpose, corrected form/delivery infrastructure                |
| TTS                    | flow/quality/context override plus legacy prerecorded voice | Harper / Soniox `tts-rt-v2`, including preview and announcements             |
| Gemini default         | previous 2.5 route                                          | 3.5 Flash-Lite, bounded 3.1 Flash-Lite fallback                              |
| Explicit custom models | immutable existing IDs                                      | individually reviewed clone and resealed credential; never a blanket rewrite |

The default cutover preserves every existing conversation and active call's
binding. New conversations/calls use the newly approved process bindings.
Human ownership remains sticky. Existing AI chats change only with the explicit
`--rebind-existing-ai` rehearsal option, which applies to the selected profile;
the ownership epoch fences stale jobs. The inventory records retained counts.
The synthetic cutover retained **one old-version AI conversation, one human
conversation and one active old-version call**. Explicit rebind moved only the
AI conversation and incremented its epoch. Rollback restored the previous
configuration as a new release and preserved these conversation/call bindings.
Production counts must be refreshed under read-only access immediately before
approval; old exported counts are not an activation precondition substitute.

## Local evidence

The owned PostgreSQL 18.6 instance is loopback-only on port 55481. Tests create
fictional data and exercise `platform_web`, `platform_messaging` and
`platform_voice`; they do not run application work as a superuser. Normal
provider boundaries are fakes. Paid model evaluations and offline TTS generation
are separate, explicitly opted-in operations.

Retained review evidence is in [evidence/unified-agent-reset](evidence/unified-agent-reset/).
Full command output and previous failing runs remain in ignored `.artifacts/`.
Normal tests never use provider credentials. Do not add these counts together:
several suites overlap.

| Gate | Measured result | Local raw evidence |
| --- | --- | --- |
| TypeScript format, ESLint, repository/docs/secret checks, Ruff, TS and Python types | Passed | `verify-final-r24.log` |
| Normal Python | 2,194 passed, 461 deliberately skipped | `verify-final-r24.log` |
| Normal web | 1,040 passed, 14 skipped | `verify-final-r24.log` |
| Normal messaging worker | 584 passed, 230 skipped | `verify-final-r24.log` |
| Full Python PostgreSQL | **440 passed, zero skipped** | `postgres-r15.log` |
| CRM application-role PostgreSQL | 771 passed, 18 skipped; those 18 separately passed below | `application-role-pg-r12.log` |
| Publication quality gate, knowledge and handoff PostgreSQL | **18 passed** | `quality-pg-r15.log` |
| OAuth + durable worker checks in application-role runner | 1 + 5 passed | `application-role-pg-r12.log` |
| Full messaging worker with explicit local database fixtures | **795 passed, 19 skipped**; 18 separately passed, one POSIX-only check remains skipped | `messaging-pg-r18.log` |
| Form-link lifecycle, submission, recovery and tenant isolation | **18 passed** | `service-form-r16.log` |
| Model routing, quota, key rotation, concurrent workers, machine-tool revocation | **29 passed**, including new pending-trigger denial | `model-machine-pg-r17.log` |
| Reset, retained conversations/call, explicit rebind and rollback | **1 passed**, real PostgreSQL | `reset-rehearsal-r24.json` |
| Upgrade → downgrade to `f3a8c2d91750` → upgrade; deterministic SQL + contract | Passed, **164 revisions, one head `a18c4e53fd02`** | `migration-cycle-r15.log` |
| Generated API contract, production web/workspace build, peer dependencies | Passed | `verify-final-r24.log` |
| Dependency audits | Repository gate passed; **9 npm findings (4 high, 4 moderate, 1 low), no critical**. Python: one existing time-limited exception, no other known findings | `verify-final-r24.log` |

`uv run python -m scripts.dev verify` is the Makefile's actual verify entry point.
The final r24 invocation completed **all phases uninterrupted, exit code 0**
on the current implementation, including the corrected token budget and explicit
provider route. This is a local verification result, not a remote CI run.
Earlier r15/r16 logs retain the transient Windows generated-file write failure
and its recovery. Skipped normal integration tests are not reported as passing;
explicit database runs supply separate evidence. The final configuration suite
passed all 56 tests, including token and timeout validation.

The full messaging run passed **795 tests**, with 19 explicitly skipped.
The 12 readiness and 6 diagnostics tests subsequently passed in their required
owned fixtures (`worker-readiness-r20.log`, `messaging-diagnostics-r19.log`).
The remaining POSIX file-permission test is intentionally skipped on Windows;
it is **NOT RUN on Linux** in this local session. No database test in that suite
remains hidden by an unset URL. Two fixture corrections preserve, rather than relax, production
validation: use an endpoint-compatible Gemini model name and mark real inbound
fixtures `received`. A new negative case proves `pending` is refused. The form
suite's timeout is 30 seconds because each case drives several durable jobs;
its previous 5-second timeout abandoned a worker that then consumed the next
fixture. Provider-call counts and all security assertions remain intact.

### Real model evaluation

[Model evidence](evidence/unified-agent-reset/model-evaluations.json) includes
model names, prompt/source digests, environment, physical-attempt counts and
latency. [Synthetic conversations](evidence/unified-agent-reset/synthetic-conversations.json)
retain final filtered replies, actions, captured facts and outcomes.

| Channel | Model | Corpus | Inference p50 / p95 |
| --- | --- | --- | --- |
| WhatsApp | gemini-3.5-flash-lite | 20/20 | 1,179 / 1,791 ms |
| WhatsApp | gemini-3.1-flash-lite | 20/20 | 1,543 / 3,075 ms |
| Voice adapter | gemini-3.5-flash-lite | 20/20 | 974 / 1,280 ms |
| Voice adapter | gemini-3.1-flash-lite | 20/20 | 1,222 / 1,723 ms |

Existing `oron-agent` and `oron-flows` provider suites also passed **25/25 for
each model**, zero skips. Their p50/p95 values measure whole test duration,
not individual inference. See [the separate report](evidence/unified-agent-reset/existing-model-suites.json).
Discovery latency is nearest-rank per physical inference attempt, including
failed attempts. It excludes transport, speech recognition and synthesis.
These evaluations use real Google inference with synthetic stores; durable
PostgreSQL outcomes are established separately. They do not prove a complete
real telephone or WhatsApp exchange.

Earlier failures were retained. Voice r10 measured 38/40 with an evaluator that
omitted text accompanying tool calls. The corrected r11 captures such text and
filters it **before** tool execution, so later success cannot license an earlier
claim. After correcting the deployed profile token ceiling, r22 repeated both full
corpora with a 2,048-token ceiling and 5-second request deadline; these are the
reported source runs. One successful
corpus is not a guarantee of deterministic model behavior.

Live browser inspection is **NOT RUN**: automatic approval review rejected both
the initial local server start and a subsequent least-privilege local connection
with “blocked by policy”, without a detailed reason. No alternate server-start
mechanism has been used to bypass that rejection. Browser/mobile acceptance
remains a required gate.

Real customer call/message acceptance and human audio listening are **NOT RUN**.
Offline sample format checks and synthetic provider success do not establish
real call, pronunciation or Meta delivery acceptance.

## Reproduction and runtime changes

Commands were run with Node 24.20.0, pnpm 11.24.0, Python 3.14.7,
`PYTHONUTF8=1`, and PostgreSQL 18.6. No operational `.env` was copied into the
worktree. Set database variables only to the owned fictional loopback fixtures.

```powershell
uv run python -m scripts.dev verify
uv run pytest db/tests/postgres -q --tb=short
uv run python scripts/preview_ui.py --check-db
uv run python scripts/preview_ui.py --check-messaging
pnpm --filter @or-on/messaging-worker exec vitest run
pnpm --filter @or-on/crm exec vitest run src/agent-reset.postgres.test.ts
uv run python scripts/generate_agent_policy.py --check
uv run python scripts/generate_runtime_policy.py --check
uv run python scripts/db_verify.py offline
```

The database runs require explicit variables: `TEST_DATABASE_URL`,
`CRM_TEST_DATABASE_URL`, `CROSS_CHANNEL_TEST_DATABASE_URL`,
`MESSAGING_WORKER_TEST_DATABASE_URL`, `PRINCIPAL_TEST_DATABASE_URL`,
`MACHINE_TOOLS_TEST_DATABASE_URL`, `OPENING_MENU_TEST_DATABASE_URL`,
`FAIR_TEST_DATABASE_URL`, `READINESS_POSTGRES_URL`, and
`AGENT_QUALITY_GATE_TEST_DATABASE_URL`, as applicable. Preserve each test's
owned-name/port guard. Fairness tests use a dedicated `oron_fair_<uuid>`
template; other guarded worker tests use `oron_crm_<uuid>` on port 55480;
quality/readiness tests use an owned `oron_ui_preview_<uuid>` parent. The
preview runner creates and drops its own database and restricted login.
Do not pass one common database URL blindly to every suite.

Real-model commands are deliberately separate from normal verification:

```powershell
uv run python scripts/run_discovery_evals.py --allow-provider-evals --env-file LOCAL_SECRET_FILE --output UNUSED_OUTPUT_DIRECTORY
uv run python scripts/eval_service_discovery_voice.py --allow-provider-evals --env-file LOCAL_SECRET_FILE --output SAME_OUTPUT_DIRECTORY
uv run python scripts/run_requested_model_evals.py --allow-provider-evals --env-file LOCAL_SECRET_FILE --output ANOTHER_UNUSED_DIRECTORY
```

Both channel adapters retain the same canonical business definition. Deployment
configuration sets `LLM_PROVIDER=openai-compat`, Google's OpenAI-compatible
endpoint, `LLM_MODEL=gemini-3.5-flash-lite`,
`LLM_FALLBACK_MODEL=gemini-3.1-flash-lite`, `LLM_MAX_TOKENS=2048`, `LLM_REQUEST_TIMEOUT_SECS=5`, and minimal thinking.
The previously read local configuration used 256 tokens; retaining that override
would still truncate tool calls. The activation review must verify the deployed
environment and profile budget together. Model-specific
payload mapping omits unsupported 3.5 temperature settings. Explicit tenant
configurations require a reviewed clone; an environment change cannot rewrite
immutable references. The dispatcher now requires access to the same existing
model-credential encryption key through its secret configuration. Do not rotate
or print that key as part of this change. Harper is canonical in runtime,
preview, and lifecycle audio. Reload worker/dispatcher processes after a
reviewed configuration activation so cached settings cannot preserve an old
route.

The existing `scripts/deploy_gcp_manual.py` supports an exact green Main SHA,
expected current SHA and CI run ID. It remains unchanged and was **not executed**.
After a future reviewed merge and separate deployment authorization, its default
read-only plan must be checked before `--execute`. This feature branch has no
Main commit or CI run to substitute for those arguments.

## Rehearsal and activation sequence

1. Inspect and retain the deployed code tag, Alembic revision, tenant release,
   effective bindings, voice flow snapshots, model IDs, menu/greeting settings,
   ownership counts and durable database backup. Store secrets separately in the
   existing secret store. Verify restore capability before activation approval.
2. Apply the serial migrations from `f4b9d1e62080` through the final reviewed
   branch head to an isolated copy first. Run upgrade/down/re-upgrade and real
   role tests. Review new-form versus legacy-token behavior.
3. Register the reviewed executable voice shell as a new retained version; do
   not overwrite the old flow. Construct a plan using its exact ID/version and
   spec digest, catalog digest, current agent version and release revision.
4. Where an explicit model is configured, use `scripts/clone_tenant_model.ts`
   to inspect and rehearse a tenant-specific clone. It reseals the existing key
   for fresh configuration/credential IDs and preserves historical references.
   Record the new reviewed ID in `reviewedModelConfigurationId`.
5. Use `scripts/reset_tenant_agent.ts` in order: `inspect`, `prepare`, `publish`,
   `activate`. The CLI requires a local `oron_*` database. Mutation phases need
   `--apply-local`; every phase requires an unused evidence output path.
   Publishing still requires the existing golden evaluation evidence. Never
   disable that gate or manufacture a passing publication artifact.
6. Inspect the resulting release, new-conversation routing and deliberately
   retained bindings. Prove explicit old-chat rebind and stale-job denial in the
   local rehearsal before selecting any production rebind scope.
7. Only after final local gates and separate activation approval: deploy the
   reviewed exact code head, apply migrations, install the reviewed release and
   model references, and restart workers/dispatcher to refresh environment and
   credential caches. Verify actual effective model/voice/prompt per channel.
8. Keep the three-parameter service template v2 disabled until its real Meta
   approval is documented. Existing approved one-parameter v1 stays supported.
   Missing business phone blocks v2; it must never send the wrong parameter count.

Rehearsal command shape (fill IDs from the synthetic inventory, not production):

```powershell
pnpm exec tsx scripts/reset_tenant_agent.ts --plan PLAN.json --actor ACTOR_UUID --output INVENTORY.json
pnpm exec tsx scripts/reset_tenant_agent.ts --plan PLAN.json --actor ACTOR_UUID --phase prepare --apply-local --output PREPARED.json
```

Publication takes the prepared `--agent-version` and `--flow-definition` IDs.
Activation takes `--agent-version` and the published `--flow-version` ID. The
tools deliberately reject nonlocal databases; production activation must use
the reviewed platform workflow after separate authorization.

## Rollback

The local rehearsal CLI now provides a tested `rollback` phase. It reads only
the captured activation audit, requires the original plan digest and current
release ID, rejects an intervening draft/release change, and restores the old
configuration through a fresh submit/approve release. Reusing the same rollback
operation is idempotent. It does not rebind existing chats or active calls.

```powershell
pnpm exec tsx scripts/reset_tenant_agent.ts --plan PLAN.json --actor ACTOR_UUID --phase rollback --apply-local --expected-active-release RELEASE_UUID --rollback-operation NEW_OPERATION_UUID --output ROLLBACK.json
```

IDs must come from that rehearsal's retained output. The same local-database
restriction applies; this is not a production deployment command.


Stop new admissions if needed and preserve already admitted provider outcomes.
Restore the prior process configuration through a **new reviewed release** using
the captured `rollbackConfiguration`, rather than editing published history.
Restore the old environment/model route and code tag together, restart workers,
and verify effective references. Existing sessions stay pinned; rebind only an
explicitly reviewed set of AI chats. Preserve human ownership and audit history.

Do not casually downgrade production schema: a code tag cannot restore data or
configuration. The tested Alembic downgrade is for isolated rehearsal. Review
retained city/form-version/accounting data and take a verified backup before any
production schema rollback. Preserve token and provider-outcome uncertainty.

## Acceptance matrix and remaining boundaries

| Scope | Implemented / local evidence | Provider evidence | Activation |
| --- | --- | --- | --- |
| Shared OrOn three-stage agent | Canonical compiler, immutable schema/readiness, receipt-backed closing, PostgreSQL and both adapters | Both Google models, 80/80 scenarios; 50/50 existing evaluations | Pending; golden publication gate remains enabled where configured |
| 1. Unified female voice | Harper across runtime, preview, read-only selector and five announcements; PCM format/duration checked | Actual offline Soniox samples generated | Human listening and real-call acceptance NOT RUN |
| 2. Model migration | Default + explicit WA/voice/field-intake routes, bounded fallback, quotas and per-attempt accounting | Real inference on both requested models | Operational model clone/bind/restart pending |
| 3. Hebrew form | Hebrew/RTL component/API tests, append/remove photos, versioned address/legacy payload, PostgreSQL persistence/export | None required for local form | **Mobile/browser check blocked** |
| 4. Reliable delivery | Two-job admission/send, safe retries, consent/recipient/window rechecks, unknown-outcome fence, immutable brand snapshot | Real Meta transport NOT RUN; provider fakes in database tests | v2 template disabled until separately approved |
| 5. Incomplete requests | Tenant-scoped BFF/RLS/actions, no premature ticket, exact 15-minute badge boundary | Not a provider operation | **Browser case-screen check blocked** |
| 6–8 | **Not supplied** | Not claimed | Not claimed |

There is no production deployment, configuration mutation, main push or merge.
The runtime, migrations and generated contracts are integrated in one branch
because they share a serial schema lineage and one canonical policy; separate
independent PRs would create misleading partially deployable heads. Follow-up
verification and rollback work is a separate commit on that same branch.

Before activation review, complete the real mobile/browser form and case-screen
checks after the local-server approval block is resolved. Listen to
[Harper](../voice-samples/harper.wav) and [Grace](../voice-samples/grace.wav), then
complete separately authorized transport smoke tests. Refresh the operational
inventory and backup/restore evidence. No new approval is requested while these
required gates are still incomplete.
