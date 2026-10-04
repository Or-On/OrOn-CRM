# Voice verification — 2026-10-04 (Asia/Jerusalem)

Initial base: `3582027b`; checkpoint `86c3641`; newer authoritative
`origin/main`/deployed source `42eebac2` subsequently merged into the shared
review branch `codex/poc-rescue-local-20261004`. The per-requirement table below
reflects that newer source, preserving its existing caps, drain, announcements,
durable webhook pump, memory and knowledge protections.
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
| Authoritative active ProTouch | `633d9906-3866-4ddd-b85c-99c525bd3cb3`; Or-On `00000000-0000-0000-0000-000000000001` | Actual remote DB read obtained by parent; deleted older ProTouch excluded |

The user subsequently confirmed `***4553` as ProTouch's source number and
approved test recipient `***7692`. Read-only carrier inspection then verified
that sender belongs to separate trunk `TK8063d67ba0b48332a7a49024dbb164aa`,
named `protouch`, whose termination endpoint is absent and whose credential
list is not associated. The existing account credential list contains the
ProTouch SIP username, with its password present in the ignored local bundle.
ProTouch inbound origination targets a different server from Or-On; it was
not changed. The concrete separately reviewed provider plan is
[PROTOUCH-OUTBOUND-PLAN.md](PROTOUCH-OUTBOUND-PLAN.md). There is not yet an
operational ProTouch LiveKit outbound binding. The reported wrong
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
tenant mapping was guessed from the two local fixture-like tenant names; the
reviewed plan now uses the authoritative active tenant from remote inventory.
This means existing installations must supply explicit routes before real
outbound calls can resume. The runbook and deployment env path were updated.

## Additional demonstrated fixes

* PDF-064: the bot previously staged recordings under OS temp regardless of
  `ARTIFACTS_LOCAL_ROOT`. Newer upstream already contains guarded successful
  staging cleanup, which was retained. It now stages
  under the configured root's `.staging`, deleting only its owned UUID tree
  after both upload and durable session finalization. Failure paths retain
  recoverable files. The configured root still must be on a persistent volume.
* PDF-067: initial-base read errors permanently blocked the current epoch.
  Newer upstream preserves media state and requires fresh reads for every
  action, which was retained. Its otherwise unbounded stale media state now
  expires on the first failed read after a five-second lease threshold (the
  two-second poll and bounded 1.5-second read add detection latency); recovery requires a fresh authorized snapshot
  and exact-epoch acknowledgement. Explicit pause, revocation, takeover, stale
  acknowledgements and cancellation-barrier failures cannot reopen AI.
* PDF-065: newer upstream already implements caps, fixed busy/goodbye audio
  and bounded drain. A remaining defect kept `/health/ready` at 200 during
  drain because it checked only database health. It now returns 503 when the
  dispatcher reports `not_ready`; regression coverage uses healthy storage.
* Real-model evaluation reproduced three failures. Tool descriptors concealed
  reviewed field types, so Gemini passed Hebrew number words to strict numeric
  fields; validation rejected the complete batch. Follow-up descriptions also
  allowed a completed inquiry to stay `collecting`. Descriptors now expose the
  reviewed field types/choices and numeric serialization rules, and distinguish
  finalizing a completed inquiry from requesting follow-up. Validation,
  permissions and durable receipt requirements are unchanged. These tools
  remain available only to agents with their published lead capabilities.
* PDF-075: default control polling is now two seconds (previously 0.5),
  and usage checkpoints are fifteen seconds (previously one). Every action
  still obtains fresh authorization. Finalization stops the periodic task and
  persists the newest usage counters. A real local scheduler test with fake
  storage acknowledged pause within 1.9–3 seconds using two reads; this is
  not remote audio or production query-rate evidence.
