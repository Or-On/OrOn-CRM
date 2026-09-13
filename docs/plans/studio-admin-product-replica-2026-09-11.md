# Studio Admin product replica — 2026-09-11

## Objective

Apply the visual language and interaction geometry of the Studio Admin reference
to the complete Or-On application while retaining Or-On's routes, data,
permissions, mutations, bilingual behavior, and product-specific controls.

Reference repository:
`next-shadcn-admin-dashboard-baseui` at commit
`47e2d4384574d86f2b21d297ee6486da3f5cc01b` (MIT).

## Route mapping

| Or-On surface                    | Studio Admin pattern                                               | Or-On behavior retained                                                             |
| -------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Authenticated shell              | Dashboard sidebar, header, search, grouped navigation, user footer | Tenant switching, language, theme, command search, health, session controls         |
| Overview                         | Default dashboard metrics, activity chart, performance table       | Messaging, voice, agent, flow, delivery, CRM, and pipeline data                     |
| Inbox                            | Chat and Mail split workspace                                      | Conversation filters, assignment, delivery state, drafts, replies, templates        |
| Contacts                         | Users register and data table                                      | CRM search, filters, sorting, import, creation, contact navigation                  |
| Contact detail                   | Profile details and activity panels                                | Identity, notes, custom fields, cross-channel activity, call initiation             |
| Pipeline                         | Kanban board                                                       | Pipeline selection, currencies, opportunities, stage changes                        |
| Messaging                        | Tasks-style tabs, metrics, filter toolbar, registers               | Campaigns, automations, execution history, simulator guards                         |
| Voice                            | Infrastructure-style metrics and registers                         | Calls, numbers, campaigns, flows, recordings, costs, simulator state                |
| Call detail                      | Profile/infrastructure detail layout                               | Transcript, recording, call events, outcome, duration, usage cost                   |
| Agents and flows                 | Roles/tasks split registers and detail panes                       | Agent versions, flow canvas, simulations, activity, handoffs                        |
| System health                    | Infrastructure health panels                                       | Core API, readiness, database checks, refresh behavior                              |
| Settings                         | Profile navigation rail and form cards                             | Account, appearance, security, workspace, team, notifications, access, integrations |
| Login and invite                 | Authentication v2 split layout                                     | Existing authentication, invitation, locale, theme, recovery behavior               |
| Loading, empty, error, not-found | Studio neutral cards and compact actions                           | Existing recovery paths and localized copy                                          |

## Deliberate exclusions

- Studio demo data, charts, navigation destinations, GitHub links, support
  advertising, and sample account branding.
- Reference functions that have no Or-On equivalent.
- Decorative elements that compete with an Or-On task or create false product
  capabilities.

## Acceptance evidence

- Web tests: 44 files, 199 tests passed.
- TypeScript and Next route generation passed.
- Next.js production build completed for all 45 application and API routes.
- 62 production screenshots cover every major route in 1440px English/light and
  390px Hebrew/dark scenarios.
- The screenshot audit found no console errors, failed responses, viewport
  overflow, or missing primary headings.
- 30 Inbox/Contacts interaction checks passed across six responsive scenarios.
- 75 Voice/Messaging/Orchestration interaction checks passed across five
  responsive scenarios.
- 48 Settings interaction checks passed in English/Hebrew, light/dark, desktop,
  and mobile scenarios.
