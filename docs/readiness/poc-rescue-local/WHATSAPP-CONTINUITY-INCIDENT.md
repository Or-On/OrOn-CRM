# WhatsApp continuity incident — October 5, 2026

The deployed `61f01c8` worker received and admitted three consecutive customer
messages. All three model calls succeeded, but finalization of the second and
third failed with `ai_execution_principal_unavailable`. The conversation still
displayed AI ownership because the failed transaction rolled back. Removing the
conversation and receiving another message exposed a second failure: the opening
menu consumed the new receipt without offering a menu, then the paired AI job
cancelled as a duplicate.

## Corrections

- Ticket creation and tool authorization complete before the worker gives human
  ownership to an escalation. A server-owned receipt permits exactly the fixed
  handoff acknowledgement across that one ownership transition. Source claim,
  recipient, pending handoff, consent, principal, grants, published configuration,
  menu configuration and reopen boundary are rechecked before physical delivery
  and again when reading the provider credential. Ordinary replies cannot use
  this exception.
- Resuming AI or reopening a conversation starts one fresh menu when no current
  choice exists. Existing choices, stale buttons and provider delivery receipts
  remain fenced. Selecting the same approved AI and consenting actor is
  idempotent and no longer advances the ownership epoch.
- A model's `human_requested` classification must be supported by the current
  customer's request, or a short confirmation of the immediately preceding
  server-owned handoff offer. Missing knowledge and old transcript requests do
  not silently transfer the conversation. Safety and emergency escalation remain.
- Execution principal identity is pinned throughout a turn, including provider
  retries and failure recovery. Disabling or replacing a principal during model
  execution cannot turn that work into a legacy execution.
- Model-provider failures retain authority for the fixed failure acknowledgement,
  backed by the protected failure audit. The fallback uses the same delivery
  checks as a normal reply; revoking its principal or changing ownership prevents
  delivery.
- Tool denials retain only an allowlisted safe reason code. Arbitrary database
  error text remains redacted.

## Evidence and release gate

Actual messaging-worker regressions run through `platform_messaging` against an
owned PostgreSQL database and fake external providers. The prior schema/worker
failed both principal handoff and resumed-menu sequences. The repaired sequences
include repeated messages, explicit human requests, human-to-AI resume, repeated
AI assignment, archive/reopen, current and stale menu choices, principal and grant
revocation, modified acknowledgement text or recipient, changed source claim,
changed menu/configuration and credential revalidation.

`scripts/check_whatsapp_runtime.py` makes these suites a required PostgreSQL CI
step. It creates and removes its own loopback database, excludes real provider
credentials and rejects skipped or missing tests. Previously, these separately
configured suites could be skipped when their database variables were absent.

Local logs are under `.artifacts/poc-rescue-local/`: `principal-handoff-before`,
`principal-handoff-expanded`, `menu-resume-before`, `menu-resume-fix`,
`incident-crm`, `incident-db`, and `incident-catalog`. The full database sweep
found a new foreign key missing explicit delete semantics; that migration was
corrected and the catalog/role tests rerun. CI and exact deployed image verification
must also pass for the final commit.

Final local verification passed 750 worker tests (one existing optional spool
test skipped), 772 CRM tests, and all 74 tests in the seven mandatory runtime
suites with zero skips. Workspace lint, types, formatting and build passed.

Live inspection found no enabled remediation flags for Or-On. This release does
not enable optional transcription or remediation paths. The corrected model
failure acknowledgement is tested with `no_silence` enabled; it is not claimed
as active in that tenant. A separate isolated audit found that the currently
disabled transcription-failure fallback still lacks principal delivery authority;
the legacy test only counted persisted messages. Do not activate that path until
its actual delivery guard is implemented and covered.

These tests do not establish delivery of a new real customer message. Historical
cancelled jobs are not broadly replayed. A scoped recovery of the latest genuine
inbound, if authorized, must retain historical receipts, verify current ownership
and absence of newer activity, and use the canonical worker path.
