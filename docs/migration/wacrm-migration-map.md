# WACRM migration map

Locked source: `../wacrm` at
`98b5bd26e8feacacfd4b74ff58411acb8154d212`. All 39 SQL migrations were read
from source. They remain schema-history evidence, not a second executable
migration lineage.

Disposition vocabulary: `PORTED`, `SUPERSEDED_BY_CANONICAL_MODEL`,
`MOVED_TO_APPLICATION_SERVICE`, `DEFERRED_WITH_REASON`, and
`NOT_REQUIRED_WITH_REASON`.

| # / source | Capability and affected objects | Functions/triggers/index/RLS and Supabase dependency | Target disposition |
| --- | --- | --- | --- |
| 001 `001_initial_schema.sql` | Profiles; contacts/tags/custom values/notes; conversations/messages; WhatsApp config/templates; pipelines/stages/deals; broadcasts/recipients | Signup trigger on `auth.users`, `auth.uid()` RLS, Realtime publication, indexes | **PORTED** as coherent canonical CRM/messaging migrations; auth/realtime portions translated. |
| 002 `002_deal_enhancements.sql` | Deal status, assignment and close state | Deal indexes/RLS inherited | **PORTED** to `crm.deals`. |
| 003 `003_broadcast_tracking.sql` | Provider message IDs and delivery timestamps | Recipient aggregate trigger/function and lookup indexes | **PORTED** with canonical provider IDs/status events and database-owned aggregate semantics. |
| 004 `004_incremental_broadcast_aggregates.sql` | Historical aggregate-trigger optimization | Replaces full recount trigger | **NOT_REQUIRED_WITH_REASON**: final canonical aggregate design is emitted once; no intermediate patch state. |
| 005 `005_broadcast_aggregate_integrity.sql` | Correct forward status/count behavior | Trigger repair/backfill | **PORTED** as final constraints/derived counts behavior. |
| 006 `006_automations.sql` | Automations, steps, logs, pending execution | Tenant RLS via `auth.uid()`, scheduling indexes | **PORTED** to canonical version/run/job model; runtime adapter deferred. |
| 007 `007_atomic_automation_counter.sql` | Race-free execution counter | Atomic RPC | **PORTED** as database-owned atomic update where counters remain stored. |
| 008 `008_profile_avatars.sql` | Avatar URL and bucket | Supabase Storage bucket/policies | **SUPERSEDED_BY_CANONICAL_MODEL**: object metadata + mounted storage/GCS; no Storage authority. |
| 009 `009_replies_reactions.sql` | Reply links and per-actor reactions | Conversation/message indexes, Realtime publication | **PORTED**; delivery uses durable outbox/application streams. |
| 010 `010_flows.sql` | Flows, nodes, runs, events, fallbacks | One-active-run partial unique index, RLS, Realtime | **PORTED** to versioned flow definitions/immutable versions/runs/step runs. |
| 011 `011_beta_access.sql` | Profile beta flag | `auth.uid()` policy context | **SUPERSEDED_BY_CANONICAL_MODEL**: tenant membership/feature policy is canonical, not identity profile state. |
| 012 `012_atomic_flow_counter.sql` | Race-free flow count | Atomic RPC | **PORTED** where materialized counters are retained. |
| 013 `013_whatsapp_phone_number_unique.sql` | One account per Meta phone number | Unique index | **PORTED** to scoped messaging channel/provider account uniqueness. |
| 014 `014_template_meta_fields.sql` | Meta template ID/category/components/status | Provider indexes | **PORTED** to `messaging.message_templates`; flexible components remain JSONB. |
| 015 `015_registration_control.sql` | Registration allowlist/flags | `auth.users` signup trigger and auth metadata | **SUPERSEDED_BY_CANONICAL_MODEL**: final auth selection deferred; invitations/memberships are provider-neutral. |
| 016 `016_flow_media_storage.sql` | Flow media bucket/policies | Supabase Storage | **SUPERSEDED_BY_CANONICAL_MODEL**: `objects.object_metadata` references mounted storage/GCS. |
| 017 `017_accounts_and_teams.sql` | Accounts, members, invitations, roles; account columns/backfills | `is_account_member`, extensive `auth.uid()` RLS, auth signup trigger | **SUPERSEDED_BY_CANONICAL_MODEL**: account→tenant, profile→user, member→membership, invite→tenant invitation. Domain columns are ported separately. |
| 018 `018_account_member_rpcs.sql` | Member role/remove and ownership transfer | `SECURITY DEFINER` membership RPCs using `auth.uid()` | **PORTED** as narrow canonical membership operations using `app.current_user`, explicit search path/grants. |
| 019 `019_invitation_rpcs.sql` | Peek/redeem invitation atomically with data-loss guards | `SECURITY DEFINER`, `auth.uid()`, token hashes | **PORTED** to provider-neutral invitation functions/service transaction. |
| 020 `020_account_indexes_and_storage.sql` | Account-scoped query indexes/storage paths | Storage object policies and account helper | **PORTED** indexes; storage policies **SUPERSEDED** within the same canonical object design. |
| 021 `021_account_currency.sql` | Tenant default currency | Check/default | **PORTED** to tenant settings and deal currency constraints. |
| 022 `022_contact_phone_normalization.sql` | Normalized phone dedupe | Normalization/backfill and unique index | **PORTED** to E.164 channel identity uniqueness; Or-on ciphertext/blind indexes preserved. |
| 023 `023_chat_media_storage.sql` | Durable inbound/outbound chat media | Supabase Storage bucket/policies | **SUPERSEDED_BY_CANONICAL_MODEL**: object metadata + external object bytes. |
| 024 `024_presence.sql` | Agent presence and activity touching | Realtime publication and touch RPC | **MOVED_TO_APPLICATION_SERVICE**: durable availability metadata may persist; ephemeral presence delivery is application/WebSocket-owned. |
| 025 `025_tag_filter_rpc.sql` | Set-based contact tag filter | Query RPC | **MOVED_TO_APPLICATION_SERVICE**: parameterized repository query; no opaque public RPC contract. |
| 026 `026_api_keys.sql` | Scoped API keys and last-used/revocation | Hash uniqueness, account RLS | **PORTED** to canonical credential/API-access metadata; plaintext keys never stored. |
| 027 `027_notifications.sql` | User notifications/read state | Realtime publication, user/account RLS | **PORTED**; durable rows + application delivery replace Realtime. |
| 028 `028_webhook_endpoints.sql` | Signed outbound webhook endpoints/failure state | Atomic failure RPC, endpoint indexes/RLS | **PORTED**; credential references + durable jobs replace in-process-only delivery. |
| 029 `029_ai_auto_reply.sql` | AI config, conversation flags, daily slots | Slot-claim `SECURITY DEFINER` RPC and RLS | **PORTED** to canonical agent/provider config metadata and bounded DB-owned quota claim. |
| 030 `030_knowledge_base.sql` | Knowledge sources/documents/chunks/search | FTS GIN, optional vector/RPC, account RLS | **PORTED** with PostgreSQL FTS required; pgvector remains optional and not in base migration. |
| 031 `031_ai_slot_grant.sql` | Service-role execute grant patch | Supabase `service_role` | **NOT_REQUIRED_WITH_REASON**: no Supabase role exists; explicit platform role grants ship with the canonical function. |
| 032 `032_knowledge_search_security.sql` | Harden knowledge search execution mode | `SECURITY INVOKER`, fixed search path | **PORTED** as the default security posture. |
| 033 `033_ai_usage.sql` | AI usage/latency/token accounting | Account/time indexes/RLS | **PORTED** to canonical agent usage records. |
| 034 `034_prevent_privilege_escalation.sql` | Protect account/role fields | Guard trigger using membership/owner checks | **PORTED** to canonical membership operations and restrictive grants/policies. |
| 035 `035_interactive_messages_and_quick_replies.sql` | Interactive message payloads and quick replies | Type constraints/indexes/RLS | **PORTED** to messaging content metadata and quick replies. |
| 036 `036_conversation_dedupe.sql` | One account/contact conversation | Data consolidation + unique index | **PORTED** as canonical uniqueness and later importer dedupe plan. |
| 037 `037_message_idempotency_and_atomic_writes.sql` | Inbound message dedupe, atomic unread bump, atomic broadcast creation | Unique provider message index and atomic RPCs | **PORTED** to provider-scoped uniqueness, inbox idempotency, and transaction-owned writes. |
| 038 `038_broadcast_resume.sql` | Frozen recipient params, delivery lease/resume | Resume/claim indexes | **PORTED** to campaign recipients and PostgreSQL durable jobs/leases. |
| 039 `039_inbound_media_mirror.sql` | Per-account inbound media mirror toggle/MIME metadata | Config/message fields | **PORTED** to channel config + object metadata references. |

