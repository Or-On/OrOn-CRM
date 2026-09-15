# Current application inventory

Inventory date: 2026-09-15. Source: filesystem enumeration plus the successful
Next.js production build. Dynamic parameters are shown in brackets. This is a
finite source inventory, not proof that a route is deployed or that a provider
completed its external side effect.

## Page routes (28)

| Area | Routes |
| --- | --- |
| Entry and authentication | `/`, `/[locale]`, `/start`, `/login`, `/invite` |
| Customer workspace | `/inbox`, `/email`, `/calendar`, `/tasks`, `/contacts`, `/contacts/[id]`, `/pipelines`, `/operations` |
| Messaging and voice operations | `/voice`, `/voice/campaigns`, `/voice/calls/[id]`, `/flows`, `/orchestration` |
| Administration | `/finance`, `/profile`, `/users`, `/roles`, `/tenants`, `/settings`, `/system/health` |
| Optional field service | `/field-service`, `/field-service/cases/[id]`, `/field-service/reports/[id]` |

Auth and invitation routes render without the authenticated application shell by
design. Tenant pages use the canonical session/tenant context. Field-service
pages additionally require the entitlement, tenant activation and role
permission; their APIs enforce the same conditions independently of navigation.

## API route files (108; 156 exported HTTP methods)

The method count includes the synchronous WhatsApp verification `GET`, which a
search restricted to `async` exports would miss.

