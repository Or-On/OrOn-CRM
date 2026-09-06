# Phase 7 expanded bilingual experience

User brief accepted 2026-09-03, baseline `0408d5274af3c181aef32ec79352abfba1ed14be`.
This extends, rather than discards, the first Phase 7 checkpoint.

## Audit and assumptions

Or-On Platform is a development-stage customer-operations product for owners,
administrators, messaging operators and voice operators. Frequent work is finding
a customer, reviewing history, answering messages, updating CRM and inspecting
call outcomes. Consequential work includes consent changes, real message
admission, profile/flow publishing and API-key creation. Existing PostgreSQL/RLS,
auth, jobs and provider adapters remain authoritative. No OpenLive or cloud scope.

Current gaps: hardcoded English, default English document direction, fragmented
form feedback, discarded failed notes, mixed-currency pipeline totals, first-board
only navigation, misleading provider safety copy, no public product explanation,
and no guided starting point. Existing message drafts/idempotency must survive
locale/theme changes. Do not localize protocol identifiers or user-authored data.

Primary conversion is **explore the product / sign in to an existing workspace**.
There is no verified sales destination, pricing, customer proof, self-service
provisioning, email delivery, SSO or MFA implementation. Do not invent these or
publish legal assurances. Provide clear access/recovery guidance instead of dead
buttons. Legal publication requires approved operator details and text; not an
excuse to fabricate a policy. No external deployment is authorized.

## Sitemap and journeys

- `/en`, `/he`: public product narrative, labelled illustrative workflow, actual
  capabilities/limitations, security facts, FAQ and existing-account conversion.
- `/login`: bilingual authentication, access help and workspace selection after
  login; preserve canonical session/security behavior.
- `/start`: authenticated guided checklist linking real contact/import, simulator,
  profile and settings actions. No automatic provisioning or provider enablement.
- `/`: authenticated Overview (legacy entry preserved); anonymous entry goes to
  public product explanation.
- `/inbox`, `/contacts`, `/contacts/:id`, `/pipelines`: daily operator workflow.
- `/operations`, `/orchestration`, `/flows`: supported campaign/automation and
  immutable profile/flow behavior; no invented graph editor or campaign engine.
- `/voice`, `/voice/calls/:id`, `/voice/campaigns`: retained call/simulator results.
- `/settings`, `/system/health`: workspace, team, API keys, provider mode and health.
- Localized loading, error, missing route, permission and session-expired states.

Journeys: public explanation → existing-account sign-in → guided first value;
Overview → customer conversation → contact/consent → explicit reply review;
contact → call simulation → outcome → durable follow-up → operator handoff.

## Design contract

Signature motif: a readable conversation path with channel/status waypoints,
not decorative circuitry. Navy/ink, electric-blue interaction signals and refined
ice-light surfaces are shared; teal is reserved for positive state.
Marketing describes one workflow; the application prioritizes compact working
surfaces. Use semantic tokens, logical CSS, readable Hebrew/Latin typography,
short state transitions and reduced-motion support. No invented metrics/proof.

## Implementation tracking

| ID | Deliverable | State |
| --- | --- | --- |
| P7-B01 | Locale architecture, dictionaries, native direction, switch preserving context | implemented; dictionary/ICU/proxy tests and browser language checks pass |
| P7-B02 | Public narrative, authentic conversion, localized metadata | implemented; EN/HE public routes and interactive illustrative workflow browser-verified |
| P7-B03 | Authentication, access guidance, onboarding | implemented for existing-account scope; no invented signup, SSO, MFA or recovery service |
| P7-B04 | Shell, shared feedback, overview, message workflow localization | implemented; compact rail, localized command palette, preserved reply drafts, permission/error/offline presentation |
| P7-B05 | Contact/pipeline form correctness and bilingual management surfaces | implemented; failed-input recovery, partial CSV feedback, typed custom values, board selection and exact per-currency totals |
| P7-B06 | Operations, flows, voice, settings, all remaining visible states | implemented for retained route scope; capability-aware flow controls and truthful provider labels |
| P7-B07 | Bidirectional/theme/keyboard/viewport tests and full verification | core automated/build/browser checks pass; expanded assistive-technology and full voice rehearsals remain open |

These tasks augment P7-005–P7-010. Completion requires implemented routes and
recorded evidence, not translated headings alone. Use fictional isolated
PostgreSQL and disabled providers. No normal developer runner or worker start.

Implementation and evidence: [bilingual experience architecture](../architecture/bilingual-experience.md)
and [acceptance record](../runbooks/bilingual-ui-acceptance.md). This is a working
implementation checkpoint, not a claim of completed Phase 7/production certification.