There are zero unexplained migrations. Summary: 29 `PORTED`, 6
`SUPERSEDED_BY_CANONICAL_MODEL`, 2 `MOVED_TO_APPLICATION_SERVICE`, 0
`DEFERRED_WITH_REASON`, and 2 `NOT_REQUIRED_WITH_REASON`; migration 020 contains
both a ported index part and a superseded storage-policy part and is counted as
`PORTED` in the summary.

## Supabase translation

| Source assumption | Canonical translation |
| --- | --- |
| `auth.uid()` / session claims | `app.current_user` plus `app.current_tenant` and canonical membership. |
| `auth.users` / signup triggers | Canonical users and provider-neutral identity bindings; final authenticator deferred to Phase 3. |
| Realtime publication | Durable PostgreSQL state/outbox plus application WebSocket/SSE; optional `LISTEN/NOTIFY` wake-up only. |
| Storage buckets/policies | PostgreSQL object metadata; mounted local object directory and future GCS bytes. |
| Supabase service role | Explicit least-privilege platform runtime roles. |

## RPC disposition

Database functions remain only when atomicity, locking, or membership security is
intrinsically database-owned: counters, invitation/member transitions, quota
claiming, webhook failure accounting, unread bump, broadcast creation, and job
claiming. Tag filtering, presence orchestration, external sends, and workflow
orchestration move to typed application repositories/services. Every retained
security-sensitive function revokes public execution and uses explicit
`search_path`.

## Existing-data import direction

The Phase 2B provider-neutral importer consumes an operator-produced
`wacrm-export-v1` JSON extract from a PostgreSQL dump/export workflow, never a
live Supabase dependency. It requires account→tenant and Supabase user
ID→canonical user mappings before planning. The validated initial slice writes
contacts, WhatsApp channels, conversations/messages, pipelines/stages, and deals
through deterministic IDs, checksums, one tenant transaction, and
`ops.import_runs/import_items`; a second execution produces no duplicates.

Campaigns/templates, automations/flows, AI metadata, object references, contact
identities, and extraction support for arbitrary historical dump layouts remain
incremental importer work. Supabase sessions are never imported, and secrets
require a separate approved credential migration path.
