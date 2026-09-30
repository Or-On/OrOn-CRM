# API route inventory — 2026-09-30

Source enumeration of Next.js API route files and exported HTTP methods. This is not a permission audit or an assertion that every integration works. Dynamic segment names are literal templates. All entries are retained; detailed per-handler trust-boundary review remains open. The production build independently listed these routes.

| Endpoint                                         | Exported methods   |
| ------------------------------------------------ | ------------------ |
| /api/account/avatar                              | GET, PATCH, DELETE |
| /api/account/password                            | PATCH              |
| /api/account/profile                             | PATCH              |
| /api/account/sms                                 | GET, POST          |
| /api/auth/invitations/accept                     | POST               |
| /api/auth/live-grant                             | POST               |
| /api/auth/login                                  | POST               |
| /api/auth/logout                                 | POST               |
| /api/auth/session                                | GET                |
| /api/auth/sms                                    | POST               |
| /api/auth/tenant                                 | POST               |
| /api/automations/[id]/publish                    | POST               |
| /api/automations/[id]/run                        | POST               |
| /api/automations                                 | GET, POST          |
| /api/billing/payment-source                      | POST               |
| /api/billing/topups                              | GET, POST          |
| /api/calendar/events/[id]                        | PATCH, DELETE      |
| /api/calendar/events                             | GET, POST          |
| /api/campaigns/[id]/deliver                      | POST               |
| /api/campaigns                                   | GET, POST          |
| /api/crm/classifications/[id]                    | PATCH              |
| /api/crm/classifications                         | GET, POST          |
| /api/crm/contacts/[id]/classifications           | PATCH              |
| /api/crm/contacts/[id]/custom-fields/[fieldId]   | POST               |
| /api/crm/contacts/[id]/documents/[documentId]    | GET, DELETE        |
| /api/crm/contacts/[id]/documents                 | POST               |
| /api/crm/contacts/[id]/dossier                   | GET, PATCH         |
| /api/crm/contacts/[id]/locations/[locationId]    | PATCH, DELETE      |
| /api/crm/contacts/[id]/locations                 | POST               |
| /api/crm/contacts/[id]/national-id               | GET, PATCH         |
| /api/crm/contacts/[id]/notes                     | POST               |
| /api/crm/contacts/[id]                           | GET, PATCH, DELETE |
| /api/crm/contacts/import                         | POST               |
| /api/crm/contacts                                | GET, POST          |
| /api/crm/deals/[id]/stage                        | POST               |
| /api/email/oauth/[provider]/callback             | GET                |
| /api/email/oauth/[provider]/start                | GET                |
| /api/email/oauth/configuration                   | GET, POST, DELETE  |
| /api/field-service/appointments/[id]             | PATCH              |
| /api/field-service/appointments                  | GET, POST          |
| /api/field-service/attachments/[id]              | GET                |
| /api/field-service/attachments                   | POST               |
| /api/field-service/cases/[id]/assignment         | POST               |
| /api/field-service/cases/[id]/claim              | POST               |
| /api/field-service/cases/[id]/links              | GET, POST          |
| /api/field-service/cases/[id]                    | GET, PATCH         |
| /api/field-service/cases                         | GET, POST          |
| /api/field-service/customers                     | GET                |
| /api/field-service/directory                     | GET, POST          |
| /api/field-service/ocr/[id]                      | PATCH              |
| /api/field-service/ocr                           | GET                |
| /api/field-service/queue                         | GET                |
| /api/field-service/reports/[id]/export           | GET                |
| /api/field-service/reports/[id]/finalize         | POST               |
| /api/field-service/reports/[id]                  | PATCH, DELETE      |
| /api/field-service/reports                       | GET, POST          |
| /api/field-service/session-technician            | GET, POST, DELETE  |
| /api/field-service/technicians/[id]              | PATCH, DELETE      |
| /api/field-service/technicians                   | GET, POST          |
| /api/field-service/visits/[id]/attendance        | POST               |
| /api/field-service/visits/[id]/events            | POST               |
| /api/field-service/visits/[id]/identity          | POST               |
| /api/field-service/visits/[id]/preparation       | GET, POST          |
| /api/field-service/visits/[id]/times             | GET, POST          |
| /api/field-service/visits                        | POST               |
| /api/finance/expenses/[id]                       | PATCH, DELETE      |
| /api/finance/expenses                            | GET, POST          |
| /api/leads/[id]/fields                           | PATCH              |
| /api/leads/[id]                                  | GET, PATCH         |
| /api/leads                                       | GET                |
| /api/leads/schemas                               | GET, POST          |
| /api/messaging/conversations/[id]/messages       | GET, POST          |
| /api/messaging/conversations/[id]                | PATCH, DELETE      |
| /api/messaging/conversations                     | GET                |
| /api/messaging/messages/[id]/media               | GET                |
| /api/messaging/messages/[id]/reactions           | POST               |
| /api/messaging/simulate/inbound                  | POST               |
| /api/notifications                               | GET, PATCH         |
| /api/orchestration/activity                      | GET                |
| /api/orchestration/agents/[id]/audio-preview     | POST               |
| /api/orchestration/agents/[id]/evaluate          | POST               |
| /api/orchestration/agents/[id]/provider-evaluate | POST               |
| /api/orchestration/agents/[id]/publish           | POST               |
| /api/orchestration/agents/[id]/quality           | GET, POST          |
| /api/orchestration/agents/[id]/rebind            | POST               |
| /api/orchestration/agents/[id]                   | PATCH, DELETE      |
| /api/orchestration/agents                        | GET, POST          |
| /api/orchestration/flows/[id]/publish            | POST               |
| /api/orchestration/flows/[id]                    | PATCH, DELETE      |
| /api/orchestration/flows/[id]/simulate           | POST               |
| /api/orchestration/flows                         | GET, POST          |
| /api/orchestration/handoffs/[id]                 | PATCH              |
| /api/orchestration/handoffs                      | GET, POST          |
| /api/orchestration/knowledge                     | GET, POST, PATCH   |
| /api/orchestration/simulate                      | POST               |
| /api/service-inquiries/[id]/resolve              | POST               |
| /api/service-inquiries                           | GET                |
| /api/settings/api-keys/[id]                      | DELETE             |
| /api/settings/api-keys                           | POST               |
| /api/settings/business/configuration             | GET, PUT, POST     |
| /api/settings/business/modules                   | GET, PATCH         |
| /api/settings/business/processes/[id]            | PATCH              |
| /api/settings/business/processes                 | GET, POST          |
| /api/settings/business/templates                 | POST               |
| /api/settings/field-service/archive/[id]         | GET                |
| /api/settings/field-service/archive/objects/[id] | GET                |
| /api/settings/field-service/archive              | GET                |
| /api/settings/field-service                      | GET, PATCH         |
| /api/settings/invitations/[id]                   | DELETE             |
| /api/settings/invitations                        | POST               |
| /api/settings/logo                               | GET, PATCH, DELETE |
| /api/settings/members/[id]                       | PATCH, DELETE      |
| /api/settings                                    | PATCH              |
| /api/system/health                               | GET                |
| /api/tasks/[id]                                  | PATCH, DELETE      |
| /api/tasks                                       | GET, POST          |
| /api/tenants/[id]                                | PATCH, DELETE      |
| /api/tenants                                     | GET, POST          |
| /api/tickets/[id]/emergency                      | POST               |
| /api/tickets/[id]/replies                        | POST               |
| /api/tickets/metrics                             | GET                |
| /api/tickets                                     | GET                |
| /api/v1/contacts                                 | GET, POST          |
| /api/voice/campaigns                             | GET, POST          |
| /api/voice/campaigns/run                         | POST               |
| /api/voice/flows/publish                         | POST               |
| /api/voice/flows/validate                        | POST               |
| /api/voice/phone-numbers/reconcile               | GET                |
| /api/voice/phone-numbers                         | GET, POST          |
| /api/voice/real-calls                            | POST               |
| /api/voice/session-detail                        | POST               |
| /api/voice/sessions/[id]/control                 | GET, POST          |
| /api/voice/sessions/[id]/recording               | GET                |
| /api/voice/sessions/[id]/transcript              | GET                |
| /api/voice/sessions                              | GET                |
| /api/voice/simulated-calls                       | POST               |
| /api/webhooks/stripe                             | POST               |
| /api/webhooks/whatsapp/[accountKey]              | GET, POST          |
| /api/webhooks/whatsapp                           | GET, POST          |
