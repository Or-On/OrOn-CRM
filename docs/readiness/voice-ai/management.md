# Agent quality and knowledge management — local implementation evidence

This checkpoint extends the existing Agents & Flows inspector. It preserves the
current agent register, connected-flow editor, Inbox, and all provider gates.
Persistence uses the existing tenant PostgreSQL transaction; paid provider work
runs outside database transactions. Management
requires an active owner/admin or platform administrator; mutations additionally
take the fresh session/authorization locks through `withFreshCurrentTenant`.

## Implemented workflow

1. Open an agent under Agents & Flows, then **Quality and approved knowledge**.
2. Create a manual knowledge draft: title, source content, individually approved
   complete statements with stable subject keys, and UTC validity interval.
3. Publish the source. Select it in the agent configuration. A new knowledge
   version preserves the previous document; revocation removes source access
   immediately. Only the latest published version can be retrieved, and an
   expired, future-dated, or revoked latest version never falls back to an older
   publication. Legacy content is unapproved until explicitly authored/published.
4. Configure language, voice identifier, agent first-person grammar, independent
   default caller address, pace, style, vocabulary, pronunciation entries,
   clarification/human-assistance behavior, response-token and session-duration
   budgets. Empty voice identifier keeps the existing provider/flow voice.
5. Save a new immutable-version candidate, run its deterministic test, then
   publish. Testing missing/conflicting sources marks that candidate invalid.
   Publication checks source eligibility again. The latest candidate must pass;
   an older valid draft is not silently published when the latest is invalid.
6. Create and publish a connected flow that references the new agent version.
   Publishing an agent does not rewrite existing flows or change an active call.
   To restore a prior configuration, select it in version history, save a new
   draft, test, publish, and explicitly bind a new flow version.
7. For a published version, optionally enter a fictional scenario and explicitly
   confirm a paid, read-only model evaluation, or confirm a separate paid speech
   preview. Neither panel runs automatically, and neither changes a live flow.

The editor preserves existing provider/channel configuration and tool grants.
It shows currently permitted tool names but cannot grant nonexistent CRM tools.
Explicit caller correction still takes precedence over the operator default.
Pronunciation entries operate on speech-only text: bounded vocabulary, targeted
Hebrew pointing, and authored Latin-name transliterations. Numeric, money,
negation, address, authorization/status, markup/control, and Hebrew-consonant
changes are rejected. Entries carry language, literal context cues and examples.

## Persistence and retrieval contract

Generated Alembic revision `17f57105f1a9` follows `bfb741c767fd`. It adds document
version, publication, validity, and revocation columns to existing knowledge
tables, with uniqueness/interval constraints and immutable published document
and chunk triggers. A source-row lock assigns a version to legacy INSERTs that
omit it; those rows remain unpublished. Existing PostgreSQL full-text search
is retained. Both `platform_voice` and `platform_messaging` receive SELECT only
on these tenant-RLS tables; they do not acquire write privileges.
The voice runtime checks active tenant status through the zero-argument,
current-context-only `platform.current_tenant_active()` function. Only the
voice role receives EXECUTE; no tenant-table read privilege is granted.
The same migration grants the voice role EXECUTE on the existing
`platform.canonical_actor_authorized()` function for fresh preview management
authorization, without granting raw user or membership table access.

`agent_profile_versions.knowledge_configuration` is
`{schemaVersion: "1.0", sourceIds: [UUID, ...]}`. The source status must currently
be `published`. Document metadata is
`{schemaVersion: "1.0", facts: [{factKey, value}, ...]}`. Keys identify the same
business subject across sources; different eligible values under one key are a
conflict, not a model confidence score. These are exact approved FAQ statements,
not independently verified prices/dates or execution receipts. Specialized typed
price/date/product schemas and arbitrary document semantic grounding remain
outside this bounded slice.

`loadEligibleAgentKnowledge(sql, agentVersionId)` exposes tenant/source/document
IDs, document version, publication timestamp, validity, title, and approved facts.
The caller must authorize its actor before retrieval; shared runtime callers also
recheck eligibility before delivery. Caller claims, previous assistant text,
free-text tool output and model-supplied source identifiers cannot publish facts.
The profile's quality JSON lives in `channel_configuration.quality` schema `1.0`;
the retained runtime adapter consumes the same contract.

## Three separate evaluation paths

