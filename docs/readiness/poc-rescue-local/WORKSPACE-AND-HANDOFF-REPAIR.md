# Workspace isolation and WhatsApp resume repair — October 5, 2026

## Behavior

- Cross-tenant administration requires an active global administrator in the main Or-On workspace. Customer workspaces hide the directory and reject its page/API access; database entry points independently enforce the same restriction. The main workspace cannot be deleted.
- ProTouch overview shows recent inquiries, compact activity totals and operational shortcuts. Inquiry list/detail and field-service list/detail use responsive spacing, clear next actions and collapsible secondary information. Existing operational forms and permissions remain in place.
- The call picker uses the same approved routing query as call admission and displays the agent and retained script versions separately. Or-On's reviewed binding is agent v4 with script v3; the old script-only label did not establish an agent downgrade.
- A model decision of `handoff/insufficient_context` now offers human help while retaining AI ownership. The prompt first asks for a focused clarification. Explicit human requests, safety/emergency/regulated handoffs and server-side identity holds are preserved.
- Returning a WhatsApp conversation to AI cancels pending/accepted WhatsApp handoff requests in the same transaction and records an audit event. Historical handoffs and service tickets are retained. Subsequent inbound messages can be handled by AI without reopening a handoff solely because information is missing.

## Opening menu rollout

The existing opening-menu gate must be enabled only for Or-On's verified channel, approved agent/flow and approved English/Hebrew `conversation_start` variants. Publishing this migration does **not** enable it. Activation requires a separate scoped configuration transaction and readback.

Migration `b162a7e4d903` records the activation boundary. Verified ongoing AI conversations retain their current session; a new conversation or next 24-hour session boundary waits for the menu selection. Foreign channels, unprocessed preactivation events, changed ownership, reopened conversations and inactive sessions cannot acquire that exemption. ProTouch templates remain disabled.

## Verification before release

- Full web suite: 1,038 passed, 14 database-dependent tests skipped in this run. Separate PostgreSQL call/route verification: 49 passed; tenant administration: 4 passed.
- Full CRM suite against disposable PostgreSQL with actual runtime roles: 769 passed, including own-tenant handoff cancellation and foreign-tenant preservation.
- Worker handoff regression plus grounding: 225 passed. The actual worker fixture receives an explicit human request, resumes AI, then processes two missing-context decisions, delivers two replies through a fake provider and remains AI-owned with no pending handoffs.
- Full messaging-worker suite: 695 passed, one optional spool test skipped.
- Opening-menu activation and existing gate suites: 28 passed against PostgreSQL with fake providers.
- PostgreSQL sweep initially found seven failures (428 passed): the fixed revision count, new foreign-key delete semantics and five fixtures using the former cross-tenant administration scope. After repairing those contracts, all 49 tests in the five affected files passed; the 12 activation tests also passed again with tenant-composite cascading foreign keys.
- Formatting, lint, type checking and complete TypeScript/Next build passed.
- First CI run exposed one additional fixed migration counter and an ordinary-admin fixture trying to create its actor through the runtime-only preview connection. The counter suite now passes (14 tests); actor setup uses the same disposable database's setup connection, while permission assertions still run as `platform_web` (four tests passed with runtime-scoped UI connections). No runtime grants were expanded.
- Local browser: overview, inquiry detail and field-service detail in Hebrew/light and English/dark; mobile 390px layouts and inquiry cards; customer workspace directory denial. The local preview uses fictional records.

Logs are local under `.artifacts/poc-rescue-local/workspace-*`, `handoff-resume.log` and `menu-activation.log`. CI, exact deployment receipt, live configuration readback and browser verification must be recorded separately after release. These local tests do not prove a new real customer message or phone call was delivered.

ProTouch's Meta number remains pending while the phone's WhatsApp Business app is retained. This release neither migrates the number nor purchases a coexistence subscription.
