"""Content-free receipt-to-provider-acceptance snapshot, never delivery certification.

Requires a separately authorized monitoring connection. No application credential
fallback, writes, inferred human success, or client-controlled tenant scope.
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import UTC, datetime, timedelta

import asyncpg

QUERY = """
WITH raw AS (
 SELECT e.id,e.tenant_id,e.provider,e.provider_account_id,e.event_type,e.received_at,
   e.payload->>'providerMessageId' AS provider_message_id,
   row_number() OVER (PARTITION BY e.provider,e.provider_account_id,
     COALESCE(NULLIF(e.payload->>'providerMessageId',''),e.id::text)
     ORDER BY e.received_at,e.receipt_sequence,e.id)
   + CASE WHEN NULLIF(e.payload->>'providerMessageId','') IS NOT NULL AND EXISTS(
     SELECT 1 FROM ops.inbound_events earlier WHERE earlier.provider=e.provider
       AND earlier.provider_account_id=e.provider_account_id
       AND earlier.event_type LIKE 'whatsapp.message.%'
       AND earlier.event_type<>'whatsapp.message.status' AND earlier.received_at<$1
       AND earlier.payload->>'providerMessageId'=e.payload->>'providerMessageId'
   ) THEN 1 ELSE 0 END AS duplicate_order
 FROM ops.inbound_events e
 WHERE e.provider='meta' AND e.event_type LIKE 'whatsapp.message.%'
   AND e.event_type<>'whatsapp.message.status'
   AND e.received_at >= $1 AND e.received_at < $2
), receipts AS (
 SELECT r.*,c.tenant_id AS channel_tenant,
   CASE WHEN r.tenant_id IS NULL OR r.tenant_id=c.tenant_id THEN c.tenant_id END AS scoped_tenant
 FROM raw r LEFT JOIN LATERAL (
   SELECT CASE WHEN count(DISTINCT channel.tenant_id)=1
     THEN (array_agg(DISTINCT channel.tenant_id))[1] END AS tenant_id
   FROM messaging.channels channel WHERE channel.provider=r.provider
     AND channel.kind='whatsapp' AND channel.provider_account_id=r.provider_account_id
 ) c ON true
), observations AS (
 SELECT r.*,i.id AS inbound_id,i.content_type,
   accepted.accepted_at,accepted.sender_type,
   delivered.delivered_at,
   EXISTS(SELECT 1 FROM messaging.messages human
     WHERE human.tenant_id=r.scoped_tenant AND human.conversation_id=i.conversation_id
       AND human.direction='outbound' AND human.sender_type<>'agent'
       AND human.created_at>=r.received_at AND human.created_at<r.received_at+interval '1 hour'
       AND human.reply_to_message_id IS NULL
       AND NOT COALESCE(human.provider_payload->'aiGrounding' ? 'triggerMessageId',false))
     AS unlinked_human_candidate
 FROM receipts r
 LEFT JOIN messaging.messages i ON i.tenant_id=r.scoped_tenant
   AND i.provider=r.provider AND i.provider_message_id=r.provider_message_id
   AND i.direction='inbound'
 LEFT JOIN LATERAL (
   SELECT j.completed_at AS accepted_at,o.sender_type,o.id AS outbound_id
   FROM messaging.messages o
   JOIN messaging.outbound_requests request ON request.tenant_id=o.tenant_id
     AND request.message_id=o.id AND request.provider='meta'
   JOIN ops.jobs j ON j.tenant_id=request.tenant_id AND j.reference_id=request.id
     AND j.reference_type='outbound_request' AND j.job_type='whatsapp.outbound.send'
     AND j.status='succeeded' AND j.completed_at IS NOT NULL AND j.completed_at <= $3
   WHERE o.tenant_id=r.scoped_tenant AND o.conversation_id=i.conversation_id
     AND o.direction='outbound' AND o.provider='meta' AND o.provider_message_id IS NOT NULL
     AND (o.reply_to_message_id=i.id OR
       o.provider_payload->'aiGrounding'->>'triggerMessageId'=i.id::text)
     AND EXISTS(SELECT 1 FROM messaging.message_delivery_events event
       WHERE event.tenant_id=o.tenant_id AND event.message_id=o.id
         AND event.provider_event_id='meta_accepted_'||o.provider_message_id)
   ORDER BY j.completed_at,o.id LIMIT 1
 ) accepted ON true
 LEFT JOIN LATERAL (
   SELECT min(event.occurred_at) AS delivered_at
   FROM messaging.message_delivery_events event
   WHERE event.tenant_id=r.scoped_tenant AND event.message_id=accepted.outbound_id
     AND event.status IN ('delivered','read') AND event.occurred_at <= $3
     AND event.provider_event_id NOT LIKE 'meta_accepted_%'
 ) delivered ON true
), classified AS (
 SELECT *,received_at <= $3-interval '120 seconds' AS mature,
   extract(epoch FROM accepted_at-received_at)::float8 AS acceptance_seconds,
   extract(epoch FROM delivered_at-received_at)::float8 AS delivery_seconds
 FROM observations
), grouped AS (
 SELECT scoped_tenant,
   count(*) AS raw_receipts,
   count(*) FILTER(WHERE duplicate_order>1) AS duplicate_receipts,
   count(*) FILTER(WHERE duplicate_order=1) AS unique_receipts,
   count(*) FILTER(WHERE duplicate_order=1 AND NOT mature) AS pending_window,
   count(*) FILTER(WHERE duplicate_order=1 AND mature) AS denominator,
   count(*) FILTER(WHERE duplicate_order=1 AND mature AND inbound_id IS NULL) AS unmatched,
   count(*) FILTER(WHERE duplicate_order=1 AND mature AND event_type<>'whatsapp.message.text')
     AS nontext,
   count(*) FILTER(WHERE duplicate_order=1 AND mature AND acceptance_seconds BETWEEN 0 AND 120)
     AS accepted_within_120s,
   count(*) FILTER(WHERE duplicate_order=1 AND mature AND acceptance_seconds>120) AS accepted_late,
   count(*) FILTER(WHERE duplicate_order=1 AND mature AND accepted_at IS NULL)
     AS no_exact_acceptance,
   count(*) FILTER(WHERE duplicate_order=1 AND mature AND sender_type<>'agent') AS exact_human,
   count(*) FILTER(WHERE duplicate_order=1 AND mature AND accepted_at IS NULL
     AND unlinked_human_candidate) AS ambiguous_human_candidate,
   count(*) FILTER(WHERE duplicate_order=1 AND mature AND acceptance_seconds<0)
     AS invalid_acceptance_clock,
   count(*) FILTER(WHERE duplicate_order=1 AND mature AND acceptance_seconds>=0)
     AS acceptance_samples,
   CASE WHEN count(*) FILTER(WHERE duplicate_order=1 AND mature AND acceptance_seconds>=0)>=30
     THEN percentile_cont(0.5) WITHIN GROUP(ORDER BY acceptance_seconds)
       FILTER(WHERE duplicate_order=1 AND mature AND acceptance_seconds>=0) END
     AS acceptance_p50_seconds,
   CASE WHEN count(*) FILTER(WHERE duplicate_order=1 AND mature AND acceptance_seconds>=0)>=30
     THEN percentile_cont(0.95) WITHIN GROUP(ORDER BY acceptance_seconds)
       FILTER(WHERE duplicate_order=1 AND mature AND acceptance_seconds>=0) END
     AS acceptance_p95_seconds,
   count(*) FILTER(WHERE duplicate_order=1 AND mature AND delivery_seconds>=0)
     AS provider_reported_delivered,
   count(*) FILTER(WHERE duplicate_order=1 AND mature AND delivery_seconds<0)
     AS invalid_delivery_clock
 FROM classified GROUP BY scoped_tenant
)
SELECT CASE WHEN scoped_tenant IS NULL THEN 'unattributed'
  ELSE 'tenant-'||dense_rank() OVER(ORDER BY scoped_tenant)::text END AS tenant_alias,
 raw_receipts,duplicate_receipts,unique_receipts,pending_window,denominator,unmatched,nontext,
 accepted_within_120s,accepted_late,no_exact_acceptance,exact_human,ambiguous_human_candidate,
 invalid_acceptance_clock,acceptance_samples,acceptance_p50_seconds,acceptance_p95_seconds,
 provider_reported_delivered,invalid_delivery_clock
