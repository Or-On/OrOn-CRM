# Hebrew voice runtime audit and local evidence

Date: 2026-09-12. Baseline target HEAD: `7afa8534fc89259cd679da7ff58ec7546bd01b14`.
The working tree already contained extensive tracked and untracked changes,
including caller-address handling, full-turn planning, speech guards, and Hebrew
normalizers. Those changes were retained. No commit, provider request, telephone
call, WhatsApp send, worker startup, credential-file read, or model download was
part of this audit. The repository instructions reference `BOOST.md`; that file
was absent at the provided workspace root. Root/scoped instructions, the master
implementation brief, progress and voice/WhatsApp runbooks were read.

## Actual baseline path

`bot.py` resolves the retained flow and per-call settings, constructs Soniox STT,
then Pipecat user context, LLM, a full-response `HebrewTurnPlanner`, TTS, leading
silence trimming, LiveKit output, assistant context, and the stereo recorder.
`pipeline.py` can put the disabled-by-default acoustic classifier in parallel
with STT. Caller-address context precedes the user aggregator. No acoustic
classification was enabled or evaluated here.

The installed and locked Pipecat version is **1.8.1**. Its Soniox STT adapter
buffers final tokens until a provider endpoint, then emits a
`TranscriptionFrame(finalized=True)` with the token list in `result`. Provisional
revisions, including final tokens awaiting an endpoint, arrive separately as
`InterimTranscriptionFrame`. The raw token list retains provider timing fields;
it is not equivalent to a verified caller identity.

