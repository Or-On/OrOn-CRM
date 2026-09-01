# Phase 4 — CRM and WhatsApp

## Mission

Integrate WACRM's proven CRM and WhatsApp behavior into the authenticated
Or-On shell while replacing Supabase-specific runtime coupling with the
canonical PostgreSQL, identity, RLS, object, event, and job foundations.

Phase 4 preserves behavior through bounded adapters. It does not copy the
WACRM application wholesale, introduce a second migration authority, or permit
real WhatsApp traffic by default.

## Runtime shape

```text
authenticated browser
  -> same-origin Next.js BFF
  -> tenant-scoped CRM/messaging repositories
  -> canonical PostgreSQL

simulator or verified Meta webhook
  -> durable inbound event
  -> messaging worker
  -> contact identity + conversation + message
  -> authenticated inbox

human reply or broadcast
  -> transactional message/outbox/job state
  -> simulator by default
  -> Meta adapter only with explicit flag and user approval
```

The browser never connects directly to PostgreSQL. The BFF resolves the
canonical session and sets transaction-local tenant, user, and role context.
The messaging worker uses its least-privilege role and durable PostgreSQL work.

## Delivery slices

1. Canonical CRM repository and tenant-safe API conventions.
2. Contacts, tags, notes, custom fields, CSV import, and deduplication.
3. Shared inbox, assignment/status/unread behavior, messages, replies, reactions,
   quick replies, and same-origin live refresh.
4. Pipeline stages, deals, and keyboard-accessible movement.
5. Templates, broadcasts/campaigns, recipient state, resumable durable delivery,
   and simulator results.
6. Automation definitions/runs using the canonical versioned graph persistence.
7. Team membership/invitations, CRM settings, WhatsApp simulator configuration,
   dashboard analytics, scoped REST API, and MCP-compatible tool surface.
8. Verified raw-body webhook ingestion and a default-safe provider simulator.

## Safety and compatibility gates

- `ENABLE_REAL_WHATSAPP=false` is enforced at the lowest provider boundary.
- Simulator identifiers are deterministic enough for idempotency tests and are
  never confused with Meta identifiers.
- Webhook POSTs persist a unique inbound event before acknowledgement or return
  an explicit failure; detached best-effort processing is prohibited.
- Raw-body HMAC verification is mandatory for the real Meta route. Simulator
  routes require an authenticated development session and CSRF protection.
- Contact phone/WhatsApp identities use canonical E.164 values and database
  uniqueness. Raw numbers are not the sole deduplication mechanism.
- Every query executes with tenant-local PostgreSQL context. Cross-tenant tests
  cover each new repository surface.
- No Supabase package, auth claim, Realtime, Storage, or migration runner enters
  the target runtime.
- Copied or substantially adapted MIT code is recorded in the source map and
  retains required notice treatment.

## Acceptance

- X-01: simulated inbound WhatsApp event appears once in the live inbox.
- X-02: human reply is delivered through the simulator and status progresses
  without any real provider traffic.
- W-06: contacts support CRUD, tags, notes, import, dedupe, and tenant isolation.
- W-08: pipelines/deals support persisted ordered stages and status/value changes.
- W-15/W-16: broadcasts create a stable audience, claim durable work, resume, and
  produce recipient/aggregate states idempotently.
- W-17: automation definitions can be drafted, published, run, and inspected
  without replacing either mature execution engine prematurely.
- Team, analytics, settings, API, and MCP surfaces use canonical identity and
  authorization.
- Production web and worker builds, PostgreSQL migrations/RLS tests, simulator
  end-to-end tests, repository guards, and dependency audits pass.
- All three upstream worktrees remain clean and locked; no real message, call,
  webhook mutation, provider provisioning, or Terraform apply occurs.