FROM grouped ORDER BY tenant_alias
"""


async def snapshot(
    connection: asyncpg.Connection, start: datetime, end: datetime, observed_at: datetime
) -> dict:
    if any(value.tzinfo is None for value in (start, end, observed_at)) or not (
        start < end <= observed_at and end - start <= timedelta(days=31)
    ):
        raise ValueError("bounded timezone-aware observation window required")
    async with connection.transaction(readonly=True, isolation="repeatable_read"):
        await connection.execute("SET LOCAL statement_timeout='5s'")
        heads = await connection.fetch("SELECT version_num FROM alembic_version")
        rows = await connection.fetch(QUERY, start, end, observed_at)
    return {
        "status": "observed",
        "scope": "rows_visible_to_authorized_monitor",
        "schemaHeads": [row["version_num"] for row in heads],
        "start": start.isoformat(),
        "end": end.isoformat(),
        "observedAt": observed_at.isoformat(),
        "acceptanceClock": "successful_send_job_completed_at_after_provider_acceptance",
        "deliveryClock": "provider_reported_status_occurred_at_not_local_receipt",
        "humanAttribution": "explicit_reply_or_trigger_only_candidates_remain_in_denominator",
        "tenantAliases": "report_local_not_stable_customer_identifiers",
        "minimumPercentileSamples": 30,
        "certifiedSLI": False,
        "duplicatePolicy": "provider_account_and_message_id_including_prior_window_receipts",
        "percentilePopulation": "exactly_linked_nonnegative_accepted_samples_only_not_all_receipts",
        "groups": [dict(row) for row in rows],
    }


async def main() -> int:
    dsn = os.environ.get("CHANNEL_SLI_MONITOR_DATABASE_URL")
    if not dsn:
        print('{"status":"blocked","reason":"monitoring_credential_missing"}')
        return 2
    connection = None
    try:
        connection = await asyncpg.connect(dsn, timeout=5)
        now = datetime.now(UTC)
        print(json.dumps(await snapshot(connection, now - timedelta(days=7), now, now)))
        return 0
    except Exception as error:
        print(json.dumps({"status": "unavailable", "error_type": type(error).__name__}))
        return 2
    finally:
        if connection is not None:
            await connection.close(timeout=5)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
