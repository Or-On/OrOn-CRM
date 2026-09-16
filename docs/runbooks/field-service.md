# Field service and technician module

The field-service module is an optional, tenant-isolated CRM capability. It
adds service cases, technician scheduling and attendance, evidence uploads,
OCR-assisted product-label review, report revisions, and a unified case
dossier. It uses the CRM's canonical contacts, WhatsApp conversations, calls,
jobs, authorization, PostgreSQL, and private-object metadata.

The module is unavailable and disabled by default. Enabling it never enables a
real provider, AI processing, calendar writes, billing, or shared technician
access by implication.

## Access model

Four independent checks apply:

1. **Platform entitlement** — a platform super administrator grants the
   `field_service` capability to a tenant.
2. **Tenant activation** — an owner or administrator enables the module in
   Settings for that tenant.
3. **User permission** — the request must carry the appropriate
   `field-service:read`, `field-service:operate`, or `field-service:manage`
   permission. The built-in technician role is deliberately restricted.
4. **Integration readiness** — WhatsApp intake, OCR, AI scheduling, calendar
   writes, and shared technician access each have their own setting and runtime
   prerequisites.

Navigation visibility is only a convenience. Route handlers, CRM use cases,
PostgreSQL row-level security, mutations, attachment reads, worker jobs, and
event-triggered work all enforce the same tenant and feature boundaries.

Customer dossiers, classifications, service locations, and customer documents
are general CRM capabilities. They remain available according to ordinary CRM
permissions when field service is off.

## Activate a tenant

1. Sign in as a platform super administrator and open **Tenants**.
2. Create a tenant with **Field service & technicians** selected, or open the
   capability control for an existing tenant and grant it there. This makes the
   feature available; it does not activate it.
3. Switch to the tenant, open **Settings**, and find **Field service &
   technicians**.
4. Enable the module. Leave optional integrations off until their readiness
   indicators are satisfied.
5. Assign users one of the existing roles. Tenant owners and administrators can
   manage cases and configuration; agents can operate cases; technicians only
   see permitted assignments and reports; viewers are read-only.

The settings panel records who changed tenant activation and when. Entitlement
and configuration changes also write audit records.

The readiness block reports private evidence storage, protected-field keys,
WhatsApp AI extraction, OCR, calendar access, and shared-login configuration
separately. An enabled toggle is not presented as ready when its runtime
dependency is missing.

If the platform entitlement or tenant activation is revoked, new module work
and queued side effects stop at their next server-side feature check. Existing
records are retained. Tenant administrators can download the authorized CSV or
JSON archive index and individual JSON dossiers and evidence objects from the
same settings panel. Re-enabling the module does not replay historical messages
or calls.

## Integration settings

### Private evidence storage

Local development uses the root-confined private adapter:

```ini
ARTIFACTS_BACKEND=local
ARTIFACTS_LOCAL_ROOT=.objects
```

Objects are stored under tenant/case/category prefixes with restrictive file
permissions. The database retains the content type, byte length, checksum,
status, and private storage key. Downloads always pass through authenticated,
tenant-scoped routes. JPEG, PNG, WebP, PDF, and plain text are accepted within
the server limits; product-label OCR accepts image formats only.

In a multi-process deployment, configure the same absolute root in the web,
messaging-worker, and voice-dispatcher runtimes and mount the same private
volume into each of them. The deployment topology prepares that root for the
unprivileged runtime identities; a readiness indicator is green only when the
web process can actually read and write the configured path.

For an existing installation created before shared evidence storage was
introduced, complete a one-time private-configuration upgrade before releasing
the new containers:

1. Back up the three root-owned runtime environment files without displaying
   their contents.
2. Reuse the dispatcher's existing `FIELD_CIPHER_LOCAL_KEY` and
   `BLIND_INDEX_KEY` in the web and messaging-worker files. Never rotate either
   key during this upgrade, because retained encrypted fields and indexes must
   remain readable.
