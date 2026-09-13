# Voice AI evaluation and local rollout

## Reproducible local checks

Use a credential-free environment with all real-provider flags false. Do not
start the development runner to run tests; it reads the real `.env` and can
process existing queues. This task uses the already labelled, task-owned
PostgreSQL 18.6 fixture on loopback 55439, never the application database on 5433.

1. Run targeted `oron-agent` grounding, corpus, recognition, caller-address,
   turn-planner, TTS/normalizer and observer tests.
2. Run dispatcher persistence tests, CRM quality/knowledge tests, web component
   tests and messaging-worker AI/provider tests with fake HTTP.
3. Upgrade only the isolated PostgreSQL fixture; execute actual RLS/publication,
   source-revocation, tenant authorization and worker queue tests there.
4. Run consolidated Python/TypeScript tests, lint, strict typing, production
   build, contract freshness, graph and deterministic offline SQL checks.
5. Record exact results in `results.md`. Do not turn a skipped provider test into
   a passing audio check.

## Corpus and measurement

`packages/py/oron-agent/tests/fixtures/voice-quality-v1.json` is versioned,
fictional and PII-free. Its 14 families include claims, money/date corrections,
address preferences, spoofed receipts, stale knowledge, action state,
interruptions, takeover, noisy fragments, pronunciation, summary laundering and
version boundaries. Development/reserved partitions are reproducible regression
subsets, **not** a statistically unseen provider benchmark. Model outputs are
supplied adversarial fixtures, not recorded provider inference.

For ordinary word-error comparison normalize NFKC and whitespace only; report
Hebrew vowel/punctuation normalization separately. Never normalize away negation,
amounts/currency, dates, identifiers, corrected intent or grammatical address in
critical-field accuracy. A useful acoustic result includes reference text,
speaker consent, codec/sample rate, noise/channel, provider/model/version,
published profile/version and review method. No real audio is included here.

## Explicit later provider acceptance

Requires separate authorization for the exact call/recipient and paid provider
usage. Do not reuse a historical authorization for a new call.

- Use a fictional test contact and approved test knowledge; inspect flags and
  source/flow version before admission. Confirm no unrelated queued work starts.
- Exercise a Hebrew greeting, masculine/feminine/neutral preference and later
  correction, “לא ביום ראשון — ביום שני”, 15/50, 150/1,500, 10:15–11:45,
  names/brands, mixed English/Hebrew, silence and short acknowledgments.
- Try interruption during generation, validation and speech; check stale audio,
  cutoff recovery and handoff/consent revocation. Confirm mutations from real
  receipts only. Observe failed/queued/unknown status without invented success.
- Review the existing protected stereo recording. At least one fluent/native
  Hebrew reviewer must score pronunciation, word boundaries/questions, address
  consistency, naturalness and interruption recovery on a written 1–5 rubric.
  Record who/which method reviewed it; an STT round-trip or LLM judge alone is
  insufficient. This implementation performed **no** native listening review.
- Measure accepted-end→STT-final→model-first-token→validation→first synthesis→
  transport-start p50/p95 with sample count/conditions. Transport start is not
  word-exact far-end hearing. Report premature cutoffs and false refusals too.
- Compare against the same pre-change scenario/channel. Set latency and
  naturalness release thresholds from these observations; none are invented here.

## Migration and rollback

New authority: Alembic `17f57105f1a9` after `bfb741c767fd`, followed by
`eb626a89c3a8`. The first versions existing knowledge documents and protects
publication; the second adds tenant-scoped, durable AI pause/resume commands and
worker acknowledgements. Neither imports customer data.
The task's earlier schema alignment put the application at `bfb741c767fd`.
After the implementation gate, the user separately authorized the guarded local
rollout: a private backup was restore-tested in a network-disabled PostgreSQL
18.6 container and both successors were applied. The application database is now
at `eb626a89c3a8`; no application worker or provider was started by migration.

The local migration prerequisite is complete. Before any other environment's
rollout: stop all application writers, verify/restore-test a private backup,
apply both reviewed successors, check current/head, then restart matching
app/worker builds. Never delete or recreate a real DB.
Restore a prior profile by creating/publishing a new version; do not mutate
immutable published rows. Revoke sources to withdraw facts. Prefer forward
repair to destructive schema downgrade; read the migration guard before any
downgrade and preserve published knowledge and voice-command history. Both new
migrations refuse destructive downgrade once protected history exists. The new
worker and UI require these successors; do not start a mixed-version rollout.

## Operator previews and active-call control

The deterministic typed check is credential-free and does not exercise an LLM,
microphone, STT or TTS. It checks approved-source selection and constrained
rendering. Keep this distinction when recording its timing.

The separate paid typed-model evaluation requires current management permission,
a published voice-capable agent, explicit per-request confirmation and
`ENABLE_REAL_VOICE_PROVIDERS`. It sends the deliberately entered scenario,
published profile and eligible approved facts to the configured LLM. Use
fictional examples only. It does not call a number, run STT/TTS or execute tools.
Source authorization and validity are rechecked after inference; the result
shows only the validated answer/decision, exact eligible source references,
provider/model and measured model/validation timings. Raw model output is not
returned. Recognized speech and monetary cost are unknown, not fabricated zero.
Cancellation cannot undo provider processing or charges already incurred.

The separate audio-preview action requires a published voice-capable agent,
current management permission, explicit confirmation and the existing
`ENABLE_REAL_VOICE_PROVIDERS` switch. It sends only the deliberately entered test
text through the configured TTS adapter. Do not include customer information.
It does not call a telephone number, run recognition or invoke business tools.
The result exposes canonical and speech-normalized text with a bounded temporary
WAV, not an uploaded call recording. No inference runs on page load or save.
Preview cancellation cannot undo provider work already accepted or its charges.
Both paid paths require the control API's optional `voice` dependency group to
be packaged. The lightweight API still starts without it and refuses the paid
path safely; a provider flag alone does not install the runtime.

An active real call has an AI pause/resume panel. A requested pause is not an
acknowledged pause: wait for the worker state. Lost/stale control is reported as
unconfirmed; recovery requires explicit resume. Resuming can continue paid work
in the existing call and requires confirmation. These controls do **not** dial a
human operator or establish a media bridge. Existing transfer configuration and
actual far-end playback must be validated separately.

## Remaining release gates

Configured-provider STT/TTS/LLM compatibility, actual pronunciation/prosody,
telephone/echo/reconnect behavior, native listening and comparative latency/cost
remain pending unless `results.md` records a real execution. Existing GCP
readiness/security blockers are independent and are not cleared by voice tests.
