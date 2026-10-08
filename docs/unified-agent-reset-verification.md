# Unified agent reset — local verification and activation package

Status: **WORK IN PROGRESS — not ready for activation review**.
This report belongs to branch `codex/unified-agent-reset`, based on
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
- Explicit voice model references were not resolved through the tenant's bound
  encrypted credential. The voice projection now validates the immutable call
  binding and current authority, then reserves quota for each physical attempt.
- A model-name replacement did not update Gemini parameters or retry behavior.
  Capability mapping is shared through generated policy; fallback recomputes
  settings and never replays a response after partial speech or tool output.
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
Production counts must be refreshed under read-only access immediately before
approval; old exported counts are not an activation precondition substitute.

## Local evidence

The owned PostgreSQL 18.6 instance is loopback-only on port 55481. Tests create
fictional data and exercise `platform_web`, `platform_messaging` and
`platform_voice`; they do not run application work as a superuser. Normal
provider boundaries are fakes. Paid model evaluations and offline TTS generation
are separate, explicitly opted-in operations.

Evidence is retained in ignored `.artifacts/` files. Counts below are checkpoints,
not a claim that all final-head gates have passed:

- Full web build passed at checkpoint r5 (`checks-r5.log`).
- The requested existing model suites passed 25/25 for each model at r3.
- The shared discovery corpus passed 20/20 for each model in the WhatsApp
  adapter at r5. Voice r5 passed 39/40: fallback model missed a supplied name
  correction. A shared instruction correction is being validated.
- Streaming fallback regression checks cover empty/truncated output and prohibit
  retry after partial output. Seven focused Python tests passed at r6.
- Local downgrade to `f3a8c2d91750` and re-upgrade to `a07b3d42ec91` passed.
- Full database and final integration gates are still being run. Skips are not
  counted as passing integration tests.

Live browser inspection is **NOT RUN**: automatic approval review rejected both
the initial local server start and a subsequent least-privilege local connection
with “blocked by policy”, without a detailed reason. No alternate server-start
mechanism has been used to bypass that rejection. Browser/mobile acceptance
remains a required gate.

Real customer call/message acceptance and human audio listening are **NOT RUN**.
Offline sample format checks and synthetic provider success do not establish
real call, pronunciation or Meta delivery acceptance.

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

## Outstanding acceptance

Final-head lint/type/tests/build/parity, complete database delivery failure
matrix, voice correction regression evaluation, explicit custom-model coverage
for field-service extraction, complete local activation rehearsal, mobile
browser acceptance, human sample listening and separately approved real provider
smoke checks remain tracked work. No activation request is made by this report.
