# Phase 7 customer-operations redesign

Status: implementation and verification complete; checkpoint uncommitted

Baseline: `7afa8534fc89259cd679da7ff58ec7546bd01b14`

Branch: `codex/phase-7-ui-polish`

## Outcome

Rebuild the existing functional frontend into a deliberate Customer Operations
workspace without changing its PostgreSQL-backed domain behavior, tenant/RBAC
boundaries, simulator defaults, or provider safety gates. This is an
information-architecture and interaction redesign, not a theme-only pass.

The operating UI uses a quiet graphite hierarchy with a restrained electric-blue
action signal. Luminance, typography, spacing, and alignment communicate structure
before borders or decorative containers. The public landing was subsequently
removed; guest entry now reaches the bilingual login, while the authenticated
application retains the code-native Or-On mark and product language.

## Non-negotiable preservation boundaries

- Keep every existing route and working operation reachable.
- Keep server components responsible for tenant-scoped reads.
- Keep client components only where browser state or interaction requires them.
- Preserve consent, opt-out, idempotency, confirmation, RBAC, and provider kill
  switches exactly; presentation must not weaken them.
- Do not fabricate metrics, provider health, campaign outcomes, transcripts, or
  commercial claims.
- Do not add OpenLive or a visual agent in this phase.
- Run interactive acceptance only against the isolated fictional preview. Never
  start a real-provider worker as part of visual review.

## Delivery slices

| Slice | State | Delivered scope and acceptance evidence |
| --- | --- | --- |
| P7-R01 | implemented and verified | Premium token system, shared UI primitives, restrained motion, compact/expandable shell/top bar, consolidated navigation, keyboard/focus tests, strict typecheck, and production build |
| P7-R02 | implemented and verified | Overview, centered-dialog Inbox, Contacts, and Pipeline retain their workflows; fictional preview plus English LTR and Hebrew RTL desktop/compact inspection passed |
| P7-R03 | implemented and verified | Messaging campaigns, Voice/calls, Voice campaigns, persisted connected Agents/Flows, Handoffs, Health, and management Settings covered by feature/authorization tests and no-provider-operation review |
| P7-R04 | implemented and verified | Public landing removed; bilingual login/invitation/start and loading/error/empty states, dark/light, responsive shell, RTL, keyboard, and reduced-motion behavior covered |
| P7-R05 | verification complete; checkpoint uncommitted | 121 web tests; 680 Python passed with 66 skips; 65 live PostgreSQL passed; format, lint, typecheck, tests, builds, contracts, migrations, guards, and dependency checks passed |

## Information architecture

Primary navigation is intentionally limited to:

- Workspace: Overview, Inbox, Contacts, Pipeline
- Operations: Messaging, Voice, Agents & Flows
- Platform: System health, Settings

Voice campaigns and voice-flow-library routes remain available through contextual
navigation within Voice. Agent profiles, canonical flows, runs/activity, and human
handoffs become contextual views within Agents & Flows rather than simultaneous
configuration forms.

## Interaction direction

- The command menu supports navigation and real route-backed creation/search entry
  points. It must not imply global search where no search contract exists.
- Index-first pages reveal creation/editing in focused dialogs or drawers.
- Inbox retains conversation-list, message-workspace, and optional context layers.
- Pipeline stage changes support direct manipulation plus a keyboard-accessible
  explicit stage control, with optimistic state and rollback on failure.
- Motion uses shared tokens and transform/opacity/layout transitions only. It never
  delays input and is removed under `prefers-reduced-motion`.

## Responsive acceptance

Operational surfaces use the available width at desktop sizes. Narrow layouts
collapse secondary panes into drawers or focused views; they do not rely on
accidental horizontal page scrolling. Purposeful horizontal scrolling remains
allowed inside the pipeline board and data tables. Final browser inspection
covered English LTR and Hebrew RTL at desktop and compact widths without
page-level horizontal overflow.

## Final follow-on state

The management follow-on migrated the owned local development database through
`c567208f57bc`, `5725968b8ae1`, and sole head `e139bf3fde7e`. The guarded cleanup
command was reviewed in dry-run mode, applied to its exact deterministic fixture
set, and followed by a zero-row dry run. No remote or deployed database changed.

Invitations remain manually shared bearer links. There is no invitation email
delivery, resend status, or trusted email verification. No telephone call,
WhatsApp message, provider mutation, deployment, or other external provider
action was performed. Host Node 25.9.0 still warns because the supported
repository baseline is Node 24 LTS.

## Completion language

The implementation and repository verification gate are complete in the current
working tree; coherent checkpoint commits have not yet been created. Browser and
automated evidence covers retained routes, layout/overflow, focus and keyboard
behavior, RTL direction, reduced motion, and truthful empty/error/loading states.
This is not a final-commit claim, deployment, accessibility certification,
measured performance result, or production-readiness certification.
