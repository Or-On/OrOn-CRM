# Phase 7 — Operator experience and demo readiness

Status: implementation started; no completion claim.
Baseline: `305eb6258435545033343106c19d6479b0cbf97e`.
Branch: `codex/phase-7-ui-polish`.

## Approved direction

Preserve the working engines and evolve the visual system to navy/ink, ice-light
surfaces and an electric-blue conversation signal. Teal indicates positive state;
it is no longer the generic primary accent. Improve the existing product, not a
replacement application. Overview and Inbox establish the application direction
before the remaining screens. Small tenant-authorized read-model and interaction
corrections are in scope; new campaign/voice engines are not.

The public [OrOn site](https://or-on.io/) is an approved reference for technical
confidence and signal language. The platform uses its own code-native mark,
conversation-path artwork, content and information architecture. Do not copy the
reference logo, hero art, copy, layout, partner/customer marks, performance
figures or commercial claims.

The primary fictional demo journey is Overview → Inbox → contact context →
recorded call simulation → durable WhatsApp follow-up → human handoff. Clearly
distinguish queue admission, provider acceptance, delivery, and simulation.
Real WhatsApp is an optional separately confirmed demonstration, never a test
dependency. OpenLive remains Phase 9; GCP remains Phase 8.

## Source audit and priorities

- Inbox selection/polling can show stale messages under another contact; drafts
  and real confirmation must be conversation-scoped.
- Provider switching returns a different conversation ID which the UI ignores.
- Message queries select the oldest 250 records; initial history must show the
  latest messages and permit bounded older-page retrieval.
- Sender/provider identity and template summaries need safe typed projections.
- Forms can clear after failed mutations; errors must be local and recoverable.
- Foundation copy is obsolete. Overview must use real authorized data, not fake
  KPIs or unconditional healthy badges.
- Mobile loses account controls and navigation names. Theme contrast and focus
  treatments need repair. Hebrew is not implemented merely by a direction helper.
- Flow action compatibility, named version selection, run receipts, and handoff
  context need improvement without implying a full visual editor or new engine.
- Broadcast recipient-state simulation does not create Inbox messages. Voice
  simulation is recorded fixture output, not a real live call. Label both honestly.

## Tracked implementation

| Task   | Scope                                                          | Acceptance                                                                                     |
| ------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| P7-001 | Baseline, safe preview and audit                               | Clean baseline and upstream locks; no developer queues/credentials changed                     |
| P7-002 | Design tokens, responsive shell, shared interaction primitives | Named navigation, accessible mobile utilities, compact hierarchy, both themes                  |
| P7-003 | PostgreSQL-backed Overview                                     | Scoped real data, clear sample/count semantics, actionable links                               |
| P7-004 | Inbox correctness and presentation                             | Race-safe thread selection, drafts, pagination, provider result routing, explicit confirmation |
| P7-005 | Contact/pipeline/forms                                         | Recoverable errors, typed values, currency-correct totals, coherent detail navigation          |
| P7-006 | Agents/flows/operations                                        | Capability-aware actions, named references, honest receipts and simulator scope                |
| P7-007 | Voice/call/handoff presentation                                | Readable results/context, no fake live controls                                                |
| P7-008 | English/Hebrew and accessibility                               | Actual translated UI/document direction, keyboard and contrast verification                    |
| P7-009 | Browser regressions and production performance                 | Automated interaction checks; viewport/theme matrix; measured production build                 |
| P7-010 | Rehearsal, documentation and checkpoint                        | Three clean-session fictional rehearsals; full relevant checks; explicit remaining risks       |

## Visual and interaction contract

- Compact 28–32px page titles; 14–16px body text; consistent spacing and surfaces.
- Electric blue marks primary actions and focus; semantic statuses include text,
  not color alone.
- Desktop Inbox uses a bounded list/thread layout; narrow screens navigate from
  list to thread instead of stacking the full list above the composer.
- Actions expose pending/success/failure; preserve inputs on failure. No blind
  resubmission of uncertain real sends; retain idempotency for the same intent.
- Hide unavailable write actions based on session capabilities without weakening
  server authorization. Keep technical payloads under explicit disclosures.
- Do not assert a manually entered template is approved or a configured sender
  is provider-verified. Never display provider credentials.

## Verification gates

Use isolated fictional PostgreSQL fixtures and explicitly disabled real-provider
flags. Do not restart the developer messaging worker or seed their database.
Normal browser tests must reject external requests. Verify 1366×768, 1440×900,
1024px, 768px, 390px and 320px reflow; dark/light; English/Hebrew; keyboard,
zoom and reduced motion. Include slow/error responses and >250-message history.
Static markup assertions are not interactive accessibility or RTL certification.
Record production-mode timings separately from field Core Web Vitals claims.

No new migration, framework replacement, advanced flow editor, provider resource
change, real call/send, campaign engine, OpenLive or cloud deployment is implied.
