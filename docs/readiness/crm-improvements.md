# CRM improvements grounded in the audit

Readiness/security fixes take priority. These are proposals, not shipped modules.

| Priority / effort | User problem and existing overlap | Additive direction / acceptance | Roles, dependencies, privacy |
| --- | --- | --- | --- |
| P0 /small — candidate implemented | One bad CSV row aborted all later imports but counters looked successful | PostgreSQL row savepoints, validation-vs-fatal-error classification, truthful counts; persisted valid rows after a malformed row proven by live tests | CRM writers; existing importer; no contents in logs |
| P0 /small — candidate implemented | Voice outage prevented opening contact details | Keep core contact readable; voice actions show unavailable rather than fake data | CRM readers plus separate voice permission; no new provider requests |
| P1 /medium | Contact search page is bounded to50/100 with no continuation | Stable cursor pagination, advertised search scope, export parity; fixtures beyond page boundary and cross-tenant tests | Readers/export permission; composite order/index measured before adoption |
| P1 /medium | Operators cannot consistently see why delivery is uncertain | Safe diagnostic codes and explicit uncertain outcome; operator reconciliation before new send | Messaging operators; worker state and Meta outcome; no automatic duplicate send or leaked provider payload |
| P1 /medium | OAuth connection looks like an email feature but no sync client exists | Honest connection status, disconnect/refresh/rotation races first; mailbox sync/send needs a separate scoped product decision | Tenant managers; scoped provider consent; encrypted credentials/retention |
| P1 /medium | Follow-up tasks lack dependable timezone/reminder behavior | Clarify tenant timezone and DST boundaries; opt-in durable overdue reminders with dedupe and snooze | Assigned members; jobs/preferences; no automatic external emails |
| P2 /medium | Repeated contact filtering is tedious | Private saved views first; explicitly shared views use tenant scope and permission-aware filters | CRM readers; PostgreSQL preferences; permission revocation invalidates visibility |
| P2 /large | Duplicates split conversation and deal history | Preview duplicate candidates using normalized identities; reversible reviewed merge with mapping/audit, never name-only auto-merge | Tenant managers; domainFK/retention review; PII-sensitive operation requires product approval |
| P2 /medium | Inbox backlog has no clear service target | Assignment/SLA queue from actual receipt times and business calendar; no invented SLA uptime | Messaging managers/operators; tenant calendar; preserve human takeover |
| P2 /medium | Pipeline totals can imply unsupported certainty | Transparent weighted forecast with visible assumptions and amount/currency separation | Sales roles; actual deal stage/history; no financial promise |
| P2 /medium | Agent summaries may hide mistaken intent | Human-reviewed summaries and knowledge-backed draft replies, with cited internal sources and explicit send policy | Messaging operators; bounded model cost/tools; new sensitive processing needs approval |

Existing unified activity, quick replies, tags, agents, flows, tenant roles and
audit primitives should be extended rather than duplicated. Bulk actions need a
preview, bounded selection and an honest undo/correction model. Autonomous calls,
paid providers and full mailbox sync are not small readiness enhancements and
must not displace the release blockers.
