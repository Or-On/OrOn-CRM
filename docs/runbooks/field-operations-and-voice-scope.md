# Field operations, voice scope and inbound call audit

This runbook covers:

- the service-scoped agent policy;
- phone inquiries with WhatsApp follow-up;
- emergency ("red") calls;
- the technician timeline, preparation and evidence;
- the inbound call reconciliation tool.

Tenant-facing semantics are in
[Tenant operations configuration](../architecture/tenant-operations-configuration.md#field-operations-workflow-settings).

## Migrations

| Revision       | Purpose                                                                                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `5e7a9c2d4f18` | Optional workflow sections, `transferTo` redaction, emergency ticket columns, visit timeline columns and correction log, preparation acknowledgements, before/after/tenant-document attachments, database evidence gates.                                                                      |
| `6f8b0d3e5a29` | Repairs voice admission (`pg_catalog.coalesce` in `resolve_voice_caller_contact` and `open_ticket_from_voice_session`). Also adds the `quarantined` webhook status, early voice inquiries, emergency escalation, the WhatsApp follow-up state machine, reply correlation and the triage queue. |

Both migrations are additive. The only rows they write belong to new columns and tables. Tenants without the new workflow sections behave as before.

Apply them with the normal migration job before deploying code. The deploy order is:

1. Migrations (`alembic upgrade head`).
2. The dispatcher and voice agent, which own admission quarantine, the scope gate, emergency transfer and follow-up consent.
3. The messaging worker, which renders and sends follow-ups, correlates replies and applies the WhatsApp scope policy.
4. The web BFF/UI.

Older code keeps working against the new schema. New code needs the new schema.

### Rollback

- Roll back code in the reverse order.
- `alembic downgrade 5e7a9c2d4f18` removes the follow-up, triage and emergency-escalation objects. It keeps the voice-admission repair on purpose: the pre-repair functions fail on every call.
- Downgrading past `5e7a9c2d4f18` drops the timeline, preparation and evidence objects. Export `service.visit_time_corrections` and `service.visit_preparations` first if they must be retained.
- Before downgrading, remove the new workflow sections from active tenant packages by approving a release without them. The downgraded validator rejects the new keys.

## Voice admission defect and the historical audit

Before `6f8b0d3e5a29`, inbound admission could fail inside `resolve_voice_caller_contact` or `open_ticket_from_voice_session`. When that happened:

- The call reached the dispatcher.
- The signed LiveKit webhook was recorded in `ops.inbound_events` with status `failed` and `dispatcher_handler_failed`.
- No session, intake or ticket was created.

Such calls are recoverable only from the webhook ledger and the provider's call records.

Run the read-only reconciliation. Use a role that can read all tenants; nothing is written:

```bash
AUDIT_DATABASE_URL=postgresql://... AUDIT_HASH_KEY=<random secret> \
  uv run python scripts/audit_voice_intake.py \
  --since 2026-08-25 --until 2026-09-24 --timezone Asia/Jerusalem \
  --provider-cdr provider_calls.csv --output voice-intake-audit.json
```

The report contains:

- Counts per disposition. Every SIP `participant_joined` event gets exactly one.
- Webhook status totals.
- Follow-up outcomes.
- Unresolved reply links.
- Coverage gaps.
- `recovery_dry_run`: calls that reached the platform but left no inquiry, deduplicated per caller within 30 minutes, with provenance.

Callers appear only as keyed hashes plus the last two digits. Keep `AUDIT_HASH_KEY` stable between runs so rows can be compared.

The provider CDR (`start_time,from,to` CSV) is the only source for calls the SIP provider received but never forwarded. Without it, the report states that gap. Do not claim that no inquiries were lost unless the CDR reconciliation supports it.

Recovery is manual. A person reviews each dry-run row and decides whether to call back or open an inquiry. The tool never contacts callers or creates records.

## Monitoring

| Signal                                                                    | Meaning / action                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops.inbound_events` rows with `status='quarantined'`                     | A call reached a number that no tenant owns (`missing_did`, `malformed_did` or `unregistered_did`). Check the phone number registry. The event is kept rather than dropped.                                                                                       |
| `ops.inbound_events` rows with `status='failed'` for `participant_joined` | Admission failed. The provider retries within its policy. Investigate at once and run the audit.                                                                                                                                                                  |
| `public.session_events` with type `voice.policy.v1`                       | The scope router answered off-scope turns, or the output gate suppressed an unsafe generation. The event holds the policy version, category and action only, never the text. A spike means probing or a regression.                                               |
| `audit.records` with `agent.scope.routed` / `agent.scope.output_rejected` | The same signal for WhatsApp.                                                                                                                                                                                                                                     |
| `service.intake_drafts.followup_status`                                   | `blocked_consent`, `blocked_window`, `no_channel`, `no_recipient`, `recipient_conflict` and `failed` all need staff action and show on the inquiry. `no_channel` includes a tenant whose WhatsApp AI sender (`whatsapp_ai_enabled_by_user_id`) is not configured. |
| `service.followup_triage` rows with no resolution                         | An inbound WhatsApp message could belong to more than one inquiry. A person links it from the inquiry panel. Messages are never attached by recency.                                                                                                              |
| `support.tickets` rows with `emergency_at` and an escalation stage        | Red calls. Check the escalation outcome in the ticket events: `transfer_initiated`, `transfer_failed`, `no_transfer_target`, `caller_disconnected` or a fallback.                                                                                                 |

## Enabling a tenant (ProTouch example)

1. Confirm that Field Service, Tickets, WhatsApp and Voice are active.
2. Enable WhatsApp AI for the tenant. The follow-up is sent as a system message by that operator.
3. In **Business configuration → Field operations**, enter the sections from `infra/tenant-configurations/protouch.field-operations.json`, or the tenant's own values.
4. If calls should be transferred, set the emergency transfer number here. It is not stored in the repository.
5. Save a draft and submit it. A platform super administrator reviews and approves it.
6. For WhatsApp messages outside the 24-hour window, a Meta template must be approved first. Put its exact name, language and parameter order in `whatsappFollowUp`. Until then, only customers inside the 24-hour window receive the follow-up, and the others show `blocked_window`.
7. Verify with a synthetic call from an approved test number, never a real customer. Check that:
   - the inquiry appears during the call;
   - the WhatsApp summary arrives after the call;
   - a photo reply attaches to the same inquiry;
   - an identity question gets the approved identity reply.

To disable, approve a release without the sections. Records already created stay intact.

## Unverified until run against real providers

These behaviours are covered by database tests, simulator/worker tests and unit tests, but not yet against live services:

- LiveKit SIP REFER transfer on the production trunk.
- Meta template approval and delivery.
- Real-model adherence to the scope policy. The output gate is enforced in code regardless.
- The historical production audit.
