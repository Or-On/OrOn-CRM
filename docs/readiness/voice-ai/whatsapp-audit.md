# WhatsApp grounding and action evidence — 2026-09-12

## Audited runtime and baseline

The active path is `services/ts/messaging-worker/src/database.ts`:
signed/deduplicated inbound event → committed canonical message → durable
`whatsapp.ai.reply` job → `ai-provider.ts` → existing CRM outbound request/job →
`providers.ts`. The existing Meta and dispatcher adapters run outside database
transactions. Ownership, enabling-operator authorization, consent/opt-out,
service window, sender configuration, idempotency, claim leases and provider
kill switches already existed and remain required.

Before this change, JSON-valid model `text` reached the outbound queue without
eligible knowledge or action evidence. Prior assistant statements and caller
claims used ordinary model history roles. AI jobs identified a conversation but
not their triggering message; a delayed job could consume a newer caller intent.
Callback acknowledgements used model wording before a connected-call result.
Outbound authorization was checked before delivery but not after an internal
429 retry delay. Callback dispatch lacked a pre-effect claim-lease check and a
persisted ownership epoch.

The actual WhatsApp callable actions are a pending operator handoff and a
guarded durable callback through the existing published cross-channel/retained
voice-flow path. There is no WhatsApp agent refund, payment verification,
subscriber lookup, ticket creation, calendar booking or identity-verification
tool. A CRM screen does not expose those operations to this agent.

## Implemented policy and interfaces

`ai-grounding.ts` constrains customer delivery to an exact eligible approved
statement, a closed bilingual conversational response, or a server-rendered
acknowledgement of an actual durable action. Arbitrary model text is never used
for a material answer, including when the model also supplies a valid source
identifier. Harmless legacy greetings remain compatible. Clarification, thanks
and acknowledging an unverified caller report have explicit reply codes.

`loadEligibleAgentKnowledge` in `packages/ts/crm/src/knowledge.ts` supplies
tenant-isolated, selected, published-agent knowledge. It chooses the latest
published document per selected source before applying revocation and validity;
it does not fall back to an old document after the latest is revoked or expired.
The runtime uses `{sourceId, documentId, version, factKey, value}` projections.
The model selects `documentId` and `factKey`; the server resolves the actual
value. Conflicting values for one fact key produce an honest clarification.
Known role-spoofing/instruction passages, control/markup characters and operation
completion claims are rejected even inside a published statement.

The worker reads eligibility before inference, again before queue admission,
again when queued work is claimed, and immediately before each actual Meta
attempt. Message `provider_payload.aiGrounding` stores the agent version,
trigger-message ID, selected evidence identity/version/digest and rendered-text
digest. Delivery reloads the source or durable action record and checks the
rendered result against the queued text. Model-generated receipts, forged IDs,
caller-reported payment/discount claims and previous assistant statements cannot
authorize customer-facing facts.

Each history entry retains its message ID, timestamp and
`caller_report_unverified` or `prior_assistant_unverified` provenance. Inference
receives these entries as data in one user message. Bounds are twelve messages,
8,000 text characters, and forty safe facts fitting 12,000 characters; truncated
entries are marked. These labels supplement deterministic output enforcement;
JSON encoding alone is not a prompt-injection defense. Callback continuity labels
each line as a customer report or previous assistant statement, both unverified.
Whitespace cleanup prevents a message from manufacturing an additional speaker
line. Continuity remains bounded, transient and outside job payloads/logs.

The exact inbound message is bound to each new AI job. A superseding inbound
message invalidates a generation or queued reply. Current tenant actor,
ownership epoch and claim lease are rechecked at queue/delivery boundaries.
Meta `beforeAttempt` rechecks after rate-limit delays and preserves the existing
bounded retry/unknown-outcome behavior. No database transaction spans HTTP.

Callback admission and execution both use the same conservative accepted-intent
predicate exported by the canonical CRM package. Quoted, negated, third-party,
future and role-spoofed requests do not qualify. Callback payloads now carry the
ownership epoch; a later human takeover/resume cannot resurrect an old request.
The worker rechecks the lease, latest trigger, actor, consent, destination and
published flow before dispatcher invocation. A failed obsolete callback cannot
overwrite a later resumed conversation. Same-parameter idempotency replay returns
the original job; changed parameters, including the ownership epoch, are refused.
Admission also pins the exact published canonical flow version and agent version.
The worker revalidates their retained flow ID/version binding before passing
`agent_version_id` and `flow_version` to the dispatcher. Another agent's newer
canonical flow cannot silently replace the selected callback persona/knowledge.

