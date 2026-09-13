# Or-On Platform — full application audit, hardening, polish, and staging readiness

Use this entire document as an execution prompt. This is an audit-and-implementation assignment, not a request for a report alone.

## 1. Mission and execution boundaries

Act as a principal full-stack engineer, QA lead, application-security engineer, PostgreSQL specialist, SRE, and senior product designer. Audit, validate, repair, simplify, secure, and polish the existing Or-On Platform end to end. Prepare it for a controlled development/staging deployment on one GCP Compute Engine VM, and identify and close the remaining requirements for a later production release.

Work in `OrOn-Platform`. Inspect the actual repository, configuration, tests, and running application. Do not infer that a feature works from its UI, a README statement, or a successful build.

Read root and scoped `AGENTS.md`, referenced instructions, `MASTER_PROMPT.md`, `docs/progress.md`, architecture decisions, and relevant runbooks. Continue from the actual current checkpoint; do not restart historical integration phases or reset to an old branch. This assignment advances the existing application into readiness work. Earlier Phase 1 infrastructure placeholders are historical context, not a reason to leave staging deployment artifacts unfinished. Preserve the accepted architecture.

Mandatory operating rules:

- Preserve all existing user changes. Record the branch, HEAD, working-tree changes, and baseline failures before editing. Do not reset, discard, automatically stash, commit, push, or overwrite unrelated work.
- Treat `../or-on`, `../wacrm`, and `../openlive` as read-only source references. Keep the application independently buildable without them. Preserve upstream attribution and licenses.
- Keep PostgreSQL as the only authoritative runtime database, Alembic as the sole schema migration authority, pnpm for JavaScript, and uv for Python. Preserve established service and contract boundaries.
- Keep proven voice, messaging, and orchestration engines. Do not introduce a framework rewrite, competing database, Kubernetes, or speculative infrastructure for this assignment.
- Implement changes in small, reviewable increments with verification and a recovery strategy. Avoid mixing broad cleanup, schema redesign, dependency upgrades, and visual changes in one increment.
- Continue independently on reversible work. Prepare and validate deployment artifacts, but do not provision cloud resources, apply infrastructure, deploy, send real messages/emails, place calls, charge cards, or enable paid providers without explicit authorization for those actions.
- Never request that credentials be pasted into chat. Use existing secure configuration mechanisms. Report missing configuration by name only.
- A zero-regression guarantee is not technically provable. Treat “nothing breaks” as a requirement for regression evidence, backward compatibility, and tested recovery. Never substitute confidence or a green build for that evidence.

## 2. Establish an exhaustive, evidence-based inventory

Before changes, inspect all source areas: web app, shared packages, Python and TypeScript services, database/migrations, workers, APIs, integrations, configuration, infrastructure, CI, tests, scripts, assets, and documentation.

Discover features from routes, route handlers, navigation, dialogs, forms, permissions, job handlers, provider adapters, and database access. Include nested pages, deep links, hidden administrative capabilities, downloads, uploads, exports, and background-only behavior. Do not stop at the sidebar.

Create or update `docs/readiness/feature-matrix.md`. For every feature and significant action, record:

- Route or entrypoint; relevant frontend, backend, and database code.
- Allowed roles and tenant boundaries; dependencies and integration readiness.
- Actual data source and whether the path is real, simulated, incomplete, or unavailable.
- Expected outcomes; tested success, failure, edge, concurrency, and recovery cases.
- Test/evidence location, observed defects, severity, fix status, and remaining limitations.

Use explicit statuses: unreviewed, failed, fixed-awaiting-verification, verified-local, verified-staging, blocked, or deferred-with-reason. An untested path cannot be marked passed. Required broken functionality cannot be hidden or reclassified as optional simply to pass the gate.

Record baseline checks, console/network failures, screenshots of key screens, representative query timings, API latency, bundle sizes, and navigation behavior. Rank work by security/data integrity first, broken core workflows second, then reliability, performance, polish, and cleanup. Audit broadly before deleting or restructuring code.

## 3. Remove misleading demo behavior and clean the codebase

