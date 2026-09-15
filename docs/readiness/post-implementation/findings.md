# Findings, implemented fixes and remaining issues

## Resolution summary

No confirmed unresolved P0 defect was found in the locally testable source. The
review did find and fix multiple high-impact workflow, privacy and release
reliability defects. The authorized DEV release and online PostgreSQL/RLS gates
passed. Production approval remains withheld because authenticated role/device,
real-provider and disaster-recovery boundaries are not complete.

### Implemented in this working tree

| Area | Confirmed defect or missing completion | Resolution and regression evidence |
| --- | --- | --- |
| Case lifecycle | UI offered statuses outside the domain graph | Added `nextServiceCaseStatuses`; the UI derives only legal transitions, including deliberate reopen paths, and the terminal closed state is explicit. Domain tests cover every state. |
| Sensitive customer evidence | Identity documents used generic CRM document authorization | Identity document upload/read/delete now requires `customer-sensitive:write/read`; unauthorized lists omit them. Eleven focused storage/permission/header tests pass. |
| National-ID lifecycle | Encrypted value could be changed but not intentionally cleared from UI | Added an authorized, audited clear action using the existing protected-field service; routine display stays masked. |
| Customer documents and locations | Incorrect records required direct database work | Added audited archive for documents and edit/archive for service locations; history is preserved rather than physically erased. |
| Technician onboarding | Creation UI did not submit the supported user link/verification data; deactivation was unreachable | Added linked-account selection, verified status, edit, deactivate/reactivate and server validation. An additive trigger restricts active links to active users with the tenant technician role. |
| Case/contact discovery | First 100/200 rows were treated as the searchable universe | Added stable server keyset pagination and server search for contacts/cases, load-more UI, dedupe and stale-response reset. Labels describe loaded scope instead of a false total. |
| Archive completeness | A 5,000-row archive could silently look complete | Archive generation now checks up to 25,001 and refuses an incomplete export beyond the documented 25,000-record bound. |
| Scheduling | Idempotency ignored changed payloads; reschedule could not change technicians or revalidate target | Idempotency now binds all scheduling inputs, rejects key reuse with changed payload, requires an active technician and rechecks availability. Reassignment is reachable in UI/API. |
| Attendance evidence | Upload and signature were two failure-prone operations; retry could duplicate evidence | Attendance is one transactional multipart API with stable request identity, audit reconciliation, progress/cancel/retry UI and normal-failure object cleanup. Generic uploads reject reserved signature categories. |
| Private uploads | Declared MIME and a short magic prefix were insufficient | Added structural PNG/JPEG/WebP validation, dimension/decoded-pixel limits, PDF EOF validation, strict text decoding and hardened private download headers. Unsupported content fails closed; malware scanning is not claimed. |
| Webhook resource bounds | WhatsApp request JSON had no explicit application body bound | Added streaming 2 MiB limit, content-length validation, cancellation and 413 regression coverage without changing signature verification. |
| OAuth connection lifecycle | Connected Gmail/Outlook channels had no reachable disconnect operation | Added fresh tenant-manager authorization, provider-scoped channel revocation, encrypted-token tombstoning, pending-state invalidation, audit, bilingual UI/error state and idempotency tests. Upstream provider revocation remains an explicit provider-account action. |
| Feature revocation | Queued field-service jobs could continue after tenant deactivation | Intake, media, OCR and summary jobs recheck current feature/readiness before and after provider work; cancellation does not interrupt ordinary messaging. |
| Client/server boundary | Importing one transition helper through the CRM root pulled PostgreSQL code into the client bundle | Added a browser-safe `field-service-domain` package subpath. A clean production build passes. |
| CI exit status | Remote cleanup separated by `;` could conceal deployment failure | Deployment uses `set -e` and an exit trap; archive checksum and exact source/image identity are required. Regression tests inspect the workflow. |
| Release admission | Archive/image identity and unsafe entries were insufficiently bound | Added exact archive file/type/path/count validation, SHA-256 verification, five distinct digest keys and OCI revision verification before the running release is touched. |
| Migration and RLS executability | CI exposed Python `# noqa` text embedded in rendered SQL, unsafe downgrade ordering, a polymorphic fixture parameter, and an object policy that required unrelated voice-role table privileges | Removed invalid SQL, made the offline guard reject Python comments, moved dependent-function teardown after policy/table removal, cast the fixture parameter, and encapsulated technician object access in a tenant-bound `SECURITY DEFINER` predicate. Focused database/release checks pass; CI remains the online authority. |
| Same-second WhatsApp ordering | Meta message time has one-second precision; latest-message and callback admission used random UUID as the tie-breaker, which could suppress a valid follow-up/callback | All worker, callback and linked-case evidence paths now use provider time plus database ingestion time before UUID. The PostgreSQL acceptance fixture forces consecutive events into one second and all 13 cross-channel cases pass. |
| Migration/rollback safety | Previous writers could run during migration; rollback restarted optional profiles indiscriminately | Deploy drains active calls, stops admission/writers, backs up, migrates, verifies exact images and restores only profiles that were previously running. |
| Recovery scope | Database-only backup omitted private evidence and recordings | Backup bundles custom-format DB dump, private objects/recordings, release/schema metadata and internal/outer checksums with restrictive permissions. |
| Readiness harness | Local readiness referenced removed staging files | Added an owned readiness Compose/Caddy configuration and repaired the harness contract. Full runtime start remains blocked by the unavailable Docker daemon. |