Callback text reports recorded queue admission and explicitly does not equate
that with a connected call. Handoff text reports a pending review only after the
handoff row exists; it never announces a connected operator. Delivery reloads the
scoped receipt and refuses stale or unrelated evidence. Safe diagnostic codes
`ai_evidence_changed`, `ai_evidence_invalid` and `ai_trigger_superseded` contain no
customer content.

The existing operator/simulator `requestHandoff` admission now atomically binds
an idempotency key to its contact, requesting actor, source channel, normalized
reason, flow run, conversation and voice session. A changed parameter receives
the existing sanitized 409 response without returning or modifying the original
receipt. Optional identity references default to null for existing callers;
canonical simulation passes its actual flow run and conversation. An exact
replay returns the current pending/accepted/resolved state and cannot reset it
or imply an external human connection. No API payload or provider-default
expansion was needed.

## Verification performed

Node 24.20.0 from the pinned repository toolchain was used. Child test processes
received an explicit environment allowlist; no `.env` was read, provider secret
was reused, worker daemon was started, or real inference/message/call occurred.

- 36 typed grounding cases cover exact fact rendering/critical-value retention,
  missing eligible projections, conflicting keys, Hebrew/English/mixed forged
  receipts and manager authority, malicious published statements, ordinary
  conversation and positive/negative callback intent.
- 19 model-adapter fixture tests cover bounded structured decisions, untrusted
  provenance, rejected receipt fields, HTTP classifications and malformed output.
- 30 provider fixture tests include no HTTP after rejected evidence and fresh
  authorization after a 429 delay.
- 11 dispatcher-adapter fixture tests include optional exact agent/flow-version
  serialization and rejection of malformed bindings before HTTP.
- 11 existing isolated PostgreSQL readiness tests passed, preserving consent,
  opt-out, ownership, claim, idempotency and unknown-outcome behavior.
- The expanded isolated PostgreSQL AI orchestration test passed under
  `platform_web` and `platform_messaging`. It exercises signed inbound
  deduplication, published fact delivery despite malicious generated prose,
  callback admission/receipt, actual source revocation after queueing, current
  trigger supersession during generation and human takeover during inference.
  It also proves callback replay, changed-epoch key rejection, and rejection of
  an old callback after human-to-AI resume without overriding resumed ownership.
  Provider/dispatcher boundaries are fakes, including the pre-attempt SQL check.
- Strict worker TypeScript, scoped ESLint, formatting and the CRM build passed.

The package-wide source-only TypeScript run before the handoff follow-up passed
673 tests with 52
explicitly gated skips across all eleven packages (103 passing test files and
14 skipped files). Emitted `dist` copies were excluded. All eleven package
typechecks passed. After the last web-only changes, the full web package again
passed 414 tests with one database-gated skip; this rerun is not added to the
consolidated total. Repository ESLint and formatting checks passed. Exact
commands and sanitized process results are recorded in
`.artifacts/readiness/merge-validation/voice-ai-final-ts.py`,
`voice-ai-followup-ts.py` and their named logs. Node's process-local
`voice-ai-no-runtime-env.cjs` guard prevents Next's automatic loading of real
workspace/web environment files during type generation. These checks did not
run a production build or access a database.

After the fixture preview was stopped, the separately authorized production
`pnpm build` passed for all eleven workspace packages in 24.91 seconds, using
the same pinned toolchain, sanitized environment and Node environment-file
guard. Next reported 98 dynamic routes (72 API routes and 26 page routes) plus
Proxy middleware. The build log reported no warnings or deprecations. Evidence:
`.artifacts/readiness/merge-validation/voice-ai-final-build.py` and
`voice-ai-final-build.log`. The build did not start a runtime server or load the
original workspace/web environment files.

The subsequent handoff-admission follow-up passed 12 new actual PostgreSQL
cases, 16 new API boundary cases, CRM/web typechecks, CRM build and scoped
ESLint/formatting. The PostgreSQL cases use `platform_web` within fresh UUID
tenant/user fixtures, roll back the entire fixture transaction, and verify the
tenant row is absent afterward. One existing isolated canonical voice-flow
simulator regression also passed; its other eleven cases were deliberately
filtered out, not failures. Its first setup attempt hit `uv` workspace
re-resolution before any test ran; rerunning with `UV_NO_SYNC=1` used the already
validated installed environment successfully. Its unique generated database was
dropped in test teardown. Exact evidence is in
`.artifacts/readiness/merge-validation/voice-ai-handoff-binding.py` and
`voice-ai-handoff-*.log`. These focused results are not summed into the earlier
package-wide count.