3. Set `ARTIFACTS_BACKEND=local` and
   `ARTIFACTS_LOCAL_ROOT=/var/lib/oron/objects` in all three files, retaining
   root ownership and mode `0600`.
4. Verify equality and decoded key lengths without printing secret values. The
   deploy preflight enforces these invariants before it stops the active
   release.
5. After restart, write a random, non-customer canary from the web runtime,
   read and remove it from the messaging runtime, then repeat in the opposite
   direction. Confirm the settings readiness indicator before accepting
   evidence uploads.

`ARTIFACTS_BACKEND=gcs` is intentionally rejected until a private cloud-object
adapter and its credentials are supplied for the target runtime. Do not use a
public bucket or expose `.objects` through a static file server.

Protected national IDs use the existing field-cipher and blind-index settings:

```ini
FIELD_CIPHER_BACKEND=local
FIELD_CIPHER_LOCAL_KEY=<32-byte deployment secret>
BLIND_INDEX_KEY=<independent deployment secret>
```

Keep both values in the deployment secret store. A national ID is stored as a
string, encrypted, queried through a blind index, masked in routine views, and
excluded from logs and ordinary AI context.

### WhatsApp intake

Field service does not add another public webhook. Configure the existing,
signed Meta route documented in
[WhatsApp Cloud API](whatsapp-cloud-api.md):

```text
POST https://crm.example.test/api/webhooks/whatsapp
```

The trusted WhatsApp channel/provider-account mapping establishes the tenant.
Message text, phone numbers, store names, and model output never select a
tenant. After the canonical webhook is authenticated, deduplicated, and
persisted, the messaging worker may enqueue field-service intake work only when
all of these are true:

- the tenant is entitled and the module is active;
- structured WhatsApp intake is enabled for the tenant;
- the persisted message belongs to a trusted tenant/channel mapping;
- the configured AI provider is available for structured extraction.

Text, image, and location messages may arrive separately or out of order. The
worker correlates them to a persisted intake draft, asks only for missing facts,
keeps unknown warranty as unknown, and requires a specific confirmation before
creating one awaiting-scheduling case. Provider retries reuse canonical message
and correlation identifiers. A new confirmed request can create a separate case
for the same contact or conversation.

AI extraction is a proposal. Server validation and permissions remain
authoritative. Ambiguous or incomplete intake can be handed to a human; any
authorized required-field override is explicit and audited.

If intake receives a national ID while the protected-field encryption or blind
index key is unavailable, the worker preserves the conversation and moves the
intake to the existing human-handoff queue. It does not retain the identifier in
plain text, repeatedly ask for it, or create an incomplete case.

### OCR and summaries

OCR and evidence summaries reuse the configured OpenAI-compatible LLM endpoint
used by the messaging worker. No second `AI_*` credential family is required.
Provider access remains optional: missing credentials leave OCR/manual-review or
summary processing visibly unavailable and do not block manual report work.

OCR retains the source label photo, proposed values, per-field confidence,
provider/model provenance, confirmed values, manual corrections, and processing
state. Reprocessing never silently replaces confirmed human fields.

### Scheduling and calendars

Manual scheduling works without external credentials. Times are persisted as
timezone-aware instants and displayed in the tenant timezone. Internal overlap
checks prevent active appointments for the same technician from colliding.

The only current calendar-backed option is the CRM's tenant calendar:

- `none`: manual scheduling only;
- `read_only`: AI may propose a slot but cannot approve it or create an event;
- `write`: an authorized, approved suggestion rechecks availability and writes
  one idempotent CRM calendar event.

AI scheduling is separately enabled and defaults to human approval. **Suggest
next available** searches only active technicians linked to the tenant calendar,
the CRM appointment ledger, and confirmed/tentative calendar events during the
next 21-day window (weekdays only). A suggestion is persisted as pending and creates
no calendar event. Approval rechecks availability and requires write access;
the public creation API cannot mark a new suggestion pre-approved. External
Google/Microsoft event creation is not claimed by this module.

