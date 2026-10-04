# Voice verification — 2026-10-04 (Asia/Jerusalem)

Base: `3582027b`, shared review branch `codex/poc-rescue-local-20261004`.
The changes below were tested locally. No deployment, SIP mutation, DID
assignment, telephone call, or customer message was performed. Provider
inventory and synthetic model inference are distinguished below.

## Reproduced routing defect and actual configuration

The authenticated web real-call route derives tenant scope through
`withCurrentTenant("voice:operate")`, checks the tenant-owned contact and
consent, pins canonical published agent/flow versions, and issues a dispatcher
grant. The dispatcher derives `tenant_id` from that verified grant, not a
request-body tenant. The first demonstrated loss of tenant-specific routing
was `dispatcher_runtime/main.py`: it created one `SipClient` from global
`SIP_OUTBOUND_TRUNK_ID`. `Dispatcher.place_outbound_call` supplied no tenant
binding or caller ID to `SipClient.dial`. The LiveKit request supplied only the
global trunk, allowing its default number to become the sender for every
tenant. The contact call dialog uses that web route; the messaging worker's
`call-provider.ts` also calls the same dispatcher endpoint with its signed
tenant/job context. Ticket entry-point browser behavior remains unverified.
The control-api simulation job is a distinct simulator-only path.

Read-only provider inventory with existing local credentials succeeded:

| Boundary | Observed result | Evidence level |
|---|---|---|
| LiveKit outbound trunks | One: `ST_hMBmL3fQMdFu`, `oron-twilio-outbound`; only allowed number `***5689`; matches global trunk | Actual provider API read |
| LiveKit inbound trunks | Zero | Actual provider API read |
| LiveKit dispatch rules | Zero | Actual provider API read |
| Carrier endpoint | `oron-campaign-1543.pstn.twilio.com` | Actual provider API read |
| Twilio account | Reference `***fba51d` owns voice numbers `***5689` and `***4553`; local caller-ID config matches `***5689` | Actual provider API read |
| ProTouch draft | Its caller ID is also `***5689` and its endpoint matches Or-On. Only its SIP username differs; file explicitly is not loaded | Source/config evidence |
| Local tenants | `default` and `or-on-workspace`; no ProTouch (parent inventory) | Actual local DB read |

The second Twilio number is **not** evidence of ProTouch ownership. No number
was assigned from its name, order, or availability. There is no verified
ProTouch DID/outbound binding in this provider project. The reported wrong
caller-ID mechanism is reproduced at the source/provider boundary; an actual
ProTouch telephone call and recipient-observed caller ID remain unverified.

## Fix and activation requirements

`VOICE_OUTBOUND_ROUTES_JSON` provides immutable deployment bindings with
`tenant_id`, non-secret `account_ref`, `trunk_id`, `from_number`, and expected
carrier `address`. Strict parsing rejects duplicate tenants/senders and
inconsistent shared-trunk/account mappings. Missing routes fail closed; the
legacy global trunk cannot authorize a tenant. The lowest SIP boundary
rechecks the requested tenant/route, reads current provider trunk inventory
without a cache, checks endpoint and allowed sender membership, and sets
`sip_number` explicitly. A read/auth failure also blocks dialing with a safe
error. API denials log the tenant and safe reason.

The selected sender and safe account/trunk references travel in call context.
The sender is persisted through existing encrypted phone handling; admission
events contain only safe account/trunk references. Durable and active-call
idempotency checks now reject a different sender/account/trunk for the same
key. No schema migration was needed. Provider carrier credentials remain in
the reviewed LiveKit trunk, behind deployment LiveKit credentials.

Existing LiveKit credentials are shared project infrastructure, with explicit
per-tenant carrier routes required. Route configuration is read at startup:
review actual tenant ownership, configure each permitted route, restart the
dispatcher, and inspect readiness before authorized calls. Editing a draft or
setting `SIP_OUTBOUND_TRUNK_ID` does not activate a route. No production
tenant mapping was guessed from the two local fixture-like tenant names.
This means existing installations must supply explicit routes before real
outbound calls can resume. The runbook and deployment env path were updated.

## Additional demonstrated fixes

* PDF-064: the bot previously staged recordings under OS temp regardless of
  `ARTIFACTS_LOCAL_ROOT` and retained successful staging copies. It now stages
  under the configured root's `.staging`, deleting only its owned UUID tree
  after both upload and durable session finalization. Failure paths retain
  recoverable files. The configured root still must be on a persistent volume.
* PDF-067: a transient operator-control read error previously permanently
  blocked the current epoch. The call now pauses during the outage and can
  recover only after a fresh authorized snapshot and successful exact-epoch
  acknowledgement. Explicit pause, revocation, takeover, stale acknowledgements
  and local cancellation-barrier failures cannot reopen AI.
* Real-model evaluation reproduced three failures. Tool descriptors concealed
  reviewed field types, so Gemini passed Hebrew number words to strict numeric
  fields; validation rejected the complete batch. Follow-up descriptions also
  allowed a completed inquiry to stay `collecting`. Descriptors now expose the
  reviewed field types/choices and numeric serialization rules, and distinguish
  finalizing a completed inquiry from requesting follow-up. Validation,
  permissions and durable receipt requirements are unchanged. These tools
  remain available only to agents with their published lead capabilities.

## Executed checks

