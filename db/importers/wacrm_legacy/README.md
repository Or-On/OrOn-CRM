# WACRM existing-data import foundation

The importer never connects to Supabase or customer databases. It consumes an
operator-produced, provider-neutral `wacrm-export-v1` JSON extract from a
PostgreSQL dump/export workflow and requires
explicit mappings for source account → canonical tenant and Supabase user ID →
canonical user.

Phase 2B implements and live-validates the first bounded slice: contacts,
WhatsApp channels, conversations, messages, pipelines, stages, and deals. It
uses deterministic target IDs, source and record checksums, explicit reference
validation, one PostgreSQL transaction per mapped tenant, and
`ops.import_runs/import_items` for retry/idempotency. Running the same fixture
twice produces no duplicate domain rows.

Campaigns/templates, automations/flows, AI metadata, object references, contact
identities, and an extraction utility for arbitrary historical dump layouts are
deferred extensions of this format. Supabase Auth sessions and plaintext secrets
must never be exported into this contract; media remains object-reference
reconciliation rather than database binary content. No online Supabase access,
second migration authority, or runtime dependency is introduced.
