# WACRM existing-data import contract

Phase 2A does not connect to Supabase or customer databases. A later offline
importer consumes an operator-provided PostgreSQL dump/export and requires
explicit mappings for source account → canonical tenant and Supabase user ID →
canonical user. It imports canonical contacts, identities, conversations,
messages, deals, campaigns, templates, automations, AI metadata, and object
references through one PostgreSQL transaction/ledger boundary per resumable
batch.

The importer must use source checksums and `ops.import_runs/import_items` for
idempotency, must never copy Supabase Auth sessions or plaintext secrets, and
must treat media as object-reference reconciliation rather than database binary
content. Online Supabase access is not required or implemented.

The adjacent protocol declares the Phase 2B planner/writer boundary without
adding a second migration authority or a runtime dependency.