The installed adapter accepts `SonioxContextObject(terms=[...])` through
`SonioxSTTService.Settings.context`. This matches the official
[Soniox context documentation](https://soniox.com/docs/stt/concepts/context).
The implementation uses a much smaller 2,048-character vocabulary budget and
passes no free-form instructions or conversation history as STT context.
The official [endpoint guidance](https://soniox.com/docs/stt/rt/endpoint-detection)
describes the accuracy and segmentation tradeoff from more aggressive
endpointing. Existing endpoint thresholds and STT/TTS model defaults were kept.

Soniox TTS's character-timestamp route remains deliberately disabled by the
existing adapter. Its historical documentation reports an audio regression; no
recording was replayed here to independently verify that historical claim.
Generated text and audio byte counts cannot establish which words a remote
caller heard.

## Baseline and behavioral changes

Before edits, the selected caller-address, planner, TTS-provider, silence-trim,
normalizer and filter suites passed **101 tests in 4.40 seconds**. That passing
baseline did not include the defects below. Test wall time is not voice latency.

| Boundary | Observed baseline code behavior | Implemented behavior and fixture evidence |
| --- | --- | --- |
| Address preference | Only male/female; negated commands and quoted declarations could match; earlier accepted segments could shadow a correction | Masculine/feminine/neutral/unknown, current caller correction overrides configured defaults, quoted/reported/negated requests rejected, contradictory requests left unresolved, direct requests stronger than incidental first-person grammar; `test_caller_gender.py` |
| Recognition acceptance | Provider raw/provisional/final data existed but had no explicit platform acceptance boundary | `RecognitionAcceptanceProcessor` preserves original text, token result and timestamp; marks accepted text separately; demotes nonfinal transcription frames to provisional frames; deduplicates repeated frame identities; `test_recognition.py` |
| Clock ranges | `10:15–11:45` dropped both minute values | Both endpoints retain minutes; only recognized clock or explicitly labelled ranges transform; `test_normalizers.py` |
| Critical numbers | `29.90 שקלים` became independently spoken integer fragments; grouped currency and generic digit joining could alter readback | Whole currency/decimal tokens preserve sign, grouping, fractional zeroes and feminine agorot agreement; ambiguous dates/invalid grouping pass intact; separate quantities stay separate; `test_normalizers.py`, `test_filters.py` |
| Larger numbers | Six-digit quantities could index outside the tens table | Recursive thousands conversion handles the documented 0–999,999 range; `test_normalizers.py` |
| Pronunciation | Existing lexicon used substring replacement and could affect a larger name | Whole lexical token matching, explicit language/context, simultaneous substitutions, Hebrew consonant preservation and critical-value/markup rejection; `test_voice_quality.py`, `test_niqqud.py` |
| Canonical versus spoken | TTS filters rewrote the text used by assistant context | New speech transformer is registered after canonical validation; pronunciation and Hebrew numeric normalization operate on provider text; immutable authored text stays separate; `test_voice_quality.py` plus root bot wiring |
| Full response cancellation | An orphan LLM token after an interruption could pass through an empty planner | Interrupted buffers clear; orphan tokens are dropped; bounded text cap yields a complete recovery phrase; structured evidence selectors pass verbatim; `test_turn_planner.py` |
| Audio cancellation | Silence-trim buffers survived interruption and lost the TTS context identifier when flushed | Buffer discarded at interruption; cancelled contexts reject late audio; context survives trimming; `test_tts_trim.py` |
| Audio onset | All samples before detected onset were removed | A 40 ms prefix protects quiet leading sounds; synthetic PCM verifies retained samples, not pronunciation or intelligibility; `test_tts_trim.py` |
| Stage diagnostics | No consolidated content-free voice-stage artifact | Bounded `VoiceQualityObserver` emits observed stages and nearest-rank p50/p95, with missing stages unknown and exact playback always unconfirmed; `test_quality_observer.py` |

## Configuration compatibility

The new adapter consumes the published `channel_configuration.quality` schema
version `1.0`. It retains the field names used by management: `language`,
`agentGrammar`, `callerAddressDefault`, `speakingStyle`, `speakingPace`, `voiceId`,
`sttVocabulary`, `pronunciationDictionary`, `budgets`, and `fallbackBehavior`.
Root integration applies the pinned profile and budget fields in `bot.py`.
Provider credentials and arbitrary model/provider replacements are absent from
this configuration boundary.

Authenticated outbound dispatch also carries optional `agent_version_id` and
strict positive-integer `flow_version` fields through `OutboundCallRequest`,
`Dispatcher.place_outbound_call`, and `CallContext`. Legacy callers may omit
them. Active-session idempotency rejects a replay with different version or
other call bindings using an HTTP 409 response; durable replay validation and
published tenant/version eligibility are enforced by the root persistence
integration. The focused common/dispatcher/webhook baseline passed 28 tests;
after these additions, 44 tests passed in 1.14 seconds, with scoped Ruff and
Python typing checks passing.

Vocabulary is limited to 64 entries, 80 characters per entry, 2,048 characters
in total. Case-equivalent duplicate terms are removed. Pronunciation dictionaries
are limited to 64 entries with 80-character original/spoken forms, a 120-character
context cue and up to eight 240-character test sentences. A nonempty context is
a literal phrase required in the authored utterance, not a model instruction.
Hebrew original/spoken pairs may change vowel marks only; Latin names or brands
may have an explicitly authored spoken transliteration. Numeric values, currency,
negations, address forms, authorization/status claims and markup are rejected.
This is a conservative pronunciation format, not an arbitrary text-rewrite engine
or invented SSML support. Global model-generated niqqud remains off by default.
The retained `FlowSpec.pronunciations` path uses the same semantic validator at
its existing lexicon boundary, examines at most 64 entries, and skips unsafe or
overlong pairs while keeping safe names and the `Or-On` pronunciation active.

## Retained flow-version immutability

`PostgresFlowStore.publish` no longer overwrites an existing `(flow_id, version)`.
The database uniqueness constraint arbitrates concurrent inserts; a fresh
tenant-scoped lookup accepts only an identical authored source, frozen spec and
component version. A mismatch raises `FlowVersionConflict`, mapped to HTTP 409 by
the retained publication API. Editing content requires a new version; older
versions continue to load their original frozen content. This does not create a
database trigger or restrict a privileged administrator's direct SQL access.

The writer audit found only this runtime writer. Explicit preview fixtures use
insert-only conflict handling; the packaged catalog utility is development-only
and runtime startup does not seed it. No draft editor depends on updating this
published table. Focused publication/tenancy tests passed 49 tests with one live
PostgreSQL test skipped in the credential-free run; scoped Ruff, formatting and
the full configured Python type-check paths passed. The new live PostgreSQL/RLS
test covers exact replay, changed-content conflict, cross-tenant collision and
new-version publication under `platform_voice`.

## Timing and delivery evidence

`VoiceQualityObserver` observes pipeline clock events for accepted recognition,
speech-stop signals, model requests, first tokens, full generated replies,
grounding validation, first synthesized audio, first submission to the transport,
and transport speaking signals. It retains the last 128 turns by default, bounds
frame/context tracking, and exports no transcript, tool arguments, source text,
credential, customer identifier or raw provider payload. Its JSON artifact reports
sample counts and nearest-rank p50/p95 for available paired stages only.

`generated`, `synthesized`, `submitted_to_transport`, and the transport speaking
signal are different observations. `exact_playback_confirmed` remains false.
Interrupted delivery is `partial_or_unknown`; other delivery remains `unknown`
without a remote playback receipt. Missing stage timestamps are null, never zero.
Frame-fixture tests validate accounting and redaction; their timings are injected
test times and must not be used as live provider performance measurements.

## Active-call AI ownership

The tenant-authorized control API exposes GET/POST
`/api/v1/voice/sessions/{session_id}/control`. A command includes an expected
ownership epoch and idempotency key; a changed binding cannot reuse a prior key.
Only active sessions and freshly authorized operators can change ownership.
Viewers can inspect status but cannot operate. The new generated Alembic successor
`eb626a89c3a8` stores desired mode, append-only command receipts and worker
acknowledgements under forced tenant RLS. A pending/stale/missing worker receipt
does not display as an applied command. Role revocation and persistence failures
close local AI gates and require a new explicit resume command.

The active-call listener polls at a bounded 500 ms default, closes input/model/
synthesis/output gates before cancellation, cancels guarded actions and sends
one interruption through the pipeline. Its barrier observes every leaf processor,
including both branches of the optional classifier/STT parallel pipeline; merely
queuing a frame or finishing the faster branch is not acknowledgement. The
recognizer is disconnected, its partial final-token buffer discarded, and the
uncommitted user aggregation cleared. Explicit resume opens a new generation's
capture stream before the exact durable epoch is acknowledged and gates reopen.

`OwnershipSonioxSTTService` uses the installed Pipecat Soniox connection lifecycle
because ordinary caller interruption does not reset its persistent STT buffer.
Final/interim/proposed-turn callbacks keep their capture generation. Old or
unknown recognition, model output, and synthesis/audio identities fail closed;
they are not relabeled current when the operator resumes. The audio gate precedes
the leading-silence buffer, and trimmed frames retain their ownership metadata.
Ordinary barge-in and the existing provider/model settings are unchanged.

Offline fixtures exercise queued versus completed cancellation, linked and
parallel processors, database failure/revocation, stale command acknowledgement,
late model/action/audio callbacks, and the installed Soniox parser with fake
sockets: a pre-pause partial, a delayed old endpoint and a delayed old callback
cannot become a post-resume instruction, while fresh speech can. These fixtures
make no provider request. PostgreSQL tests separately exercise real constrained
roles/RLS, idempotent concurrent commands and competing ownership epochs in owned
isolated databases; the root integration record owns their execution result.

This is AI pause/resume, **not** human media connection. The API explicitly returns
`human_connection: not_managed`. Local cancellation cannot recall audio already
submitted to the remote transport or undo a previously accepted external action.

## Remaining acceptance and limits

- Live provider inference, native Hebrew listening, telephone-band recordings,
  overlap/echo/noise/accent quality, pronunciation and end-to-end latency/cost
  remain pending separately authorized evaluation. No before/after acoustic
  improvement percentage is claimed.
- The acceptance processor can deduplicate identical frame identities, not
  independently identify arbitrary reconnect replays. Text-only deduplication
  would incorrectly suppress legitimate repeated answers such as `כן`; a stable
  provider connection/segment identity is required for stronger replay handling.
- Generation metadata, strict producer identities and Pipecat cancellation
  barriers cover local active-call pause/resume. Human joining or telephone-leg
  transfer remains a separate integration; no human-connected status is claimed.
- Provisional recognition cannot trigger this preference extractor. Consequential
  business tools must still require accepted intent, field validation, current
  authorization and backend receipts. This runtime change does not create tools.
- Rule-based address extraction intentionally declines ambiguous or novel forms.
  Written dates without a clear locale/time zone remain unresolved rather than
  silently reinterpreted.
- The 40 ms onset prefix is a conservative sample-retention change. Listen to
  representative soft initial consonants before approving acoustic acceptance.

## Verification and rollback

Runtime/Hebrew focused verification passed 189 tests in 10.18 seconds, including
the stage observer, direct-address, neutral/unknown, negation, retained-lexicon
and multi-turn planner reset regressions. Scoped Ruff checks and Python type checking passed, and
`git diff --check` passed. The root agent owns the consolidated integration gate
and final feature matrix.

After management's final code freeze, the credential-free consolidated Python
run passed 1,095 tests with 118 intentionally skipped and five warnings in
30.62 seconds. Full configured Pyrefly reported zero errors; Ruff passed and
all 401 Python files were formatted. OpenAPI/client/schema and the platform-event
contract were regenerated twice using installed toolchains: all four file hashes
matched the starting tree and each other. Offline Alembic SQL was deterministic
at 258,935 bytes, with one head `eb626a89c3a8`, 59 revisions and all 22 retained
Or-on revision IDs. Its SHA-256 is
`1ddcf104453cbe4ea270f46da003501dfaf7854ba43860cf87fdf2a67a17ebd4`.
These checks used the sanitized readiness harness from an empty working directory;
they did not read a developer environment file, install packages, connect to a
provider, start a runtime worker or connect to PostgreSQL. The root owns the
separate disposable PostgreSQL, TypeScript and production-build evidence.

To undo an operator configuration change, restore the earlier published profile
version through the existing management version workflow. A running session keeps
its pinned configuration. To roll back this code, review and reverse only this
runtime patch, preserving pre-existing dirty changes and the independent grounding
gate. The active-call control schema is introduced by `eb626a89c3a8`; its downgrade
refuses to discard nonempty command history. Returning endpoint,
provider, voice or global niqqud defaults is unnecessary because this patch did
not change them.