| Command / scope | Result | Meaning |
|---|---|---|
| `python -m pytest packages/py/oron-dispatcher/tests services/py/dispatcher/tests -q` | 100 passed, 0 skipped | Fake-provider boundary tests; no SIP calls |
| `uv run --no-sync python .artifacts/poc_rescue_verify.py voice-db uv run --no-sync pytest db/tests/postgres/test_voice_phone_number_isolation.py db/tests/postgres/test_voice_jobs.py db/tests/postgres/test_voice_control.py db/tests/postgres/test_voice_handoff_verification.py db/tests/postgres/test_voice_service_intake_runtime.py db/tests/postgres/test_voice_quality_runtime.py -q` | 28 passed, 0 skipped; fresh migration succeeded | Real disposable PostgreSQL, DID isolation, jobs, controls, verification, intake, quality |
| Same disposable harness, `voice-admission-db`, `test_voice_quality_runtime.py` after routing fingerprint change | 3 passed, 0 skipped | Independent transaction concurrency, replay, modified from/account/trunk rejection, safe event payload |
| `python -m pytest packages/py/oron-agent/tests -q` | 981 passed, 16 skipped | Offline agent regression; skips are explicitly gated model evals |
| Agent artifact/control focused tests | 36 passed | Includes 20 actual local WAV/transcript copy-cleanup lifecycles, pause/revocation/recovery |
| Lead contract/tools/scenario tests after model-description fix | 134 passed | Deterministic normalization/receipt regression |
| `ORON_RUN_PROVIDER_EVALS=true ... pytest .../eval/test_lead_capture_eval.py .../eval/test_support_progress_eval.py -q` before fix | 17 passed, 3 failed, 0 skipped | 16 synthetic real-model cases plus 4 static checks; configured `gemini-2.5-flash` |
| Same real-model suite after fix | 20 passed, 0 skipped, 29.25 seconds | All 16 existing synthetic provider cases passed once; no customer/PSTN traffic |
| Ruff over dispatcher, agent, runtime and changed DB test; pyrefly over owned runtime sources | Clean / 0 errors | Static checks; pyrefly reports 4 existing suppressions |
| Final combined dispatcher + agent + runtime Python suite | 1,081 passed, 16 explicitly gated eval skips, 24.17 seconds | All 16 skipped model cases separately executed successfully above |

Logs: `.artifacts/poc-rescue-local/voice-db*.log`,
`voice-admission-db*.log`, `voice-real-model.log` (initial failures retained),
`voice-model-diagnostic.json` (fictional model traces), and
`voice-real-model-after.log`. Disposable databases were removed by their
owning harness; the original DB was not changed. Full regression rerun status
is recorded by the parent checkpoint.

The 20 artifact lifecycles are not 20 full voice calls or a memory-load test.
The 16 real-model synthetic cases are not the required 30 real anonymized
conversations per agent, human Hebrew scoring, or a measured accuracy SLI.

## Open voice gates

| Requirement | Current state and next evidence required |
|---|---|
| ProTouch/Or-On caller ID and all real-call entry points | Local routing fix verified; actual tenant bindings/restart and recipient-observed calls remain BLOCKED pending correct ProTouch DID/account binding and approved test recipients |
| Effective agent version / old v3 report | Source and DB tests pin exact versions and reject ambiguous bindings; actual ProTouch runtime version not measured because local tenant/runtime binding is absent |
| PDF-061 inbound provisioning | BLOCKED: actual provider inventory contains no inbound trunks/rules. Provider mutation requires reviewed DID/account mapping and go-live gate |
| PDF-062 public webhook | Parent owns Caddy/network fix. Signed provider callback over deployed ingress not verified by this work |
| PDF-063 global/per-tenant caps with spoken busy | NOT_CHECKED at provider; current dispatcher has no demonstrated global/per-tenant cap or audible busy path |
| PDF-064 recordings | Local staging/copy-cleanup verified; deployed persistent mount, actual recordings and failure recovery still need runtime evidence; whole-call audio buffering remains a capacity risk |
| PDF-065 drain/goodbye | Not implemented/verified as an orderly spoken deployment drain; do not enable inbound |
| PDF-066 stale sweeper | Existing DB/runtime tests cover persistence; deployed scheduling and live-call-safe deploy wait unverified |
| PDF-067 read recovery | VERIFIED_LOCAL, explicit control barriers retained; live audible recovery not verified |
| PDF-068 model/TTS fallback, PDF-071 unpublished-agent spoken fallback | No audible provider evidence; startup failure still blocks/hangs up safely, which is not the requested spoken fallback |
| PDF-069 idle/VAD | Existing offline agent tests pass; long real Hebrew call listening not done |
| PDF-070 quick webhook acknowledgement | Existing handler awaits agent startup; durable asynchronous startup/latency gate still open |
| PDF-072–075 warmup/streaming/cache/polling performance | Not measured live; current control poll default 0.5s and usage checkpoint 1s remain, so target 2–5s/15s not met |
| PDF-076 caller identity and PDF-077 continuity | Real DB isolation/verification tests passed; cross-channel live continuity and summaries not demonstrated |
| PDF-123–126 voice activation/load/latency | BLOCKED: no 20 real inbound calls per DID, cap+1 audible busy, active-call deployment or end-of-speech timing. Inbound must remain disabled |
| PDF-110 canary/48h | No deployment or 48-hour observation occurred; local test success does not authorize broad live activation |

Owned source areas: `packages/py/oron-dispatcher`, selected
`packages/py/oron-agent` artifact/control/lead descriptor files,
`services/py/dispatcher`, and the admission test in
`db/tests/postgres/test_voice_quality_runtime.py`. No TS CRM/web, schema,
carrier or production mutations were made by this workstream.