* The real-model flow exit evaluator had drifted from production: it called
  an obsolete renderer signature, omitted inherited persona, and did not fold
  system instructions through the production serializer. Gemini therefore
  discarded the authored objective. Correcting the harness exposed remaining
  intermittent Hebrew exits. The evidence policy now makes clear that silent
  authored flow transitions are permitted and are not business actions that
  need receipts. Required exit and active-conversation expectations stayed
  unchanged; all 18 outcomes across six scenarios passed after that change.

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
| Rebaseline after merging authoritative `42eebac2` | 1,173 passed, 16 explicitly gated eval skips, 26.44 seconds | Includes newer caps, drain, announcements, pump, knowledge, memory and failure protections |
| New draining readiness regression + provisioning-plan tests | 31 passed | 27 webhook tests and 4 mocked provisioning tests; actual provisioning dry-run additionally succeeded read-only |
| Current dispatcher + runtime + agent + flows + provisioning tests | 1,293 passed, 17 explicitly gated provider skips, 27.14 seconds | Current merged source with cadence and evaluation fixes; `.artifacts/poc-rescue-local/voice-final-current.log` |
| Disposable PostgreSQL `voice-merged-db`, six voice files listed above | 35 passed, 0 skipped, 102.99 seconds | Migrated head `7c91e5a2b640`; admission, isolation, control, verified handoff, intake and quality |
| Disposable PostgreSQL `voice-merged-memory-db`, six memory/knowledge/webhook/usage files | 31 passed, 0 skipped, 31.96 seconds | `test_voice_memory_capture.py`, `test_voice_knowledge_turn.py`, `test_voice_knowledge_migration.py`, `test_phase5_dispatcher_webhooks.py`, `test_verified_channel_memory.py`, `test_voice_model_usage.py` |
| Current exit-policy real-model eval | 5 passed, 0 skipped, 12.47 seconds | One gated test checks six scenarios three times each; four static checks. Prior failed runs retained in `voice-real-model-current.log` / `voice-real-model-folded.log`; passing result in `voice-exit-policy-after.log` |
| Final current lead/support real-model regression | 20 passed, 0 skipped, 27.60 seconds | All16 synthetic model cases plus4 static checks on final policy; `voice-provider-final.log`. Together with exit suite, all17 gated provider test functions were executed; this is not live-call proof |

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
| ProTouch/Or-On caller ID and all real-call entry points | VERIFIED_LOCAL route isolation; actual provider provisioning, config/restart and recipient-observed calls still pending. Source/recipient now human-confirmed; plan dry-run verified |
| Effective agent version / old v3 report | Source and DB tests pin versions/reject ambiguity. Parent owns authoritative remote agent/version inventory; no call-derived effective version yet |
| PDF-061 inbound provisioning | BLOCKED: actual LiveKit inventory has no inbound trunks/rules. `control_api.voice.register_phone_number` still creates `simulator:` rules; real provisioner exists in retained tenancy package but is not wired into deployed control API |
| PDF-062 public webhook | Python signed/invalid/duplicate and durable-pump tests pass. Parent owns actual Caddy/Docker/deployed path evidence; no real carrier callback claimed |
| PDF-063 caps/busy | VERIFIED_LOCAL: upstream `Dispatcher._start` reserves pending slots synchronously; default global/per-tenant cap3, tests cover cap+1, separate tenants, duplicate admission, busy playback port. Prerecorded Hebrew audio ships; recipient audibility and measured host capacity remain unverified |
| PDF-064 recordings | VERIFIED_LOCAL staging root and20 disk-copy-cleanup lifecycles. Guarded upstream cleanup retained. Deployed volume/provider recording review and memory load unverified; whole-call buffering remains a capacity risk |
| PDF-065 drain/goodbye | VERIFIED_LOCAL newer upstream concurrent drain, pending cancellation, bounded90s deadline, orderly engine callback/announcement/finalization. Draining HTTP readiness bug fixed here. Active real call deployment with audible goodbye remains unverified |
| PDF-066 sweeper | Source contains scheduled least-privilege sweeper and pre-deploy sweep. DB stale-session tests exist; actual live-session-safe recovery/deploy timing is parent runtime gate |
| PDF-067 read recovery | VERIFIED_LOCAL short outages retain media, new actions require fresh read; stale media expires at failed read after5s lease threshold, plus bounded polling/read detection latency. New tests prove recovery cannot override revoke/takeover. Live audible recovery unverified |
| PDF-068 LLM/TTS fallback | VERIFIED_LOCAL `VoiceFailurePolicy` allows one bounded transient recovery, interrupts old reply, uses fixed audio independent of failed model/TTS, protects human takeover. SDK test passes; actual provider audio/failover listening unverified |
| PDF-069 idle/VAD | VERIFIED_LOCAL `test_idle.py` in full suite; long Hebrew caller/VAD-only device listening not performed |
| PDF-070 fast webhook ack | VERIFIED_LOCAL newer durable `accept`+`DurableWebhookPump`, lease heartbeat/recovery, readiness/liveness recheck. Source no longer waits for startup in HTTP request. Actual15s-startup/provider-redelivery latency unverified |
| PDF-071 unavailable-agent audio | VERIFIED_LOCAL upstream test `test_unavailable_published_flow_plays_fixed_refusal_before_hangup` and bounded prerecorded `unavailable-he.wav`; actual listening unverified |
| PDF-072 warmup/greeting | Present: model preflight, opt-in warmup only without active operator controller, low reasoning config, fixed lifecycle audio. Pre-recorded ordinary greeting/cold-turn improvement not demonstrated |
| PDF-073 safe streaming | Present/tested in merged agent suite: `HebrewTurnPlanner` streams ordinary bounded chunks, preserves numeric/evidence-sensitive spans; fixed lifecycle audio exists. No accepted end-to-first-audio latency sample |
| PDF-074 knowledge cache | VERIFIED_LOCAL upstream `TurnKnowledgeReader` loads once per inference, checks current eligibility revisions before speech, isolates calls/tenants and rejects revoked/stale generation. Full suite passes; live query-count/latency reduction unmeasured |
| PDF-075 reduced polls/checkpoints | VERIFIED_LOCAL: default control poll2s and usage checkpoint15s; fresh action authorization and reliable final flush retained. Local scheduler pause1.9–3s with fake storage; actual DB load and audible stop latency still unmeasured |
| PDF-076 unverified caller hint | VERIFIED_LOCAL real DB verification/isolation tests; no sensitive handoff content before authoritative unlock. Live spoof/shared-number case unperformed |
| PDF-077 shared memory | Present/tested offline: upstream voice turn append/final memory checkpoint and identity-gated context. Actual verified WhatsApp→voice→WhatsApp continuity and supported summary review unverified |
| PDF-078 natural grounded voice | Support-progress synthetic8/8 passed on merged source, authored exit18/18 outcomes passed after policy/eval repair; grounding tests pass. Human Hebrew30-case agent evaluation not done |
| PDF-123 20 inbound calls/DID | BLOCKED: inbound not provisioned/activated; zero real inbound test-call evidence |
| PDF-124 active-deploy+cap+1 | VERIFIED_LOCAL lifecycle ports only; audible real-call busy/goodbye and concurrent WhatsApp availability not measured |
| PDF-125 speech latency | NOT_CHECKED live: no p50/p95 first/cold/warm end-of-speech→audible-response sample |
| PDF-126 20-call load/leak | Partial:20 local artifact lifecycles, no staging leak; not20 full simulated/provider call pipelines or memory/disk stress under accepted concurrency |
| PDF-110 canary/48h | No deployment or 48-hour observation occurred; local test success does not authorize broad live activation |