| Route | Methods |
| --- | --- |
| `/api/account/avatar` | GET, PATCH, DELETE |
| `/api/account/password` | PATCH |
| `/api/account/profile` | PATCH |
| `/api/auth/invitations/accept` | POST |
| `/api/auth/live-grant` | POST |
| `/api/auth/login` | POST |
| `/api/auth/logout` | POST |
| `/api/auth/session` | GET |
| `/api/auth/tenant` | POST |
| `/api/automations/[id]/publish` | POST |
| `/api/automations/[id]/run` | POST |
| `/api/automations` | GET, POST |
| `/api/billing/payment-source` | POST |
| `/api/billing/topups` | GET, POST |
| `/api/calendar/events/[id]` | PATCH, DELETE |
| `/api/calendar/events` | GET, POST |
| `/api/campaigns/[id]/deliver` | POST |
| `/api/campaigns` | GET, POST |
| `/api/crm/classifications/[id]` | PATCH |
| `/api/crm/classifications` | GET, POST |
| `/api/crm/contacts/[id]/classifications` | PATCH |
| `/api/crm/contacts/[id]/custom-fields/[fieldId]` | POST |
| `/api/crm/contacts/[id]/documents/[documentId]` | GET, DELETE |
| `/api/crm/contacts/[id]/documents` | POST |
| `/api/crm/contacts/[id]/dossier` | GET, PATCH |
| `/api/crm/contacts/[id]/locations/[locationId]` | PATCH, DELETE |
| `/api/crm/contacts/[id]/locations` | POST |
| `/api/crm/contacts/[id]/national-id` | GET, PATCH |
| `/api/crm/contacts/[id]/notes` | POST |
| `/api/crm/contacts/[id]` | GET, PATCH, DELETE |
| `/api/crm/contacts/import` | POST |
| `/api/crm/contacts` | GET, POST |
| `/api/crm/deals/[id]/stage` | POST |
| `/api/email/oauth/[provider]/callback` | GET |
| `/api/email/oauth/[provider]/start` | GET |
| `/api/email/oauth/configuration` | GET, POST, DELETE |
| `/api/field-service/appointments/[id]` | PATCH |
| `/api/field-service/appointments` | GET, POST |
| `/api/field-service/attachments/[id]` | GET |
| `/api/field-service/attachments` | POST |
| `/api/field-service/cases/[id]/links` | GET, POST |
| `/api/field-service/cases/[id]` | GET, PATCH |
| `/api/field-service/cases` | GET, POST |
| `/api/field-service/ocr/[id]` | PATCH |
| `/api/field-service/reports/[id]/export` | GET |
| `/api/field-service/reports/[id]/finalize` | POST |
| `/api/field-service/reports/[id]` | PATCH |
| `/api/field-service/reports` | POST |
| `/api/field-service/technicians/[id]` | PATCH |
| `/api/field-service/technicians` | GET, POST |
| `/api/field-service/visits/[id]/attendance` | POST |
| `/api/field-service/visits/[id]/identity` | POST |
| `/api/field-service/visits` | POST |
| `/api/finance/expenses/[id]` | PATCH, DELETE |
| `/api/finance/expenses` | GET, POST |
| `/api/messaging/conversations/[id]/messages` | GET, POST |
| `/api/messaging/conversations/[id]` | PATCH, DELETE |
| `/api/messaging/conversations` | GET |
| `/api/messaging/messages/[id]/reactions` | POST |
| `/api/messaging/simulate/inbound` | POST |
| `/api/notifications` | GET, PATCH |
| `/api/orchestration/activity` | GET |
| `/api/orchestration/agents/[id]/audio-preview` | POST |
| `/api/orchestration/agents/[id]/evaluate` | POST |
| `/api/orchestration/agents/[id]/provider-evaluate` | POST |
| `/api/orchestration/agents/[id]/publish` | POST |
| `/api/orchestration/agents/[id]/quality` | GET, POST |
| `/api/orchestration/agents/[id]` | PATCH, DELETE |
| `/api/orchestration/agents` | GET, POST |
| `/api/orchestration/flows/[id]/publish` | POST |
| `/api/orchestration/flows/[id]` | PATCH, DELETE |
| `/api/orchestration/flows/[id]/simulate` | POST |
| `/api/orchestration/flows` | GET, POST |
| `/api/orchestration/handoffs/[id]` | PATCH |
| `/api/orchestration/handoffs` | GET, POST |
| `/api/orchestration/knowledge` | GET, POST, PATCH |
| `/api/orchestration/simulate` | POST |
| `/api/settings/api-keys/[id]` | DELETE |
| `/api/settings/api-keys` | POST |
| `/api/settings/field-service/archive/[id]` | GET |
| `/api/settings/field-service/archive/objects/[id]` | GET |
| `/api/settings/field-service/archive` | GET |
| `/api/settings/field-service` | GET, PATCH |
| `/api/settings/invitations/[id]` | DELETE |
| `/api/settings/invitations` | POST |
| `/api/settings/logo` | GET, PATCH, DELETE |
| `/api/settings/members/[id]` | PATCH, DELETE |
| `/api/settings` | PATCH |
| `/api/system/health` | GET |
| `/api/tasks/[id]` | PATCH, DELETE |
| `/api/tasks` | GET, POST |
| `/api/tenants/[id]` | PATCH, DELETE |
| `/api/tenants` | GET, POST |
| `/api/v1/contacts` | GET, POST |
| `/api/voice/campaigns` | GET, POST |
| `/api/voice/campaigns/run` | POST |
| `/api/voice/flows/publish` | POST |
| `/api/voice/flows/validate` | POST |
| `/api/voice/phone-numbers/reconcile` | GET |
| `/api/voice/phone-numbers` | GET, POST |
| `/api/voice/real-calls` | POST |
| `/api/voice/session-detail` | POST |
| `/api/voice/sessions/[id]/control` | GET, POST |
| `/api/voice/sessions/[id]/recording` | GET |
| `/api/voice/sessions` | GET |
| `/api/voice/simulated-calls` | POST |
| `/api/webhooks/stripe` | POST |
| `/api/webhooks/whatsapp` | GET, POST |

## Durable and external work