Find hardcoded contacts, conversations, analytics, balances, expenses, success responses, synthetic graph points, fake provider statuses, placeholder results, TODO implementations, and runtime fallback arrays. Trace each to its actual execution path.

Replace customer-facing mock data with authorized backend data. When data is absent, show an honest empty state. When a dependency is unavailable, show a clear configuration or error state. Never convert failed reads into empty successful responses or failed writes into success messages.

Keep deterministic fixtures, provider fakes, and simulators for isolated tests and explicitly labeled development tools. Ensure staging customer workflows cannot silently route through simulations or mix simulated records into real analytics. Do not enable real traffic merely to remove mocks. Disable or protect preview endpoints, simulator routes, demo logins, and auto-seeding in the staging profile.

Identify existing demo database records by reliable provenance, not names, dates, or assumptions. Prepare a dry-run report with exact IDs/counts, dependent records, and recovery steps. Do not delete existing user/database data automatically. Preserve audit and financial history; use appropriate correction records where required.

Remove genuinely unused imports, code, assets, files, and dependencies after checking static references, dynamic imports, framework conventions, CLI entrypoints, build scripts, container stages, plugins, generated clients, migrations, and feature flags. Preserve historical migrations, licenses, and legitimate optional integrations. Keep a deletion/dependency-change rationale. Update lockfiles through the designated package manager.

Fix relevant code duplication and error handling. Avoid broad catch-and-ignore blocks, mutable global tenant state, unsafe casts, and unnecessary dependencies. Use compatible supported security updates; isolate major upgrades with migration evidence. Do not weaken tests, typing, lint, permission checks, or dependency guards to obtain a passing result.

## 4. Validate every feature through its complete workflow

At minimum, cover the following actual product areas, then extend this list from discovery:

1. **Identity and public entry:** login, logout, session refresh/expiry/revocation, profile updates, password changes, invitation creation, expiry, acceptance, reuse, and revocation. Public login/invitation routes must not expose the application shell. Verify existing-account invitations, concurrent acceptance/revocation, and revoked membership access.
2. **Tenant administration:** tenant creation, initial owner/membership, configuration options, defaults, switching, users, roles, permissions, settings, API keys, and notifications. Creation must be atomic or recoverable; failure cannot leave privileged orphan records. Prevent privilege escalation and unintended last-owner lockout.
3. **Contacts and pipelines:** create/read/update/delete where supported, search, filtering, sorting, pagination, imports/exports, tags, notes, custom fields, duplicate identities, ownership, consent, activities, deal changes, drag-and-drop, and concurrent edits. Ensure search covers its advertised dataset and exports obey the same permissions as the UI.
4. **Inbox and WhatsApp:** inbound webhook to persisted message to live inbox; assignment/filter/unread behavior; history pagination; drafts; sending; attachments; templates; reactions; delivery/failure/read states; reconnects; contact context; and human/AI ownership. Test duplicate and out-of-order events, retries, two agents replying, lost connectivity, and rapid conversation switching.
5. **AI agents and handoff:** published versions, tenant-scoped configuration, bounded tool permissions, inference failures, timeouts, cost limits, escalation, and human takeover. If takeover occurs while generation or a queued reply is pending, the stale AI response must not be sent. Resumption must be explicit and auditable.
6. **Email and OAuth:** Google/Microsoft connection through the UI; permissions, callback/state validation, consent denial, reconnect/disconnect, token expiry/refresh, encrypted credential storage, and configuration errors. Verify whether mailbox sync and actual email actions exist. Do not describe successful OAuth connection as a working email client. Tenant admins must not need filesystem access to configure tenant credentials.
7. **Calendar and tasks:** create, edit, complete/cancel/delete where supported, assignment, linking to contacts/deals, views, filters, due dates, reminders, and persistence after reload. Test time zones, UTC boundaries, Hebrew/English date formats, DST transitions, all-day events, overlaps, and recurrence only if supported.
8. **Voice and calls:** contact call initiation, required permissions/consent, number configuration, dispatch, call lifecycle, recording/transcript access, outcomes, failures, and contact timeline. Validate with simulators by default. Preserve the requested streamlined UI while retaining enforceable server-side authorization and provider controls; do not reintroduce removed redundant checkboxes as a substitute for backend safety.
9. **Campaigns and automation:** audience eligibility, consent/opt-out changes after scheduling, publish/run/cancel, schedules, throttling, retries, immutable versions, invalid/cyclic flows, bounded execution, replay, worker restart, and resulting messages/calls/CRM updates. Financial and external side effects must not repeat on retry.
10. **Finance:** real tenant expenses, usage, currency, payment source connection, checkout, wallet/ledger behavior, reconciliation, and failed/canceled/pending payments. Never mint demo funds. Credit only from a verified completed-payment event with matched tenant, customer, currency, amount, and expected transaction. Never credit from a redirect or client-supplied success flag. Test webhook replay/concurrency, refund/dispute handling where applicable, and provider-disabled behavior. Keep raw card data out of the application.
11. **Overview and analytics:** reconcile totals and trends with stored records, scopes, UTC/local-date definitions, and delivery states. Verify empty periods, large spikes, partial days, failed data loads, and accessible tabular alternatives. Charts must not invent data.
12. **Profile and organization images:** upload, replace, remove, invalid MIME/content, oversized files, failed loads, cache/reload, and tenant switching. Personal photos and organization logos must use the correct identities. Transparent images must replace fallback initials, with no “OR” visible underneath.
13. **System operations and secondary surfaces:** health, audit trails, integration configuration, command palette, deep links, help, error routes, WebSocket sessions, API clients, and discovered optional desktop/Live Lab capabilities. Record deliberate deferrals without claiming implementation or removing their legitimate source code.

