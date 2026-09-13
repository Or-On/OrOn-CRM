# Voice AI quality — integration evidence

Date: 2026-09-12 (Asia/Jerusalem).
Baseline: `codex/phase-7-ui-polish`,
`7afa8534fc89259cd679da7ff58ec7546bd01b14`, 555 existing changed paths.
Existing changes were preserved. No commit, push, reset or upstream edit occurred.

## Status and scope

Locally verified implementation checkpoint. Consolidated repository checks and
isolated PostgreSQL integration passed. This is not a claim that the entire
voice-quality brief or configured-provider speech acceptance is complete.
No telephone call, WhatsApp message, paid model/TTS request, recording upload,
native listening review, cloud operation or application-worker restart was run.
Provider defaults, credentials and the developer `.env` were not changed.

After this implementation gate, the user separately authorized local migration.
The application database was backed up, restored/rehearsed in a network-disabled
PostgreSQL 18.6 container, and upgraded from `bfb741c767fd` through
`17f57105f1a9` to `eb626a89c3a8`. All 77 pre-existing business-table
original-column fingerprints and role settings remained unchanged; the new
control tables are empty. No worker was started. See
`../local-schema-alignment.md` for the protected backup and catalog evidence.

## Implemented behavior

- Immutable published knowledge and agent quality settings; exact agent/flow
  versions pinned per call, with current source access checked before output.
- Evidence-bound spoken/WhatsApp replies, conflict/revocation/expiry checks,
  caller claims distinguished from approved knowledge and backend outcomes.
- Accepted versus provisional recognition, explicit grammatical-address
  corrections, neutral/unknown address and independent agent first-person grammar.
- Hebrew time/amount/negation-preserving regressions, bounded pronunciation
  dictionaries and speech-only normalization. No global generated niqqud enabled.
- Complete-turn validation and interruption cancellation; durable AI pause/resume
  with separate requested and acknowledged status, not an invented human join.
- Bounded, content-free stage timing summaries in call details; missing timing
  remains unknown and transport submission is not exact far-end playback proof.
- A source/version editor, deterministic scenario check, explicit paid TTS
  preview and explicit read-only LLM scenario evaluation in the existing UI.
- Durable callback/admission and handoff idempotency bindings; stale queued
  WhatsApp replies recheck ownership, consent and source eligibility per attempt.

Details and file-level provenance are in `feature-matrix.md`, `runtime-audit.md`,
`management.md`, `whatsapp-audit.md` and `source-claim-policy.md` in this directory.

## Observed before/after, not acoustic claims

The pre-change focused runtime suite passed 101 tests but did not cover the
newly identified defects. Added fixtures show that `10:15–11:45` keeps minutes,
currency decimals and separated quantities keep their meaning, quoted/third-party
address statements do not switch the caller's preference, and current explicit
corrections supersede an operator default. Orphan output after interruption is
discarded. Synthetic PCM tests preserve a 40 ms onset prefix and drop cancelled
audio; they do not prove intelligibility or Hebrew prosody.

Previously generated prose could announce an unsupported business outcome. The
new validator emits exact currently eligible statements or bounded conversational
responses. This is deliberately conservative and can cause false refusals or
less varied conversation. It needs real scenario evaluation before rollout;
passing fixture claims is not proof of natural, unrestricted conversation.

No comparable before/after call recording was evaluated. Live latency, Hebrew
pronunciation, accent/noise performance and naturalness have no newly measured
improvement percentage. Local test wall time is not response latency.

## Browser evidence

The disposable fictional preview used a separate database/login and no provider
credentials. Browser interaction verified the existing quality inspector,
loading, empty knowledge, explicit deterministic output, draft/test/publish and
reload persistence. An earlier fixture saved/published version 2 with masculine
caller address and retained that selection after reload.

The final preview pass inspected both new paid-evaluation panels in Hebrew RTL /
dark and English / light. At the narrow responsive breakpoint the measured
inner width was 330 px and content width 318 px, with no horizontal overflow.
Labels, consent checkboxes, warnings and buttons remained visible and aligned.
No paid evaluation button was submitted; the browser reported no warning/error
entries during that pass. These are visual/interaction checks, not audio evidence.
The temporary tab was closed, viewport restored, and preview database/login
removed by the owned shutdown path. Developer data and queues were untouched.