| Work | Admission and durable path | External boundary |
| --- | --- | --- |
| WhatsApp inbound/status | Signed canonical webhook → `ops.inbound_events` → messaging worker → conversations/messages/receipts | Meta webhook only when real WhatsApp is enabled |
| WhatsApp AI reply | Persisted inbound message → pinned tenant AI ownership/version → `whatsapp.ai.reply` job → revalidated send | Configured OpenAI-compatible LLM and Meta/simulator provider |
| WhatsApp outbound | Authorized message mutation → `whatsapp.outbound.send` job → provider receipt/status reconciliation | Meta/simulator provider; provider acceptance is not delivery |
| Callback/cross-channel | Bound conversation intent → `whatsapp.ai.call`/cross-channel job → dispatcher admission → canonical voice session | Dispatcher/telephony only after current tenant, consent, ownership and feature checks |
| Field-service intake | Canonical WhatsApp message → `field_service.intake.extract`; media uses `field_service.whatsapp_media.retrieve` | Optional LLM/media fetch; feature and readiness rechecked before and after provider work |
| OCR and summaries | Tenant-scoped attachment/case request → `field_service.ocr` or `field_service.summary` | Optional LLM; proposals retain provenance and cannot bypass workflow validation |
| Campaign/automation | Draft/published version → bounded durable jobs and execution history | Simulator by default; real-provider gates remain independent |
| Voice | Authorized web/API admission → control API/dispatcher → LiveKit/SIP agent runtime → sessions/artifacts/usage | Real telephony and model/STT/TTS flags are independent and disabled in general tests |
| Payment | Checkout/top-up request → signed Stripe webhook → tenant-bound ledger mutation | Stripe test/live mode; browser redirect never credits the wallet |
| Calendar/OAuth | Tenant configuration and CRM calendar mutations; OAuth callback state is server validated | Google/Microsoft connection does not imply mailbox sync; field-service booking currently uses CRM calendar |
| Backups/deployment | Nightly/pre-migration database + private-object bundle; immutable digest release | Single-host DEV; no live deployment or off-host restore was performed in this execution |

The primary implementation anchors are `apps/web/src/app/api`,
`packages/ts/auth/src`, `packages/ts/crm/src`,
`services/ts/messaging-worker/src`, `services/py/control-api/src`,
`services/py/dispatcher/src`, `packages/py/oron-agent/src`, and
`db/alembic/versions`.

## Reachable UI interaction inventory

This is the finite interaction map at the current source snapshot. An action is
listed even when its provider or feature readiness can make it unavailable.

| Surface | Reachable actions, menus and dialogs |
| --- | --- |
| Entry/auth | Sign in; accept invitation; choose the current tenant; retry safe error; sign out |
| Global shell | Open/collapse navigation; search/quick-create destinations; change language/theme; open notifications/system health/help/profile; switch tenant |
| Overview | Navigate metric/activity cards to their authoritative modules; accessible chart/table fallback |
| Inbox | Search, filter channel/status/assignment, open thread, load history, mark/read, assign, change status, send reply/template, react, open contact context, start call, request/take/resume handoff, delete conversation, mobile back/channel drawer |
| Contacts | Server search, load next page, create/edit/archive contact, open dossier, add note/custom field/classification/location/document, reveal/change/clear national ID, edit/archive location, download/archive document, start call |
| Pipelines | Open board, create/edit deal, move stage, filter and open related contact |
| Operations | Switch campaigns/automations/history, create/edit draft, audience preview, publish/run/deliver under safety gates, inspect execution status/failure |
| Voice | Filter sessions, open call detail/recording/transcript/summary/cost, create/run campaign, validate/publish flow, start simulated or authorized real call, control eligible session |
| Agents & flows | Create/edit/delete agent or flow, configure knowledge/channel capability, validate/publish/version, simulate, run evaluation/audio preview/provider evaluation, inspect quality/activity, manage handoff |
| Tasks | Filter, create, edit, assign, complete/reopen and delete; use mobile card or desktop table |
| Calendar | Navigate month/week/day/agenda presentation, open date, create/edit/reschedule/cancel event |
| Email | Choose Google/Microsoft, view connection/readiness guide, securely save tenant OAuth configuration, start/cancel provider consent and disconnect supported connection |
| Finance | View ledger/voice estimate, filter and export loaded expenses, create/edit/void expense, connect payment source and request top-up only when provider-ready |
| Profile | Edit display name/email preference/locale, upload/remove personal avatar, change password |
| Users/roles | Create/copy/revoke invitation, choose permitted role, change member role, deactivate/remove member, inspect role/permission matrix |
| Tenants | Create tenant with locale/currency/timezone/owner and feature availability, switch/open, edit lifecycle state, delete/archive through the protected dialog |
| Settings | Edit tenant identity/contact/locale/timezone/accent/report copy, upload/remove logo, manage API keys, invitations/members and independent field-service options/readiness/archive |
| Field service | Search/page/filter cases; create case; add/edit/deactivate technician; link verified user; change legal case status; schedule/reschedule/reassign/cancel; add repeat visit; identify technician; sign arrival/departure; upload/cancel/retry categorized evidence; run/review OCR; draft/finalize/revise report; print/download XLSX; create/download bounded archive/dossier/evidence |
| System health | Refresh, opt into bounded auto-refresh, inspect current checks/observation history and navigate to affected module |
| Global states | Retry error boundaries, return from 404/access denial, close/cancel dialogs and receive live success/error announcements |

