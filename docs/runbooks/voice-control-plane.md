# Local voice control-plane runbook

This runbook covers the local control plane and the guarded cloud LiveKit/SIP
dispatcher. It never creates trunks or dispatch rules, provisions a DID, or
places a call without an authenticated single-recipient action.

## One-time local configuration

Run the normal bootstrap first so the ignored `.env` exists. `make voice-up`
generates a local-only LiveKit API key and random API secret when these fields
are blank; it never prints either value. You may instead set your own local
values before the first run:

```dotenv
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_PORT=7880
LIVEKIT_API_KEY=<local key without whitespace or colon>
LIVEKIT_API_SECRET=<random local secret of at least 32 characters>
```

Do not reuse these values outside localhost and do not use the upstream
`devkey`/`secret` placeholder pair. Keep all real-action flags false for the
local Compose voice profile.

## Start and verify

```bash
make voice-up
```

On Windows without GNU Make, use the exact cross-platform implementation:

```powershell
uv run python scripts/dev.py voice-up
```

The command installs the opt-in uv `voice` group, starts `redis`, `livekit`, and
`livekit-sip`, waits for their container health checks, and performs three
read-only API requests: list inbound trunks, list outbound trunks, and list
dispatch rules. It never calls a create, update, delete, dial, or transfer API.

Repeat the non-mutating check with:

```bash
make voice-check
```

Expected initial state is zero trunks and zero dispatch rules. A nonzero count is
reported but not modified; investigate it before continuing to DID work.

## Network and persistence boundaries

- LiveKit HTTP/WebSocket control traffic is published only on
  `127.0.0.1:${LIVEKIT_PORT:-7880}`.
- Redis is private to the Compose bridge and has no host port or persistent
  volume. It is disposable LiveKit/SIP coordination state, never authoritative
  platform persistence.
- SIP signaling `5060/udp`, SIP health `8080/tcp`, and RTP `10000-10100/udp`
  remain container-internal. This profile cannot receive a carrier call from the
  host/network and is not evidence of SIP media traversal on Docker Desktop.
- PostgreSQL remains the sole authoritative application database.

Inspect status/logs without exposing credentials:

```bash
docker compose --env-file .env -f infra/compose/compose.yaml --profile voice ps
docker compose --env-file .env -f infra/compose/compose.yaml --profile voice logs --tail 100 redis livekit livekit-sip
```

## Stop

```bash
make voice-down
```

This stops only the optional voice infrastructure. It does not remove the core
PostgreSQL volume or alter provider state.

## Unified operator workflow

With the core stack running, sign in using the fictional development account
and open `/flows`, `/voice`, and `/voice/campaigns`.

1. Publish a versioned voice flow from `/flows`.
2. Register a simulator DID with an explicit restricted documentation/test CIDR
   from `/voice`. This does not create a LiveKit or carrier resource.
3. Open a fictional contact, set voice consent to `granted`, and start a
   simulator call; replay uses the submitted idempotency key.
4. Inspect the call lifecycle, transcript event, outcome, artifact metadata,
   usage, estimated cost, and latency on `/voice/calls/[id]`.
5. Create and run a voice campaign. Only explicitly opted-in active contacts
   with usable E.164 identities are selected.

Use `make voice-check` (or `uv run python scripts/dev.py voice-check`) for the
optional local SIP control plane. It lists resources only. Do not treat an empty
provider inventory as drift repair authorization.

## Guarded real outbound call

Use this only after LiveKit Cloud, its outbound SIP trunk, Twilio termination,
Soniox, and the configured LLM have already been verified. The repository does
not create or modify those provider resources.

1. Publish the agent profile, retained voice flow, and canonical connected flow.
2. Apply current migrations with `uv run python scripts/dev.py migrate`.
3. Set both `ENABLE_REAL_TELEPHONY=true` and
   `ENABLE_REAL_VOICE_PROVIDERS=true` in the ignored `.env`. They must match.
4. Restart with `uv run python scripts/dev.py dev`. The dispatcher starts on
   loopback and reports readiness only when PostgreSQL and its durable webhook
   ledger are available.
5. Open the intended contact, verify its E.164 phone identity, set voice consent
   to `granted`, choose the published voice flow and the caller's requested
   Hebrew address form, tick the real-call checkbox, press the clearly labelled
   real-call button, and accept the final browser confirmation. The address form
   is call-local and may be corrected by the caller during the conversation.