## Verification record

All logs below are under `.artifacts/readiness/merge-validation/`. Tests ran with
installed Python 3.14.7, Node 24.20.0 and pnpm 11.24.0 through a sanitized
environment; no dependency installation or developer `.env` read was required.
Focused runs overlap larger suites and must not be summed into an inflated total.

| Gate                                                             | Final result                                                                   | Evidence artifact                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Consolidated Python + infrastructure                             | 1,095 passed; 118 skipped; five warnings; 30.62 s                              | `voice-ai-final-python-tests.log`                                                                                     |
| Fresh PostgreSQL 18.6 migrations/integration                     | 117 passed; zero skipped; 86.48 s                                              | `voice-management-fresh-upgrade.log`, `voice-management-fresh-postgres.log`                                           |
| Consolidated TypeScript, source tests only                       | 745 passed; 64 skipped across 11 packages; web subset 485 passed / one skipped | `voice-ai-final-ts-tests.log`                                                                                         |
| CRM with fresh PostgreSQL and limited web role                   | 99 passed; 17 skipped; includes 83 overlapping non-DB tests                    | `voice-ai-final-crm-postgres.log`                                                                                     |
| Worker queue/ownership integration                               | 11 passed against its fresh isolated PostgreSQL DB; fake provider boundary     | `voice-ai-final-worker-postgres.log`                                                                                  |
| Focused approved-knowledge persistence                           | Four PostgreSQL tests passed (11 overlapping unit tests in same run)           | `voice-management-tests.log`                                                                                          |
| Focused handoff identity/idempotency                             | 12 PostgreSQL tests passed                                                     | `voice-ai-handoff-postgres.log`                                                                                       |
| Strict typing                                                    | Pyrefly zero errors; all workspace TypeScript checks passed                    | `voice-ai-final-pyrefly.log`, `voice-ai-final-ts-types.log`                                                           |
| Lint and formatting                                              | ESLint, Ruff, Prettier passed; 401 Python files formatted                      | `voice-ai-final-eslint.log`, `voice-ai-final-ruff.log`, `voice-ai-final-format.log`, `voice-ai-final-ruff-format.log` |
| Production build                                                 | All 11 application/library builds passed                                       | `voice-ai-final-build.log`                                                                                            |
| Contract freshness                                               | Four generated artifacts unchanged across two regenerations                    | `voice-ai-contract-freshness.json`                                                                                    |
| Migration graph and deterministic SQL                            | One head, 59 revisions, 22 preserved Or-on revisions; 258,935 bytes            | `voice-ai-final-db-offline.log`                                                                                       |
| Boundaries, dependency peers, secrets, documentation, whitespace | Repository/peer/secret-pattern/documentation/diff guards passed                | `voice-ai-final-{repository,peers,secrets,docs,diff}.log`                                                             |

The Python non-DB run deliberately skips PostgreSQL and the paid LLM exit
evaluation. The separate database run executes 117 database tests; no paid test
was enabled. TypeScript opt-in skips are not counted as passes: the CRM preview
and readiness tests use different explicit fixture variables. The four knowledge
and 12 handoff tests above cover their separate readiness surface. Remaining
opt-in scenarios are not silently promoted to live acceptance.

The five Python warnings are retained SDK/test deprecations (Pipecat TTS,
Google typing, Starlette/httpx) and two warnings for a short fictional JWT test
key. No provider key was inspected or used. Existing dependency/image-security
release blockers were not cleared by repository/secret-pattern guards.

Independent cancellation regressions caught and repaired a swallowed SDK
cancellation after partial PCM. On rerun, the 0.5 s timeout completed in 0.511 s;
the service returned 504 in 0.515 s; explicit cancellation propagated. All three
cases returned no partial audio and left zero extra asyncio tasks
(`tts-cancellation-independent-rerun.log`). Six installed-Soniox fake-socket
tests passed: old recognition buffers/callbacks cannot become accepted commands
after resume (`stale-soniox-independent-rerun.log`). These are bounded local
lifecycle observations, not provider-network performance measurements.