## Upload and download boundaries

| Data path | Input/output and enforcement |
| --- | --- |
| Personal avatar / tenant logo | Bounded image upload, content check, separate user/tenant ownership, remove/fallback; never overlays initials and image |
| Contact import | CSV file ingestion with encoding/schema/row validation, duplicate handling and truthful result counts |
| Customer documents | Images, PDF or text through private storage; identity category requires sensitive permission; archive preserves history; safe authorized download headers |
| Field-service evidence | Categorized desktop file or mobile camera input, progress/cancel/retry, checksum and structural validation; reserved attendance signature categories use the atomic attendance API |
| Attendance signatures | Multipart evidence plus case/kind/idempotency key; object registration, promotion, audit and signed visit update are one transaction for normal failures |
| Voice recording | Tenant/session-authorized protected read; absence/pending/failure is explicit |
| Report/export | Browser print/PDF path, finalized XLSX, CSV/JSON archive indexes, per-case JSON and bounded ZIP/evidence downloads; spreadsheet cells and ZIP paths are sanitized |
| Finance export | Client download is explicitly “loaded records,” not an unbounded or falsely complete ledger export |

## Database write domains

| Domain | Canonical writes |
| --- | --- |
| Identity/platform | Users, credentials/session rotation, invitations, tenant memberships/roles, tenants, feature entitlements/configuration, API keys and audit events |
| CRM | Contacts, profiles/protected fields, notes, custom values, classifications, service locations, customer documents, tasks, calendar events, pipelines/deals and tenant settings/branding |
| Messaging/agents | Channels, contacts/conversations/messages, assignment/read/delivery/reaction state, agent/flow/knowledge versions, handoffs, campaigns/automations and activity |
| Operations | Signed webhook receipts, inbound events, durable jobs, leases/attempts, idempotency keys and reconciliation outcomes |
| Voice/finance | Sessions, controls, transcripts/recordings/quality/usage, campaigns, phone bindings, expenses, wallet/top-up reservations and signed billing events |
| Field service | Intake drafts/correlation, cases/status history, conversation/call links, technicians, appointments, visits/identity/attendance, report revisions/snapshots, attachments, OCR/summaries and processing states |
| Objects/audit | Tenant-bound private object metadata/checksums/storage keys and append-only audit records |

All runtime writes use the existing PostgreSQL lineage. There is no secondary
Brimag database, SQLite production path or client-authoritative provider state.

## Scheduled and retryable operations

- Worker polling leases bounded durable jobs; lease expiry/retry is recorded and
  idempotency is rechecked before side effects.
- Campaign/automation scheduled execution remains tenant/version/provider bound.
- WhatsApp send, AI reply, callback, media retrieval, OCR and summary work use
  separate job kinds and poison-job isolation.
- Voice dispatcher/session work owns its room/call/session identifiers and
  records uncertain outcomes instead of inferring success.
- Stripe/WhatsApp callbacks reconcile previously persisted identities rather
  than treating browser redirects or provider acceptance as final delivery.
- Host timers perform complete local backup and bounded retention; off-host
  replication is an explicit unresolved release requirement.