The original typed evaluation is labeled **deterministic**. It takes an optional exact
fact key and returns the approved statement or a clarification, eligible source
references, conflicts and measured deterministic-validation time. It does not
infer what question a model would answer. STT/LLM/TTS timings are null, provider
cost is zero because none ran, and no tool receipt or successful handoff is
fabricated. Raw recognition is null; accepted input is the unchanged typed text.
Evaluation content exists in the requesting browser state only; persistent audit
records store operation/actor/version identifiers, not transcripts or recordings.

The separate **paid typed model evaluation** uses the configured, retained LLM
adapter only after explicit confirmation. It accepts up to 1,000 plain-text
characters and pins the selected published agent version. No tools, STT, TTS,
messages, calls, or business actions run. The model selects an evidence-bound
answer; eligible knowledge and manager access are reloaded before rendering.
The UI receives only the validated answer, decision, source/version references,
accepted text and measured model/validation times. Raw model selections, private
reasoning and malformed output are not exposed. Cost is unknown, not zero.

The separate **paid speech preview** accepts up to 300 plain-text characters and
uses the existing Soniox/Gemini TTS adapter and published speech configuration.
The UI distinguishes canonical text from speech-normalized input; neither is
presented as recognized or exactly heard speech. The response is a private WAV
held in browser memory with a 60-second object-URL expiry and cleanup on version
change/unmount. No server audio object or recording is persisted. Generated
speech is not an automatic pronunciation approval, and STT/LLM do not run.

Both paid endpoints require an explicit boolean confirmation, fresh
`flows:manage` authorization and CSRF protection before the BFF issues the
service assertion. Exact tenant/agent/published-version binding and current
manager access are checked again in the API. The existing real-voice provider
kill switch is checked at both the service and lowest provider boundary. The
shared process-owned admission cap allows one paid request per tenant and two
total; this is not a fleet-wide dollar budget. Provider deadlines are 10 seconds
for typed evaluation and 15 seconds for speech, with bounded speech teardown.
Failed cleanup quarantines its admission slot until process restart rather than
releasing capacity while provider work might continue. Cancellation aborts HTTP,
discards late results, and requests backend cancellation; it cannot undo billing
for work already performed. Responses, including errors, are private/no-store.
Audits contain actor/version/request identifiers and status only. Context-local
Loguru and standard-library logging redaction protects provider text/errors while
preserving unrelated logs; existing patchers/factories are retained. Malformed
successful HTTP responses are rejected before rendering or creating audio.

The API's optional `voice` extra uses the existing `oron-agent` path dependency.
Core API startup and health checks do not import the heavy voice SDK. An absent
extra or disabled provider configuration returns a safe unavailable response.
The ordinary control-API Docker image intentionally remains lightweight and
does not include this extra or provider credentials; production packaging is
still a separate readiness gate. The existing locked voice development group
is compatible with this optional dependency. The lock was refreshed offline;
no package installation or provider configuration was performed in this task.

## Evidence actually obtained

Initial management checkpoint evidence (2026-09-12; focused runs overlap larger
suites and must not be summed):

- 11 configuration/fact tests passed: independent address/grammar/voice, bounds,
  safe targeted pointing, critical-value/role/receipt rejection and conflicts.
- 4 real PostgreSQL tests passed on the owned `oron_readiness` fixture at
  `127.0.0.1:55439`, with fictional tenants/users and transaction rollback:
  knowledge/profile persistence, draft/test/publish/restore, stale editors,
  conflicting publication, viewer denial, cross-tenant runtime reads,
  `platform_voice`/`platform_messaging` grants, immutable published docs/chunks,
  immediate revocation, expired/future latest-version no-fallback behavior.
- 5 new rendered component tests passed in English and Hebrew/RTL: accessible
  labels, independent form persistence, failed-save draft retention, explicit
  deterministic response, the then-pending audio disclosure, and hidden viewer
  management controls. The disclosure was subsequently replaced by the explicit
  paid panels above.
  The 5 pre-existing focused orchestration component tests also passed.
- 4 API tests passed: fresh flows-management persistence, read-only role denial,
  CSRF-before-publication, and unsupported lifecycle-action rejection.