The PostgreSQL tests create unique disposable databases on the explicitly
designated loopback readiness instance, apply the canonical Alembic head and
fictional seed, and drop only those generated databases in teardown. The shared
readiness database's tenants were not modified. A first root-scoped Vitest run
also collected obsolete `.artifacts` copies and failed on a missing historical
module; the corrected package-root run passed.

These are deterministic repository/fixture results. They do not measure provider
semantic accuracy, real WhatsApp delivery, speech, latency or acoustic quality.

## Active voice AI control UI follow-up

`VoiceAIControls` is integrated into the active call inspector for non-simulator
calls. The new session-control BFF GET/POST uses the generated control API
client, fresh `voice:read` / `voice:operate` authorization, short-lived service
grants and no-store responses. POST checks CSRF before parsing a closed command
schema, preserves exact expected epoch/idempotency key, and does not perform
HTTP inside the authorization transaction. Error responses are sanitized;
upstream conflicts remain 409 and network failures remain uncertain 503.

The UI displays current worker acknowledgement separately from requested state.
It never says a human is connected: these commands only pause/resume AI in the
existing call and do not start a new call or manage a human transfer. Read-only
users receive no mutation controls; the fresh server `can_operate` value is
authoritative. Resume requires an explicit confirmation mentioning resumed
speech/paid processing. Recovery remains possible when the worker requires an
explicit resume, even if the desired state is already AI; pause can supersede a
pending resume. A missing initial acknowledgement is not shown as a recorded
resume command.

Visible active sessions poll every two seconds with bounded abortable requests.
Unmount/session navigation aborts requests and ignores stale responses. Ended
calls and revoked access stop polling. An uncertain POST result causes a status
read, never an automatic command retry; only an explicit retry after successful
unchanged-epoch read reuses the exact original key. A 409 reloads status without
retrying the command. Buttons do not imply carrier playback has stopped or that
audio already delivered externally can be recovered.

Forty targeted tests passed: eighteen BFF, eighteen component state/race tests,
three fresh-authorization/transaction-boundary client tests and the existing
live-pricing regression. ESLint, web typecheck, API client build, formatting and
diff checks passed through the pinned sanitized harness. Evidence is
`.artifacts/readiness/merge-validation/voice-ai-controls-check.py` and
`voice-ai-controls-*.log`. These tests use mocked HTTP, not a running worker,
provider audio or native browser proof. Python/DB control execution is verified
separately by the voice-runtime slice. These focused counts are not added to
the earlier package-wide suite count.

## Compatibility, rollback and remaining limitations

This slice adds no migration of its own; it consumes knowledge lifecycle revision
`17f57105f1a9` supplied with the management work. Published agents without selected
eligible facts can still greet, clarify and request review. Unrestricted business
generation is intentionally unavailable. Old queued AI jobs lacking a trigger,
old callback jobs lacking an ownership epoch, and old agent messages lacking
grounding metadata fail closed; they must not be blindly replayed after upgrade.
Callback jobs also require their pinned agent and canonical flow version IDs.

An operational rollback should disable WhatsApp AI/callback admission, retain
human ownership and the existing provider kill switches, and deploy the prior
application image only through the normal authorized deployment process. Do not
drop published knowledge or rewrite recorded receipts to make old jobs run. This
work did not deploy or change any feature flag.

Approved facts remain operator-authored complete statements, not typed price,
date or eligibility records. Exact rendering prevents model fabrication of their
values, but cannot establish that a mistaken published statement is true. The
known-instruction/action-content filter is conservative and finite; publication
review, further structured business schemas and adversarial evaluation remain
necessary. Relevant facts beyond the bounded context can lead to clarification;
there is no claim of complete semantic retrieval. Strict callback phrasing can
defer legitimate paraphrases to a human. No sensitive account-read or financial
write tool was introduced. Provider failures still use the existing bounded job
error path. A tiny database-check-to-HTTP interval remains; already accepted
external effects cannot be undone by a later ownership change. Current tests do
not establish universal prompt-injection resistance or live-provider quality.