For each applicable action, test: valid input; empty/invalid/boundary input; long Unicode/RTL text; no records and large datasets; permission denied; missing/deleted object; stale state; double submission; retries; request cancellation; refresh/deep link; expired session; backend/provider outage; database failure; concurrent requests; and tenant isolation. Use risk-based combinations and record coverage; do not claim exhaustive input testing.

After a mutation, verify the response, persisted state, subsequent read/reload, relevant worker effects, and audit record. Use real isolated PostgreSQL integration tests for persistence and authorization, not only mocked repositories.

## 5. Security and abuse resistance

Update the threat model from observed code and trust boundaries. Reconcile historical “not implemented” statements against current integrations, uploads, and credential storage; review expired security exceptions and fresh dependency advisories. Use current official framework/provider guidance and applicable OWASP ASVS controls as a verification checklist; report evidence and residual risk without claiming certification.

Inspect and repair:

- Server-side authorization on every read/mutation, object ownership, role changes, tenant creation, exports, uploads/downloads, and background jobs. Hidden navigation is not authorization.
- Fail-closed PostgreSQL RLS using runtime non-superuser roles. Test missing tenant context, pooled-connection reuse, cross-tenant IDs, and indirect leaks through caches, counts, search, logs, files, and real-time subscriptions.
- Sessions, cookie flags, CSRF, origin/CORS policy, password hashing, enumeration resistance, rate limits, open redirects, and prompt revocation after user/role changes.
- OAuth state binding, PKCE where supported, exact callback allowlists, tenant/user binding, one-time use, least scopes, encrypted tokens, secret rotation, and refresh races.
- Injection, XSS in messages/email/rich text, unsafe rendering, SSRF in provider URLs/media fetching, path traversal, malicious uploads, MIME spoofing, decompression/resource exhaustion, and spreadsheet formula injection in exports.
- Webhook signatures using the correct raw body, replay/deduplication, durable acknowledgement, bounded payloads, and malformed/out-of-order events.
- API keys, service credentials, WebSocket authentication, secret/PII redaction, browser bundles, sourcemaps, error messages, public health details, and dependency/container supply-chain risks.
- AI prompt injection and tool abuse: treat conversations, files, tool output, and retrieved content as untrusted; enforce tenant scope, tool authorization, egress restrictions, time/token/cost limits, and action policy in code rather than relying on prompts. Block access to arbitrary server files, commands, credentials, and privileged mutations.
- Spending/rate/recipient limits, consent enforcement, operator audit trails, and financial correctness. Use integer minor units or suitable fixed-precision values, never floating-point wallet arithmetic.