### Changed-file groups

- Database/domain: additive `a26f09c4d13e` field-service foundation and
  `b72c5f0e4d91` lifecycle migration, schema manifest, CRM tenant features,
  protected fields, field-service/storage/export services and authorization.
- Web/API: field-service pages and APIs, contact dossier/search, settings and
  tenant administration, responsive forms, bilingual copy and download routes.
- Workers/providers: field-service jobs, WhatsApp admission/AI/callback paths,
  current-feature rechecks and provider simulations.
- Release/recovery: CI, five image definitions, Caddy limits, deployment/backup
  scripts, readiness stack and deployment runbook.
- Tests/evidence: domain/API/component/worker/PostgreSQL/deployment regressions,
  source map, runbook and this readiness directory.

This is a grouped review aid; [Baseline](baseline.md) is the exact working-tree
identity and `git status --short --untracked-files=all` remains the authoritative
path list.

## Remaining required issues and blockers

| Severity | Status | Impact | Exact next action / reason blocked |
| --- | --- | --- | --- |
| P1 | **BLOCKED — authenticated acceptance** | Exact source/images/schema are deployed, but ordinary-role and second-tenant browser journeys were not exercised | Run authenticated acceptance with disposable owner/admin/agent/technician/viewer identities and a second tenant; no suitable DEV QA credentials were supplied. |
| P1 | **BLOCKED — provider/device** | WhatsApp delivery, callback, two-way Hebrew voice, OCR and Stripe/OAuth completion are not end-to-end proven | Approve a bounded run manifest with controlled accounts/numbers/spend, deploy the exact candidate, then correlate UI/request/job/provider/callback/persistence. No live side effect was authorized. |
| P1 | **OPEN — disaster recovery topology** | A single VM backup can be lost with the host; production recovery objective is unproven | Configure encrypted off-host retention and restore the complete DB/object bundle into a separate destination. Current source supports complete local bundles only. |
| P2 | **OPEN — crash-only orphan recovery** | A process crash after filesystem promotion but before DB commit may leave an unreferenced private file | Add a checksum/object-metadata reconciler and quarantine/delete policy. Ordinary exceptions already clean up and retries reconcile signed audit evidence. |
| P2 | **OPEN — complete contact-detail history paging** | Linked service cases on one contact detail view remain bounded to 200 | Add cursor paging to that sub-view if tenants can exceed the bound; the field-service directory itself is paged. |
| P2 | **PRODUCT/SECURITY DECISION** | MFA, account recovery and active-session management are not implemented as public workflows | Select an identity/MFA/delivery design before advertising recovery or privileged-account MFA. Do not add insecure email/token shortcuts. |
| P2 | **PRODUCT DECISION** | Gmail/Outlook connection does not provide mailbox sync/send; local disconnect cannot prove immediate upstream consent revocation; field scheduling does not write external calendar events | Decide whether these are in scope, then add least-privilege provider contracts, durable reconciliation and explicit approval. Current UI remains truthful about connection versus capability and tells operators when provider-account revocation is required. |
| P2 | **OPEN — upload malware controls** | Structural validation does not establish malware-free files | Add a quarantine/scanner service before accepting additional active document types; keep current allowlist and forced-download headers. |
| P2 | **BLOCKED — representative performance** | p50/p95 API/DB/UI and worker throughput budgets cannot be measured without runtime/data | Seed an owned tenant-separated dataset beyond paging bounds and capture query plans, request latency and mobile traces on the intended VM. |
| P2 | **BLOCKED — native UI/accessibility** | Component tests do not prove iOS Safari, Android Chrome, screen reader, 200% zoom or weak-network camera behavior | Execute the documented device matrix on the exact release with fictional evidence files and capture console/network/geometry results. |
| P2 | **PRODUCTION ARCHITECTURE** | Single-host DEV has no HA, managed DB/object store or centralized observability | Define production SLO/RPO/RTO, high-availability topology and capacity plan before a production verdict. |

## Performance disposition

No credible before/after runtime latency is reported because no authenticated
representative DEV dataset was available. The bounded
source improvements are measurable by behavior—keyset queries now request at
most 101 rows per contact/case page and archives refuse silent truncation—but
they are not labeled a performance win without query plans and p50/p95 samples.
Production build completion in CI is recorded only as release evidence, not
end-user latency.

## Optional ideas, excluded from the release blockers above

Saved views, duplicate-contact assisted review, richer audit visualization and
advanced external-calendar booking could be useful. They are separate product
work and were not allowed to displace correctness of existing enabled journeys.