6. Follow the created session under `/voice`. Reusing an idempotency key cannot
   create a second call.

Before the first call in each dispatcher process, the retained agent sends a
one-token, customer-data-free inference probe to the configured LLM. The SIP
leg is not dialled unless that probe succeeds. This catches valid keys that do
not have access to `LLM_MODEL`, disabled provider billing/quota, invalid
credentials, and provider outages before a telephone call starts. A successful
probe is cached for the dispatcher process; restart the process after changing
LLM credentials or model access.

For the Google AI Studio compatibility endpoint, the low-latency conversational
profile is:

```dotenv
LLM_PROVIDER=openai-compat
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
LLM_MODEL=gemini-2.5-flash
LLM_REASONING_EFFORT=none
LLM_TEMPERATURE=0.4
LLM_MAX_TOKENS=256
LLM_WARMUP=false
VAD_STOP_SECS=0.2
USER_SPEECH_TIMEOUT=0.5
TURN_START=responsive
TURN_END=soniox
SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL=2
SONIOX_ENDPOINT_SENSITIVITY=0.15
SONIOX_MAX_ENDPOINT_DELAY_MS=1000
USER_IDLE_SECS=10
TTS_PROVIDER=soniox
SONIOX_STT_MODEL=stt-rt-v5
SONIOX_TTS_MODEL=tts-rt-v2
SONIOX_TTS_VOICE_DEFAULT=Harper
TTS_TEXT_AGGREGATION=sentence
TTS_FIRST_CLAUSE=true
TTS_NIQQUD=false
TTS_SPEED=1.0
GENDER_DETECTION_ENABLED=false
GENDER_REQUIRED_SECONDS=1.5
GENDER_CONFIDENCE_THRESHOLD=0.9
GENDER_MAX_SECONDS=4.0
GENDER_RETRY_INTERVAL_SECONDS=0.75
GENDER_CONFIRMATION_ATTEMPTS=2
```

Keep `LLM_API_KEY` only in the ignored `.env`. Gemini 2.5 Flash is intentional
for telephone turns: disabling thinking reduced the measured model response
from roughly 2.3 seconds on Gemini 3.8 Flash at low reasoning to roughly one
second, while preserving streaming and function calls. The 256-token ceiling
is a safety net against spoken monologues; the flow persona still requires one
or two sentences and one question at a time. `LLM_REASONING_EFFORT=none` must
not be paired with Gemini 3, which does not support disabling thinking through
this endpoint.

`tts-rt-v2` is the supported Soniox real-time model. `Harper` is the current
fallback chosen for relaxed, conversational delivery; a compatible voice set on
the call or published flow still wins. Restart the development runner after a
model, voice, or turn-threshold change. Acoustic gender detection is disabled by
default because telephone confidence is not a safe identity signal. If enabled
for controlled evaluation, gender must be confirmed twice above the configured
threshold; otherwise the agent deliberately keeps neutral Hebrew.
The caller can set the form deterministically during a call by saying, for
example, `אני גבר`, `אני אישה`, `דבר אליי בלשון נקבה`, or
`דברי אליי בלשון זכר`. Explicit self-identification takes effect on that reply,
persists for the call, and overrides every acoustic guess. Do not enable
acoustic detection merely to test this behavior. The selected form is applied
to Pipecat's primary flow/node system instruction, not only to conversation
history. A final narrow TTS safeguard corrects common unambiguous direct-address
forms while preserving the female agent's own first-person grammar. For new
outbound sessions, the operator-selected form is also stored as the safe
`voice.call.configuration.v1` event; no phone number, prompt, or audio is
copied into that diagnostic payload.

`TURN_END=soniox` uses the v5 model's Hebrew-aware semantic endpoint for the
stop decision. `TURN_START=responsive` is deliberately asymmetric: while the
agent is speaking, VAD starts an interruption immediately; while the agent is
quiet, at least one transcribed word is still required. This gives barge-in the
roughly 200 ms VAD response path without allowing wordless line noise to create
ordinary turns. Endpoint level `2`, sensitivity `0.15`, and the 1000 ms ceiling
target the repeated 1.6-2.0 second response gaps measured in the latest call.
`TURN_END=vad` remains the fixed-time rollback; only then do `VAD_STOP_SECS` and
`USER_SPEECH_TIMEOUT` determine the stop delay.