- 3 migration regression tests and 2 lineage tests passed. Fresh UUID-named
  databases on the isolated readiness server proved predecessor upgrade,
  preservation of legacy content, automatic versions for legacy writers,
  unchanged PostgreSQL FTS, SELECT-only voice/messaging grants, unpublished
  downgrade/reupgrade, and refusal to drop published provenance. Each test
  database was removed in fixture teardown; the parent readiness database and
  application database were not changed by these tests.
  The narrow active-tenant helper is tested with missing context, active/deleted
  and nonexistent tenants, no arbitrary UUID parameter, no raw tenant-table
  privilege, and no additional messaging EXECUTE grant.
- The initial complete PostgreSQL suite passed on a fresh UUID-named database
  upgraded to the then-current knowledge head `17f57105f1a9`: 114 tests in 81.24
  seconds, including the runtime
  profile binding, durable admission/concurrency, quality-summary persistence,
  and retained flow immutability regressions. The runner removed that database
  successfully. This is an earlier checkpoint, not the current final-run log;
  the final rerun and its evidence are recorded in `results.md`.
  A subsequent fresh-database focused runtime run passed all 3 tests after the
  malformed configuration/inactive tenant regression was extended; this is a
  rerun, not 3 additional tests. Targeted log filenames are reused by subsequent
  verification, so the current final results are recorded separately in `results.md`.
- After the durable voice-control successor, the refreshed schema manifest and
  offline SQL contract have one head `eb626a89c3a8`, 59 revisions, 258935 SQL
  bytes and SHA-256
  `1ddcf104453cbe4ea270f46da003501dfaf7854ba43860cf87fdf2a67a17ebd4`.
  The final consolidated generation/freshness record is in `results.md`.
- OpenAPI and its TypeScript schema/client now include both paid endpoints and
  voice controls. The platform event contract remains generated. This does not
  add a cross-language generated schema for the new quality JSON.
- Web route generation/TypeScript and CRM build passed. Focused formatting/lint
  and the root consolidated gate are recorded in the final report.

Additional offline paid-path evidence:

- Installed-SDK synthetic TTS tests exercise normalized input, configured voice,
  WAV framing, empty/oversized/error rejection, partial-PCM timeout/cancellation,
  context-local privacy and preservation of existing logging hooks. The focused
  preview lifecycle run passed 20 tests; it did not contact a provider.
- An independent subprocess-watchdog regression repeated the formerly hanging
  partial-PCM case: a 0.5-second deadline raised `TimeoutError` in 0.511 seconds;
  the service returned 504 in 0.515 seconds with started/failed audit and released
  admission; explicit cancellation raised `CancelledError`. Each case left zero
  additional asyncio tasks and returned no audio. Log:
  `.artifacts/readiness/merge-validation/tts-cancellation-independent-rerun.log`.
- Injected typed-model tests cover current evidence, conflict/revocation fallback,
  no-tool context, safe errors, and explicit closure of the retained OpenAI HTTP
  client on success and cancellation. API, real-role PostgreSQL and UI tests
  cover version/tenant/manager isolation, consent, CSRF, no-store, admission,
  malformed responses and unavailable providers. Final totals are in `results.md`.
- The root's disposable browser pass inspected both paid panels in Hebrew RTL /
  dark and English / light. At 330 px inner width / 318 px content width there
  was no horizontal overflow, and no console warning/error was reported. No
  paid button was submitted. The owned preview, login and database were removed.

No user database, stored credential, provider account, real call, message send,
user application startup, or cloud resource was used. Actual recognition,
configured LLM/TTS response quality and native Hebrew listening remain pending.
Synthetic PCM and rendered components are not acoustic acceptance evidence.
The dedicated migration proofs are opt-in through `READINESS_POSTGRES_URL` and
skip in ordinary CI unless that local readiness fixture is explicitly selected.

## Migration/rollback and remaining acceptance

Apply the reviewed migration only through the established backup/rehearsal
workflow. The application database remains at its previously authorized head
until separately applied. New management/retrieval routes require the new head.
Published data is retained for audit; the existing tenant-delete operation is a
soft deletion and remains compatible. There is no runtime physical-purge UI.
Downgrade is rejected once any published knowledge exists, because dropping
publication/validity/revocation provenance would silently destroy evidence.
Use forward recovery or a separately authorized, tested backup restore.

Pending acceptance: separately authorized real-provider preview/evaluation,
consented audio samples with retention controls, actual listening and pronunciation comparison,
broader typed business facts and authorized CRM actions, and an audited physical
retention/purge process. None of these is presented as completed by this editor.