Assess MFA, recovery, invitation delivery, verified email changes, session management, retention/export/deletion, and audit access. Complete bounded missing parts of existing workflows. Identify substantial new capabilities and release-blocking gaps explicitly instead of improvising insecure substitutes. Define distinct controls for private test staging and customer-facing production.

## 6. Database correctness and measured performance

Inventory hot queries, joins, RLS policies, constraints, indexes, transactions, pools, workers, and migration history. Benchmark realistic multi-tenant volumes in an isolated database. Record dataset size, hardware, concurrency, warm/cold behavior, and before/after plans and timings.

- Use `EXPLAIN (ANALYZE, BUFFERS)` only on safe, bounded queries in the benchmark environment; remember ANALYZE executes the query.
- Fix N+1 patterns, unnecessary columns/round trips, unbounded scans, blocking synchronous work, and inappropriate pagination. Use deterministic ordering and suitable keyset pagination where justified.
- Add composite/partial indexes based on real filters, sorts, and tenant scope; measure their write/storage cost. Do not add indexes speculatively or disable RLS for speed.
- Preserve cross-tenant referential integrity, unique identities, check constraints, transaction atomicity, and correct concurrent edits. Test deadlocks, lock/statement timeouts, retries, and pool exhaustion.
- Scope caches to tenant/user/permission/query as appropriate. Invalidate after writes, revocation, and tenant switching. Business correctness must survive cache loss.
- Verify transactional inbox/outbox behavior, durable jobs, claims/leases, crashes, bounded retry/dead-letter handling, and idempotent effects. Reject reuse of an idempotency key with a different payload. Recheck authorization, consent, and human/AI ownership immediately before external effects. LISTEN/NOTIFY is only a wake-up mechanism. Do not promise exactly-once external delivery without reconciliation evidence.
- Preserve one Alembic head. Test fresh install and upgrade from the prior schema. Prefer compatible expand/contract changes and resumable bounded backfills. Assess lock duration and concurrent index requirements.
- App rollback must remain compatible with the migrated schema. Never automatically downgrade or restore a database over new writes to make an old image work. Document irreversible changes and recovery limits.
- Verify backups, restore into a new database, integrity/row-count checks, roles/RLS, media metadata/object consistency, retention, and encryption-key recovery. Document measured recovery time and possible data-loss window. A backup file alone is not a restore test.

## 7. UI/UX final polish and responsiveness

Preserve the accepted Studio reference design from the local `next-shadcn-admin-dashboard-baseui` reference and the user's screenshots. Locate and inspect the actual reference components. Do not invent a different design direction or import demo functions. Use the current Or-On feature set, logo, English/Hebrew support, and established design tokens.

Inspect every page and meaningful state in a browser using the real local backend with isolated test data. Compare at matching viewport, theme, and locale. Cover mobile widths around 360–390 px, tablet, desktop, wide desktop, and intermediate widths where wrapping fails.

Correct spacing, typography, alignment, card heights, unintended gaps, overflow, clipped menus, scroll regions, sticky headers, forms, tables, drawers, dialogs, tooltips, loading/empty/error/success states, and readable contrast. Check long names, small screens, keyboard focus, touch targets, zoom, screen-reader labels, and reduced motion. Target applicable WCAG 2.2 AA criteria; document manual checks and gaps.

Explicitly recheck known regression areas:

- Inbox's reference-style column proportions and composer behavior.
- Calendar/Tasks/Tenants availability and responsive navigation.
- Dashboard compact straight-segment charts, full spike rendering, complete animation, and aligned cards.
- Light/dark transitions and readable theme/language options across both themes.
- Login/invitation layouts, branding, and shell-free public access.
- User/organization image separation, replaced fallback initials, and upload/reload behavior.
- No language/theme selectors reappearing in the bottom account popover.