Terminal dots are removed from synthesized text so they cannot be spoken as
"period", while question marks and commas remain for prosody. Clock values such
as `בשעה 10:00` are normalized to natural spoken Hebrew before TTS, and written
date prefixes such as `ה-17` are joined after number expansion so punctuation is
not voiced mechanically. Generated LLM text passes through a bounded full-turn
planner before TTS. If the model joins an answer and a final direct question,
the planner inserts an internal full stop and restores a missing question mark.
Keeping the full stop inside one Soniox request avoids both the old comma-chain
delivery and the terminal "period" regression.

Only clock expressions containing minutes, or bare ranges explicitly labelled
as hours, are normalized to `עד`. Long telephone and identity-number shapes are
read digit by digit; a hyphen inside such an identifier is never treated as a
time range. Generated `HDMI` and `WhatsApp` tokens receive reviewed Hebrew
spoken forms before synthesis.

Every runtime flow receives a final grounding rule after its published agent
prompt: a lookup, eligibility result, appointment slot, booking, or confirmation
may be claimed only after an exposed tool returns that result. A tool-less
conversation can collect context and offer human follow-up, but cannot simulate
an unavailable company system. Unsafe requests receive one brief refusal and a
safe alternative rather than a policy lecture.

The handler registry contains conversation-routing functions plus one bounded
caller-verification tool for a canonical WhatsApp-to-voice handoff. The model
collects only the configured factor names and supplied answers; deterministic
database functions compare normalized values and never return the expected
national ID. Previous messages, address, case, appointment, visit and report
context remain unavailable to the model until the authoritative verification
record reaches `context_unlocked`. Ticketing, technician scheduling and message
delivery remain unavailable unless a separate exposed tool returns the exact
result. A final TTS-boundary guard suppresses unsupported success claims and
unnecessary repetition of full identity numbers.

For a controlled development diagnosis, set `VOICE_TEXT_DIAGNOSTICS=true` on
the dispatcher. The resulting session artifact records redacted final STT text,
LLM response text, exact TTS-bound text, latency, verification state and context
lock state. Identifier-shaped digit sequences are removed before persistence.
Keep this flag `false` in production and do not use the artifact as a substitute
for listening to the authorized test call.

`USER_IDLE_SECS=10` is the first genuine-silence prompt. The idle processor
suspends this policy while either participant is speaking, so a long caller
utterance is not misclassified as silence.

`TTS_NIQQUD=false` keeps the experimental model-backed pronunciation transform
out of the live path. Soniox's native Hebrew and a narrow, reviewed flow
pronunciation lexicon remain active. The spoken boundary still adds targeted
niqqud to caller-address homographs whose written form cannot distinguish male
from female, for example `לְךָ`/`לָךְ` and `נִסִּיתָ`/`נִסִּיתְ`. This is driven
only by the explicit call-local address form and does not point the rest of the
sentence. Add other pronunciations only for words demonstrated to be wrong in
a recording; do not apply automatic niqqud to every generated sentence.

After a completed call, open its row under `/voice`. The details page streams the
complete stereo recording through the authenticated application. A missing
player means no recording object was committed; a visible player that returns
"not found" means the database metadata exists but the configured local/GCS
artifact is unavailable to the control API. Do not replace this with a public
storage URL.

## Live cost estimates

The `/voice` call list shows an estimated USD cost for every conversation. While
a call is active, the agent checkpoints metered usage about once per second and
the authenticated web surface refreshes the estimate every two seconds. The call
detail page shows the same live total plus telephony, speech-recognition,
language-model, and voice-synthesis components. A refresh failure retains the
last valid tenant-scoped snapshot and does not interfere with the call.

These values are operational estimates, not provider invoices. A **partial
estimate** means at least one consumed component has no matching rate in the
current price book. In particular, outbound carrier pricing remains partial
until the destination/carrier rate can be attributed reliably; the platform
does not substitute an unrelated inbound or local rate. Provider invoice
reconciliation remains the source for settled spend.

If the call UI reports that the model is unavailable or not authorized, select
a model the account can actually infer with. A provider model catalog is not
sufficient evidence because it may list dedicated or gated models. If it
reports unavailable billing/quota, enable billing or use another supported LLM
account before retrying. Never work around either failure by disabling the
preflight.

Turning on flags does not itself dial. The web admission boundary checks auth,
CSRF, RBAC, tenant ownership, contact state, consent, identity, and flow; the
dispatcher independently checks its feature flag and approval again. Real
voice campaigns remain outside this single-contact workflow.