Owned source areas: `packages/py/oron-dispatcher`, selected
`packages/py/oron-agent` artifact/control/lead descriptor files,
`services/py/dispatcher`, and the admission test in
`db/tests/postgres/test_voice_quality_runtime.py`. No TS CRM/web, schema,
carrier or production mutations were made by this workstream.

## Carrier-cost correction and image boundary — 2026-10-05

PDF-088 inspection found that `oron_common.usage.carrier_for` assigned Telnyx
rates to every inbound call solely from the dialed number's type. Actual trunk
inventory instead identifies Twilio. `CallContext.provider` identifies LiveKit
transport and supplies no authoritative carrier/tariff binding, so number type,
country, trunk names and participant metadata cannot authorize a Telnyx price.
New calls now keep the carrier unknown and expose `telephony:unknown` in the
unpriced list when usage is nonzero. Existing explicitly recorded carrier fields
and the historical price book remain unchanged. Reviewed account/trunk references
remain available in outbound admission records; no Twilio rate was invented.

`uv run --no-sync pytest packages/py/oron-common/tests
packages/py/oron-agent/tests/test_cost.py -q` passed **61 tests, zero skips** in
10.37 seconds. Regressions cover inbound local/toll-free/foreign numbers and
spoofed metadata; Ruff passed. Source and local regression are verified. A real
carrier usage reconciliation and an authoritative reviewed rate binding remain
outstanding. The three Python images previously tested from `525be698` predate
this correction and must be rebuilt from the final candidate; their artifact
and health evidence remains historical. Local restore evidence and its off-host
and production-key limitations are documented in `RUNBOOK.md`.