Use animations to support feedback. They must not clip data, delay navigation, cause layout shifts, trap focus, or replay endlessly. Check final chart frames after animation and under reduced motion. Use screenshots/visual comparisons plus functional interactions; CSS-string tests alone do not prove visual correctness.

## 8. Speed, resilience, and observability

Measure production-mode performance, distinguishing development compilation delays from runtime latency. Profile initial load, route transitions, critical APIs, database calls, large tables, charts, message history, and live updates. Set explicit, justified latency and resource budgets from the measured baseline and intended VM workload; report p50/p95/p99 with conditions and sample size, not invented gains.

Fix waterfalls, blocking optional-provider calls, excessive client JavaScript, avoidable rerenders, uncontrolled polling, memory leaks, unbounded history rendering, and unnecessary refetches. Use prefetching, caching, code splitting, virtualization, and cancellation where measurements justify them. Ensure these optimizations preserve authorization and freshness.

Exercise slow networks, provider timeout, API 429/5xx, broken connections, tab/background transitions, reconnect, process/VM restart, worker crash after provider acceptance, database disconnect, disk pressure, and exhausted pools. Use a disposable isolated stack for mutation, load, fault-injection, and restore tests: separate databases, queues, volumes/object prefixes, and ports; exclude live credentials and disable real-provider, billing, and AI execution flags. Isolated rows inside the user's running stack are insufficient. Do not restart user processes, consume their queued jobs, reset their database, or exhaust shared disk/resources. Use bounded retries with jitter, backpressure, idempotency, graceful shutdown, and explicit recovery paths. Preserve drafts and prevent duplicate mutations.

Provide redacted structured logs, correlation IDs across requests/jobs, actionable errors, separate liveness/readiness, pool/queue/worker metrics, delivery and payment failures, slow-query visibility, backup failure alerts, and disk/memory monitoring. Bound and rotate logs. Validate important alerts rather than merely adding configuration.

## 9. Prepare the GCP VM staging deployment

Produce a runnable, reproducible deployment, not only an architecture document. Follow `docs/architecture/gcp-dev-target.md`: one Compute Engine VM, Docker Compose, Caddy, PostgreSQL on persistent disk, private GCS media/backups, Artifact Registry, and Secret Manager. Do not substitute Cloud SQL or another hosting platform for this first deployment.