The final PostgreSQL suite initially exposed duplicate checksums in newly added
test versions. Each fixture version now has a distinct checksum; the database's
unique constraint was preserved. The passing run used a freshly upgraded
UUID-named DB, then removed it. CRM and worker fixtures also removed their owned
databases/logins. No test reset, seed or migration reached the application DB.
Final catalog inspection found only the reusable `oron_readiness` database and
zero temporary preview login roles. The owned readiness container was stopped;
its fictional base data and verification logs were retained for reproducibility.

Deterministic SQL SHA-256:
`1ddcf104453cbe4ea270f46da003501dfaf7854ba43860cf87fdf2a67a17ebd4`.

## Migration and configuration impact

One active Alembic head: `eb626a89c3a8`, after knowledge revision
`17f57105f1a9`, after application baseline `bfb741c767fd`. The offline graph has
59 revisions, including all 22 unchanged imported Or-on revisions. New tables
are tenant-RLS owned; runtime roles cannot manufacture desired-state commands by
direct table updates. Protected knowledge and command history refuse destructive
downgrade. Migrations do not seed live customer records.

New agent quality JSON uses schema version `1.0`. Published agent versions and
existing flows do not change simply because the editor saves a draft. Bind and
publish a new flow version deliberately. Publish reviewed business facts before
expecting fact-based answers; the agent's persona prompt is not an approved
source. Previously queued jobs lacking required bindings fail closed rather than
being blindly replayed.

## Remaining acceptance and limitations

- Actual configured STT, TTS and LLM provider responses, native Hebrew listening,
  telephone-band recording, pause/resume across real sockets, echo/noise,
  interruptions, packet loss/reconnect and representative concurrency remain
  pending separately authorized evaluations.
- The fictional text corpus has development/reserved regression subsets and
  null audio references. It is not an unseen acoustic benchmark or consented
  microphone-upload/recording evaluation workflow. No WER, pronunciation or
  quality/latency SLA is claimed.
- AI pause/resume is not a human media-join/transfer implementation. Existing
  SIP transfer configuration needs actual routing and playback acceptance; no
  connection claim is made without that evidence.
- The current voice registry exposes routing/collection, not arbitrary CRM,
  account-verification, booking or financial tools. The UI displays existing tool
  grants; it does not invent tools, a general permissions/confirmation editor or
  monetary spend enforcement. Token/session-duration caps are not dollar caps.
- Exact approved FAQ statements are supported. General document paraphrase,
  specialized typed business records, deeper authorized CRM tool connectors and
  production transcript/audio-retention controls need further scoped work.
- Operator-authored flow scripts retain their existing path and need publication
  review. They are not made universally safe by the LLM's grounding gate.
- Existing GCP packaging, first-admin bootstrap, security/dependency/image and
  operational readiness gaps are independent; this task does not clear them.

## Safe rollout / return to prior configuration

The two reviewed migrations were subsequently applied through the guarded local
backup/rehearsal workflow and the exact head was checked. Starting matching
service builds remains user-controlled; no automatic queue replay or provider
enablement accompanied migration. The optional control API voice runtime must be
packaged before paid previews can operate.

Create/test/publish a new version based on a prior saved profile to restore its
configuration; do not mutate published history. Prefer forward schema repair;
do not downgrade away protected knowledge or command audit. A code rollback
must isolate this task's changes from the extensive pre-existing dirty tree.
The next live acceptance is one explicitly authorized fictional-scenario session
with approved facts and a recorded native-Hebrew listening rubric, not deployment.

## Preserved repository state

No clean commit was created: HEAD remains
`7afa8534fc89259cd679da7ff58ec7546bd01b14` on `codex/phase-7-ui-polish`.
The final worktree contains 644 changed tracked/nonignored paths, including the
555-path pre-existing baseline. It is intentionally uncommitted, not clean.
The three read-only upstream worktrees remain clean at their locked SHAs:
Or-on `cece174f4d590a1b8a283d539dd66e08cc689aa9`, WACRM
`98b5bd26e8feacacfd4b74ff58411acb8154d212`, OpenLive
`849173cd1c8c17a95d600b17b428c301722bf5df`.