## Final images and actual prior-image compatibility

Three final Python images were built from the secret-free Git archive of
`0331908b56edf737bf970c7bb5fa174450310eb8`, with matching OCI revision labels:

| Service | Local image ID | Build seconds |
|---|---|---|
| migrator | `sha256:96e9efa710d79c4cf416694ed36c831f57d82724b33f7082ad8508e670272401` | 36.336 |
| control-api | `sha256:04d367194779105c23856d120dc0863f5a4c3341c9f586edfaa8a66413094a81` | 91.982 |
| dispatcher | `sha256:9a107188f85e5b0b47eaa9568c884025cb3bc220a46c3d72d68156fd8c921465` | 58.434 |

Build logs and `final-image-*.json` receipts are under the ignored rescue evidence
directory. No registry publication occurred. Parent-owned main-stack acceptance
of these final images is separate from the prior-image checks below.

The four exact **deployed** application digests from `42eebac2` were pulled with
existing read-only registry authentication and run in `oron-poc-rescue-compat`,
using separate fictional configuration/data and internal networks. No active
developer or main rescue container was modified. Against the forward schema
`9e43a5b02d81`, the old dispatcher and control-api's actual database adapters
passed admission concurrency (one true/one false), destination-change rejection,
wrong-tenant read denial, pause/replay, stale/exact acknowledgement, wrong-tenant
finalization rejection, repeated finalization, encrypted phone storage and
preserved outcome/answer fields. Only one durable admission receipt was present.
This invokes real PostgreSQL functions under `platform_voice`; no agent engine,
SIP call, media or provider send is involved. Receipt: `old-voice-functions.json`.

Through the actual isolated Caddy path, the old dispatcher returned unsigned
401, signed 200, duplicate 200 and exactly one durable event; the public outbound
control route returned 404 (`old-caddy-callback.json`). Twelve old-web HTTP auth,
CRM and tenant-denial checks also passed (`old-app-functional.json`). These checks
prove specific compatible contracts, not a timed complete rollback.

Two actual old-image incompatibilities were found. At schema `8d32f4a91c70`, the
old worker claimed all four Coexistence event types and failed them despite
healthy readiness. Additive migration `9e43a5b02d81` repaired the claim contract:
the unchanged old image then processed normal text and left new types untouched
at zero attempts. The final packaged migrator successfully verified that same
head; its migration file SHA-256 matched the archived source and the earlier
source-mounted forward upgrade. Separately, the old CRM parser classified a
historical image notification as a live message. Therefore **old-web rollback
after Coexistence callback activation remains blocked**. The corrected claim
contract alone does not remove that ingress risk. Full receipts and operational
restrictions are in `RUNBOOK.md` and
`.artifacts/poc-rescue-local/previous-image-compat`; no downgrade was performed.