- Build production-mode images for all required application services, with pinned dependencies/images, appropriate non-root users, health checks, restart behavior, resource bounds, private networks, persistent volumes, and log rotation. Keep development servers and demo bootstrap out of the staging entrypoint.
- Prepare Terraform resources and validated variables for the VM/network/disk/IAM/registry/buckets/secret metadata. Keep project, region, machine sizing, domain, and cost estimates explicit assumptions until supplied. State backend/locking, deletion-protection, and replacement implications. Do not place secret values in Terraform or state.
- Serve a single HTTPS origin with correct proxy trust, cookie behavior, request limits, security headers, WebSocket upgrades, OAuth callbacks, and narrowly public provider webhooks. Restrict staging access while preserving required callback/webhook routes. Expose no public database or internal administration/debug ports. Open media/SIP ports only for verified enabled requirements.
- Use a least-privilege VM service identity for Secret Manager and GCS; prepare keyless CI authentication with Workload Identity Federation restricted to the intended repository/ref/environment. Avoid downloaded service-account keys. Follow official [Secret Manager guidance](https://docs.cloud.google.com/secret-manager/docs/best-practices) and [deployment federation guidance](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines), verifying current details during implementation.
- Configure OS Login/IAP-compatible administration, private buckets, restricted object access, separate staging secrets/data, backup schedules, disk monitoring, OS patching, and bounded log retention.
- Implement a protected manual deployment pipeline: verify → build/scan/SBOM → immutable image manifest → backup → one-shot migration → start → readiness → functional smoke tests → record release. Validate startup ordering and migration race prevention.
- Implement and exercise a schema-compatible rollback and restore-to-new-database recovery procedure in an isolated local environment. Record cloud-only tests still pending. Restore must not accidentally replay payments, messages, or calls.

Verify Compose rendering, container builds, clean startup, persisted data after restart, migrations, backup/restore, and smoke tests locally. Run Terraform formatting and validation without applying resources. Prepare cloud validation and deployment commands for later authorization. Configuration prepared, locally verified, and actually deployed are different statuses.

## 10. Thoughtful CRM enhancements

After auditing existing capabilities, create `docs/readiness/crm-improvements.md` with a ranked backlog grounded in actual workflow gaps. For each idea state the user problem, existing overlap, expected value, affected roles/data, dependencies, security/privacy implications, effort, acceptance criteria, and release priority.

Evaluate examples such as saved/shared views; duplicate-contact detection with reversible merge; assignment and SLA queues; overdue follow-up reminders; unified customer timeline; reusable replies and knowledge-backed AI drafts; onboarding/integration diagnostics; bulk actions with preview/undo; import error recovery; agent summaries with human review; transparent pipeline forecasting; and audit/history visibility.

Implement small, additive, reversible improvements that clearly finish or improve existing workflows and pass the same gates. Put substantial new modules, paid integrations, autonomous actions, new sensitive-data processing, or major workflow changes in the roadmap for a separate product decision. New features must not displace readiness fixes or become empty navigation tabs.

## 11. Verification, evidence, and completion

Use existing checks first. Inspect `Makefile`, `scripts/dev.py`, package scripts, CI, and `docs/runbooks/verification.md`; do not invent test command success. Run the smallest relevant checks after each change, then the consolidated gate (`make verify`, or the supported `uv run python scripts/dev.py verify` equivalent on Windows). Verify safe isolated database configuration before executing mutation-capable verification/bootstrap commands.

The final gate must include appropriate TypeScript/Python formatting, lint, strict typing, unit tests, real-PostgreSQL migrations/RLS/integration tests, API/event/WebSocket contract freshness, dependency boundaries, sibling independence, security/dependency/container/secret scans, production builds, container startup, browser E2E, and focused visual/accessibility checks. Add meaningful regression coverage for behavioral/security/data bugs, not tests that merely restate CSS or implementation details.

Use multiple tenants and roles in isolated fixtures. Validate changed authorization with negative tests. Record commands, environment, duration, pass/fail/skipped results, screenshots, performance comparisons, migration revisions, and findings. Do not suppress failures, bless broken screenshots, disable assertions, or report unavailable provider/cloud validation as passed.

Maintain concise artifacts under `docs/readiness/`: feature matrix; findings/risk register; verification evidence; performance report; data-cleanup plan; deployment/recovery runbook; CRM roadmap; and final release decision. Update `docs/progress.md` with completed work and the exact next action. Keep evidence free of credentials and customer data.

Completion criteria:

- Every discovered feature is reviewed; every supported in-scope workflow has evidence, including applicable negative and edge cases.
- Required workflow failures, tenant/data-isolation defects, and confirmed release-blocking security issues are fixed and verified. Any unresolved critical/high finding or major gap blocks the applicable release decision; it cannot be waived by the agent alone.
- No customer-facing fake business data, invented balances, silent simulations, or success-shaped error fallbacks remain.
- UI changes have been exercised in both themes and English/Hebrew across responsive layouts; known regressions have explicit evidence.
- Performance improvements are measured and correctness/security checks remain intact.
- Production-mode local startup, migration upgrade, restart, backup/restore, and release recovery have passed, or are clearly listed as blockers.
- GCP staging artifacts are ready to review; cloud deployment and live-provider verification are separately identified as pending when not authorized or available.

Final report: give two separate decisions—**ready/not ready for controlled GCP staging deployment** and **ready/not ready for customer-facing production**—with evidence and exact blockers. Also summarize completed fixes, deleted code/dependencies, measurements, tests, remaining risks, staged versus unverified integrations, required configuration names, recovery procedure, and prioritized feature ideas. Never claim production readiness, complete security, deployment success, or zero regressions without the relevant evidence.

Start by recording the baseline and creating the feature inventory, then proceed through implementation and verification. Continue useful independent work when one integration is blocked. At context boundaries, persist findings and the next task so work resumes without repeating completed phases. Do not stop after the audit report while actionable authorized work remains.