## Technician workflow

1. Open an assigned case and create or open its visit.
2. For a tenant-scoped shared technician login, identify the technician for that
   browser session and visit. The server stores a session-specific identity
   assertion; it never overwrites a shared account's global profile.
3. Capture the technician arrival signature. The server records arrival time and
   the identity snapshot.
4. Record diagnosis, work performed, replacement-part status/details, and
   categorized evidence. **Fault photo** (`צילום תקלה`) and **module photo**
   (`צילום מודול`) remain distinct from the product-label photo used for OCR.
   Mobile camera capture and a normal desktop file picker are separate controls.
5. Capture the technician departure signature. Departure cannot precede arrival
   and both submissions are idempotent.
6. Review and finalize the report. Required evidence and replacement-part details
   are validated on the server. A finalized signed revision is immutable;
   corrections create an audited successor revision and require current evidence
   and signatures where applicable.

Repeat visits create new visit records, preserving prior attendance, signatures,
and report history.

## Workspace white-label settings

Tenant owners and administrators configure the business name, logo, business
contact details, one approved accent token, and report header/footer in
**Settings**. For tenant members, the business name is used in the application
shell and browser-page title, and the accent is applied through the existing
design tokens in both themes. Platform super administrators retain the platform
rail identity while operating across tenants. Tenant logos and settings are
always loaded through the active tenant context.

Finalized reports copy the current branding into an immutable snapshot. A later
name, logo, or color change affects new views and future reports without
silently restyling a signed historical document.

## Case dossier and exports

The dossier joins records only by trusted tenant-scoped customer, case,
conversation, and call identifiers. It contains customer/store information,
classification, scheduling and status history, technician identity and
attendance, report revisions, evidence, retained WhatsApp messages, linked
calls, original transcript/recording availability, grounded summaries, and
audit history. Ambiguous links require an authorized operator; phone-number-only
matching is not used.

The case workspace derives a bounded **pre-visit briefing** from those trusted
links. It shows the customer and site, fault and product identifiers, approved
next appointment, current visit state, the latest grounded WhatsApp and voice
summaries, and at most five recent service visits matched by serial number,
model, or product type. It never copies an unfiltered transcript into the
briefing. Users without `voice:read` receive neither linked call records nor the
voice-derived briefing summary; ordinary field-service access does not imply
voice access.

Final report views use a branding snapshot containing the tenant business name,
logo, approved accent, business contact details, locale, timezone, and report
header/footer. Browser print provides the Hebrew-safe branded PDF path without
rewriting a historical report after branding changes. A finalized report also
exports as a real XLSX workbook whose text cells cannot become spreadsheet
formulas. The administrative archive provides CSV and JSON indexes, per-case
JSON dossiers, bounded per-case ZIP packages with available private evidence,
and individual authorized evidence downloads. ZIP paths reject traversal and
duplicate entries, and archives are capped at 200 evidence files and 250 MB.
The tenant archive index supports at most 25,000 matching cases and refuses the
request when a larger result would be incomplete; narrow the operational scope
or use a separately reviewed export process rather than treating a truncated
archive as complete.

## Safe validation

Do not use a real customer, send a provider message, place a call, or modify a
live calendar for module verification. With a disposable PostgreSQL database,
run:

```powershell
pnpm --filter @or-on/crm test
pnpm --filter @or-on/messaging-worker test
pnpm --filter @or-on/web test
uv run pytest db/tests/postgres/test_field_service.py
uv run python scripts/db_verify.py offline
pnpm typecheck
pnpm lint
pnpm build
```

PostgreSQL integration tests require the repository's isolated test database
configuration. Provider tests use explicit synthetic fixtures; they prove the
contract and safety gates, not live Meta, calendar, OCR, object-store, or audio
behavior.