The preserved compatibility project was then recovered forward to the exact
`0331908b` candidate images. The same actual voice admission/control/finalization
adapter assertions passed (`forward-voice-functions.json`), alongside twelve
compiled-web auth/CRM/tenant checks. The current worker recovered six valid
preserved Coexistence receipts and imported two corrected successor contact
fixtures, while retaining/rejecting two malformed original fixtures. No automation
jobs, model calls or external sends resulted. The compiled current parser correctly
emitted zero live envelopes for historical media. Actual running image labels,
healthy services, disabled provider flags, internal networks and unchanged private
configuration are recorded in `forward-runtime-final.json`. Only this project was
stopped afterwards; data and evidence remain available. Main-stack and live
acceptance remain separately reported by the parent workstream.

## Authorized live voice connection (2026-10-05 local time)

The explicit live-connection instruction superseded the earlier provisioning
gate. Fresh carrier checks detected independent ProTouch endpoint/credential
changes; those were preserved. ProTouch outbound now uses
`ST_Dc2P469Pn2ZU` with its single sender `***4553`, while Or-On retains
`ST_hMBmL3fQMdFu` and `***5689`. The active tenant route map was validated and
deployed by the parent with exact source `0331908b` and schema `9e43a5b02d81`.

Actual normal web login, tenant switch, CRM read and voice permission checks
passed. The approved `***7692` contact already existed with granted voice consent.
The actual valid published ProTouch agent is `9a9bfdbf-4c46-4bd4-842f-2bfb8c4cb173`
v1, and its canonical automation pins voice flow
`4b4d1bd3-98c8-4faa-b486-28b8e6a104bb` v1.

First session `c45df0f7-8daa-5efa-ab32-0c739c77f5a1` was admitted but failed
carrier authentication before ringing. Twilio alert `NO905651db31e501a5a08066c84b35170c`
recorded `32202`; the user independently reported no call. Its original ended/null
record was corrected through an explicitly reviewed, tenant-scoped CAS transaction
to failed/answered=false/carrier_authentication_failed, with the original end time
and absent artifacts preserved. Original events remain, with an appended immutable
reconciliation event and audit record; the canonical activity writer was invoked.
The rollback rehearsal and actual commit receipts are retained.

After a separately reviewed isolated credential repair, the one authorized retry
created session `fc93b04d-7f3e-56ab-a5ef-8bebe1864c56`. Twilio call
`CA92e7988f5427b50117d951ff64deb28a` connected from the correct ProTouch sender
to the approved recipient and completed for 18 seconds. SIP status was active.
The room also contained the failure-announcement participant, and real runtime
finalization errors were observed. Therefore carrier connectivity is verified;
full agent conversation, artifacts and lifecycle acceptance remain pending the
new runtime fixes. No further calls were made during those repairs.

