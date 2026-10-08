# Agent reset continuation: release evidence

Observed 2026-10-08, Asia/Jerusalem. Tasks 6–8 were supplied and implemented.
This report extends the [core verification](unified-agent-reset-verification.md).
No main merge, operational agent activation or deployment occurred. The stated
18:00/19:00/19:30 deadlines had already elapsed when this continuation began.

## Review map and ownership

| Scope | Review branch | Pull request |
| --- | --- | --- |
| Core and tasks 1–5 | `codex/unified-agent-reset` at `306c4bb` | [#2](https://github.com/Or-On/OrOn-CRM/pull/2) |
| Task 6 | `codex/publication-bindings` | [#3](https://github.com/Or-On/OrOn-CRM/pull/3) |
| Task 7 | `codex/flow-editor-ui-review` | [#4](https://github.com/Or-On/OrOn-CRM/pull/4) |
| Task 8 | `codex/whatsapp-locale-callback` at `842aee9` | [#5](https://github.com/Or-On/OrOn-CRM/pull/5) |
| Combined candidate / task 9 | `codex/release-integration-20261008` | [#6](https://github.com/Or-On/OrOn-CRM/pull/6) |

Task 6 owned migrations, generated clients and shared contracts. UI work used
that contract; task 8 owned locale/lead/callback changes. Integration owns the
shared prompt extraction, provenance, restore correction and release evidence.
Task 7 is stacked on task 6; task 8 is stacked on the core. Feature PRs are
review units, not independently deployable releases.

## Implemented behavior

Explicit `follow_published` and `pinned` policies cover canonical agent,
retained voice node, optional node agent and reviewed process references.
Historic ambiguous references stay pinned. The reviewed OrOn reset plan can
opt in per trigger, with audited impact. New admissions receive a complete
approved immutable bundle; already admitted calls and existing chats retain
their snapshot. Rebinding eligible AI chats increments ownership fences and
excludes removed/human-owned conversations.

Publication has expected revisions, idempotency, deterministic locks, staged
retained publication, exact-candidate evaluation digests and reviewed atomic
activation. The candidate cannot activate using stale/synthetic evaluation
receipts. The repository contains the trusted evaluator protocol; a physical
golden evaluation worker still needs to execute and attest the exact candidate.
There is no claim that a queued evaluation or new version is active.

The graph editor edits canonical nodes, edges, layout and reference policies.
The retained editor loads exact source and preserves fields it does not render.
Both show dirty/conflict/pending/pinned states; the prompt inspector identifies
its selected context and exclusions. Read, publish, activation and rebind are
separate operations. Real browser/mobile acceptance remains unperformed.

Task 8 normalizes reviewed Israeli local numbers, catches the precise
`LeadFieldValidationError` path and returns a correction prompt. Name-only or
short English acknowledgments do not flip Hebrew locale. Ordinary callback
requests become durable human follow-up leads; explicit human requests transfer
without a model turn. Receipt ordering uses authenticated arrival order when
provider timestamps collide. No real customer messages/calls were sent here.

## API, authority and instruction scope

- Exact retained source: control API `/flows/{flowId}/versions/{version}`,
  BFF `/api/voice/flows/{flowId}/versions/{version}`. Tenant-owned immutable
  source includes revision/base metadata; source reads never publish/run a call.
  Global NULL-tenant sources retain the existing visibility fence; a packaged
  catalog/copy operation has not been introduced.
- Effective prompt: `/api/orchestration/agents/{id}/versions/{versionId}/effective-prompt`
  with `channel` and supported process/flow/node selectors. Ambiguous contexts
  return an actionable selection error. Generated clients include those query
  arguments. Voice uses the shared Python composer through the control API;
  WhatsApp uses the worker's extracted pure composer.
- Voice publication keeps the existing `voice:manage` mapping:
  `voice:operate` + `flows:manage` + `campaigns:manage`. UI visibility does not
  grant API authority. Activation keeps the reviewed platform approval fence.
- `effective-instructions.v1` hashes the exact UTF-8 rendered instruction text
  with SHA-256. Static admission and per-physical-attempt runtime hashes have
  separate scopes. Authoring previews use labelled empty interaction context;
  history, retrieved customer data and tools are not misrepresented as static
  instructions. Scripted openings have separate source provenance.

See [publication evidence](publication-bindings-verification.md) and
[WhatsApp evidence](task8-whatsapp-validation-and-routing.md).

The [actual fictional impact example](evidence/publication-impact-example.json)
records exact process, agent, canonical and retained identifiers from a committed
local publication. Inbound voice and new WhatsApp follow the new bundle;
outbound voice and the manual process keep their explicit pin. This fixture has
zero existing chats. The separate rebind case passed with one eligible AI chat
rebound and one removed chat skipped (`skippedRemoved=1`, `skippedHuman=0`),
while the ordinary-manager case remained `published_pending_activation`.

## Integrated tests and honest failures

Provider transports are disabled; PostgreSQL fixtures contain fictional data.
Migrations run under the designated `platform_migrator` authority; application
paths exercise actual web/voice/evaluator roles. The final graph has 166
revisions and one head, `a3ae6075bf24`.

| Check | Result |
| --- | --- |
| Empty → deployed `f3a8c2d91750` → candidate head; catalog/form smoke | 13 passed |
| `uv run pytest db/tests/postgres -q` | 440 passed, no skips |
| Full CRM PostgreSQL suite (separate owned UI fixture) | 817 passed, 1 opt-in golden test skipped there |
| Publication + opt-in golden gate PostgreSQL files | 8 passed, no skips |
| Exact source, warm/second admission, effective prompt, persisted hash Python PostgreSQL files | 4 passed, no skips |
| Task 8 signed webhook/locale evidence | 318 passed in task branch |
| Explicit human handoff and principal revocation race regression files | 23 + 18 passed on fresh fixtures |
| Full worker PostgreSQL rerun | 848 passed, 7 skipped (6 separately gated diagnostics and 1 platform-specific case) |
| `scripts/preview_ui.py --check-messaging` | 6 diagnostic tests passed; isolated DB/login removed |
| `scripts/check_publication_runtime.py` mandatory CI runner | 10 TypeScript + 3 Python, zero skips; isolated DB removed |
| Graph verification and publication-runner guards | 30 passed |
| Clean Web Docker build | Passed; local image only, no server started |
| `uv run python scripts/dev.py verify` on integrated code `35e21c7` | Passed, exit 0: format/lint, strict types, unit suites, contracts, migration head, builds, peers and configured audit gates |
| Full Python / web suites within verification | 2,231 Python + 1,061 web passed; opt-in skips itemized below |

Publication commands:
`pnpm --filter @or-on/crm exec vitest run src/publication-bindings.postgres.test.ts src/agent-quality-gate.postgres.test.ts`
with the guarded owned database and `PUBLICATION_CONTEXT_PATH`, then
`uv run pytest services/py/control-api/tests/test_voice_source_postgres.py services/py/control-api/tests/test_effective_prompt_postgres.py services/py/dispatcher/tests/test_instruction_provenance_postgres.py -q`.

Observed failures are not erased: catalog PUBLIC execute and implicit FK delete
behavior were reproduced and fixed in unpublished a29/a3 migrations. An initial
fixture migrated as `postgres` caused 35 ownership failures; the final run uses
the required authority and passes all 440. Four worker test failures reflected
the now-deterministic explicit human shortcut; regression tests still force
actual mid-model principal changes and assert no stale send. Full verification
first found three lint errors and then the generated operation tuple annotation;
both were fixed. CI exposed a clean-image missing `@or-on/config` build; the web
image now builds its complete workspace dependency closure.
The full Python pass also caught a stale 164-revision assertion; it now names
the two reviewed migrations and expects 166. Clean CI caught the analogous
missing config build before CRM tests; the package test command now builds its
workspace dependencies before collecting suites.

Ordinary suite skips are reported rather than counted as passing: Python 465,
web 14, CRM 137 and worker 246 in the default provider-free run. Required
database/publication/diagnostic paths were additionally run with their explicit
fixture flags as listed above. The one Windows-specific worker skip remains.
The JavaScript audit's configured critical gate passed with 4 high, 4 moderate
and 1 low advisory still reported; Python audit reported no known issue outside
the existing time-bounded exception through 2026-10-13. These are not claims
that every dependency has zero advisories. Final local log hashes are recorded
in [verification evidence](evidence/agent-reset-continuation-local.json).

## Recovery and release gates

The safe [rollback manifest](evidence/agent-reset-rollback-20261008.json) records
the actual deployed SHA, image digests, schema and reviewed bindings. Remote tag
`rollback-2026-10-08` points to the running `b4cc8cf` release. The 01:24 UTC backup
was checksum-verified and restored into an isolated network-none disposable
PostgreSQL fixture: database, security contract and referenced object hashes all
passed. The older backup omitted three legacy role definitions; the drill used
their read-only production metadata. Future backup code now includes those
exact roles; no production roles were changed. Key escrow remains unverified.
Take a fresh backup before any later rollout; this older snapshot is not a
zero-data-loss rollback. Preserve immutable evidence instead of blind schema
downgrade. Existing manual deployment tooling remains gated and was not run.

The observed web environment still names `gemini-2.5-flash`; this is an
environment observation, not proof of every tenant override or executed call.
The candidate targets Gemini 3.5 Flash Lite with 3.1 Flash Lite fallback and
Harper / `tts-rt-v2`, backed by the separately recorded offline provider evidence.
Those candidate settings were not activated. No live voice identity was claimed.

The original Meta v2 wording was rejected with HTTP 400, code 100, subcode
2388299. The owner subsequently approved appending “תודה שפניתם אלינו.”.
After reconciling the correct ProTouch WABA, one new submission created template
`1419161869672559`, named `protouch_service_request_link_v2`, language `he`,
category `UTILITY`, with actual status `PENDING`. The three server-owned
parameters and v1 remain intact; v2 is not activated and no customer message
was sent. See the [submission receipt](evidence/protouch-service-template-v2-submission.json).

| Remaining gate | Concrete next action |
| --- | --- |
| Local UI server startup rejected by automatic approval review | Resolve the execution restriction, then run the specified real browser/mobile acceptance; do not substitute component tests |
| Physical candidate-specific golden evidence | Have the trusted evaluator execute the exact candidate and submit attested receipts, then reviewed activation |
| Perceptual voice, live SIP/Meta acceptance | Complete owner-controlled checks using the designated identity after local gates pass |
| Key escrow and fresh pre-release backup | Verify key recovery and refresh the backup immediately before rollout |
| Meta v2 pending review | Read the provider status; activate only after APPROVED and reviewed tenant binding |

Automatic review also rejected deletion of private restore staging files, with
no detailed reason. The backup and extracted files remain in ignored/private
local storage; they are not in Git. No alternative cleanup or server-start path
was used after those rejections.