Inbound preparation created trunk `ST_aJJSDZMGTeJ8`, whose readback contains
only DID `***4553` and the eight current Twilio signaling `/30` networks, and
individual rule `SDR_AcS72sUqk2ZM`, restricted explicitly to that trunk. No agent
auto-dispatch was added. The Cloud API accepts and retains the ACL. It does not
retain the redundant `SIPDispatchRuleInfo.numbers` input; called-number isolation
is enforced by the single-DID trunk plus explicit-trunk rule, as supported by the
[LiveKit SIP API](https://docs.livekit.io/reference/telephony/sip-api/).
The allowlist came from [Twilio's signaling network inventory](https://www.twilio.com/docs/sip-trunking/ip-addresses).

After the parent verified an actual provider-origin signed webhook receipt, an
audited CAS changed only existing ProTouch phone row
`b68a0331-d6fb-51b6-8007-09a66fe319c0` from its simulator rule to the real rule;
tenant, DID and flow were preserved. Carrier origination is still the previous
`sip:34.165.22.57:5060`; no inbound cutover or actual inbound-call acceptance has
yet occurred. A complete PSTN proof requires a controlled cutover and inbound
test after the runtime repair, retaining the exact existing origination for rollback.

The subsequent bounded source-rejection test **failed**: one actual SIP INVITE
from the owned VM's verified non-Twilio IP was accepted with `200 OK` and created
one failed application session. Signed provider events identify the exact new
trunk/rule. Thus the retained allowlist is not evidence of enforcement in this
project. The probe was immediately disconnected, the newly prepared rule removed,
and the exact DID binding restored through an audited compensating CAS. No
customer was dialed and carrier origination remained unchanged. Inbound cutover
is blocked pending verified provider enforcement or a separately reviewed secure
alternative. See [the source-test and containment evidence](PROTOUCH-INBOUND-ACL-FAILURE.md).

## Repaired release: actual outbound acceptance

On `60f26bfe1775997da1fb5159ec9e09a08246068b` / schema `9e43a5b02d81`,
exactly one further authorized call was submitted through normal CRM login,
ProTouch tenant selection, consented-contact lookup and `/api/voice/real-calls`.
Preflight confirmed no active sessions, healthy exact-revision web/dispatcher,
and the dedicated ProTouch route. Session
`0af0ed12-555f-5cc8-bc4e-47a033fe1be8` was created at
2026-10-04T23:09:51.926846Z. Its admission records the intended published agent
version `9a9bfdbf-4c46-4bd4-842f-2bfb8c4cb173` and outbound trunk
`ST_Dc2P469Pn2ZU`.

The user confirmed that the call arrived and the agent conversed in Hebrew.
Twilio `CA6ed0c3249d2ce35f29e0baeb558232bb` independently reports completed,
23 seconds, 23:10:03–23:10:26 UTC, correct ProTouch trunk and source `***4553`
to the approved recipient `***7692`. The application finalized normally at
23:10:28.328762Z with `answered=true`, status `ended`, and both artifacts.
Bounded runtime logs show no TTS or finalization error for this call; later
room cleanup returned 404 because the room had already disappeared.

Normal authenticated CRM readback returned 200 for detail and
[/voice/calls/0af0ed12-555f-5cc8-bc4e-47a033fe1be8](https://dev.or-on.io/voice/calls/0af0ed12-555f-5cc8-bc4e-47a033fe1be8),
including the recording player. Protected artifact reads returned 200 with
`private, no-store`; switching the same user to Or-On produced 404 for both,
and anonymous requests produced 401. Readback retained metadata only:

- Recording: 2,695,964-byte valid stereo WAV, 24 kHz, 28.0825 seconds,
  non-silent PCM; SHA-256
  `a5e9809860fd2c4c629c7911234da6c5220dc3a189614b7e2055cfa5fd1d114d`.
- Transcript: 348 bytes, three nonempty lines containing Hebrew; SHA-256
  `94ed816eec6bc358a30fa7f64eb576c5ee09d8d6f2808719b5293c7df3d88bf5`.
- Usage includes real model/STT/TTS counters. Application telephony remains
  explicitly `telephony:unknown`/unpriced; its partial total must not be called
  the all-in call cost. Twilio separately reports a USD 0.06060 charge.

Receipts: `.artifacts/poc-rescue-local/live-voice-60f26bf-{submission,result,provider,artifact-readback}.json`.
At 23:13 UTC there were zero active application sessions and neither the
acceptance room nor the earlier synthetic probe room remained. Provider
readback still showed zero inbound dispatch rules and the original carrier
origination; successful outbound acceptance does not resolve inbound routing.
