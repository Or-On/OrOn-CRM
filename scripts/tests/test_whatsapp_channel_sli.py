"""Synthetic actual PostgreSQL SLI proof; no providers or customer data."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import asyncpg
import pytest

spec = importlib.util.spec_from_file_location(
    "channel_sli", Path(__file__).resolve().parents[1] / "whatsapp_channel_sli.py"
)
assert spec and spec.loader
sli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sli)


@pytest.mark.parametrize("case", ["naive", "reversed", "future_end", "unbounded"])
def test_unsafe_observation_window_denied_before_database_access(case):
    now = datetime(2020, 1, 1, tzinfo=UTC)
    start, end, observed = now - timedelta(hours=1), now, now
    if case == "naive":
        start = start.replace(tzinfo=None)
    elif case == "reversed":
        start = end
    elif case == "future_end":
        observed = end - timedelta(seconds=1)
    else:
        start = now - timedelta(days=32)
    with pytest.raises(ValueError, match="bounded"):
        asyncio.run(sli.snapshot(None, start, end, observed))


def test_actual_postgres_receipt_denominator_and_distinct_acceptance_delivery():
    dsn = os.environ.get("CHANNEL_SLI_TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("explicit independent synthetic PostgreSQL fixture required")
    target = urlsplit(dsn)
    assert target.hostname == "127.0.0.1" and target.port == 55480
    assert target.path.startswith("/oron_fair_")

    async def exercise():
        connection = await asyncpg.connect(dsn)
        base = datetime(2020, 1, 1, tzinfo=UTC)
        observed = base + timedelta(minutes=10)
        tenant, user, channel, contact, conversation = [uuid4() for _ in range(5)]
        account = "synthetic-sli-" + str(channel)
        try:
            assert (
                await connection.fetchval(
                    "SELECT count(*) FROM ops.inbound_events WHERE provider='meta' "
                    "AND received_at >= $1 AND received_at < $2",
                    base,
                    observed,
                )
                == 0
            ), "fresh independent synthetic SLI fixture required"
            async with connection.transaction():
                await connection.execute(
                    "INSERT INTO public.tenants(id,name,slug,status) "
                    "VALUES($1,'Synthetic SLI',$2,'active')",
                    tenant,
                    str(tenant),
                )
                await connection.execute(
                    "INSERT INTO public.users(id,email,status) VALUES($1,$2,'active')",
                    user,
                    f"{user}@example.invalid",
                )
                await connection.execute(
                    "INSERT INTO public.memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
                    tenant,
                    user,
                )
                await connection.execute(
                    "INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,"
                    "status,configuration) VALUES($1,$2,'whatsapp','meta',$3,'active','{}')",
                    channel,
                    tenant,
                    account,
                )
                await connection.execute(
                    "INSERT INTO crm.contacts(id,tenant_id,name) VALUES($1,$2,'Synthetic SLI')",
                    contact,
                    tenant,
                )
                identity = await connection.fetchval(
                    "INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,"
                    "normalized_value,display_value,validation_status,is_primary) "
                    "VALUES($1,$2,'whatsapp','+15555550100','Synthetic','valid',true) RETURNING id",
                    tenant,
                    contact,
                )
                await connection.execute(
                    "INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,"
                    "status,ownership_mode) VALUES($1,$2,$3,$4,'open','human')",
                    conversation,
                    tenant,
                    channel,
                    contact,
                )

                async def receipt(kind="text", matched=True, at=base, provider_id=None):
                    inbound = uuid4()
                    provider_id = provider_id or str(inbound)
                    await connection.execute(
                        "INSERT INTO ops.inbound_events(tenant_id,provider,provider_account_id,"
                        "provider_event_id,event_type,payload,received_at) "
                        "VALUES($1,'meta',$2,$3,$4,$5::jsonb,$6)",
                        tenant,
                        account,
                        str(uuid4()),
                        "whatsapp.message." + kind,
                        json.dumps({"providerMessageId": provider_id}),
                        at,
                    )
                    if matched:
                        await connection.execute(
                            "INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,"
                            "sender_type,sender_contact_id,content_type,content_text,status,provider,"
                            "provider_message_id,created_at) "
                            "VALUES($1,$2,$3,'inbound','contact',$4,$5,'Synthetic','received','meta',"
                            "$6,$7)",
                            inbound,
                            tenant,
                            conversation,
                            contact,
                            kind,
                            provider_id,
                            at
                            - timedelta(days=2),  # Provider occurrence is deliberately misleading.
                        )
                    return inbound, provider_id

                async def reply(inbound, seconds, human=False, linked=True, delivery=None):
                    outbound, request = uuid4(), uuid4()
                    provider_id = str(outbound)
                    accepted = base + timedelta(seconds=seconds)
                    payload = {} if human else {"aiGrounding": {"triggerMessageId": str(inbound)}}
                    await connection.execute(
                        "INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,"
                        "sender_type,sender_user_id,content_type,content_text,status,provider,"
                        "provider_message_id,reply_to_message_id,provider_payload,created_at) "
                        "VALUES($1,$2,$3,'outbound',$4,$5,'text','Synthetic','sent','meta',$6,$7,"
                        "$8::jsonb,$9)",
                        outbound,
                        tenant,
                        conversation,
                        "user" if human else "agent",
                        user if human else None,
                        provider_id,
                        inbound if human and linked else None,
                        json.dumps(payload),
                        accepted,
                    )
                    await connection.execute(
                        "INSERT INTO messaging.outbound_requests(id,tenant_id,conversation_id,"
                        "message_id,channel_id,provider,message_kind,explicitly_confirmed,status,"
                        "idempotency_key,provider_message_id,recipient_identity_id,"
                        "requested_by_user_id) "
                        "VALUES($1,$2,$3,$4,$5,'meta','text',true,'sent',$6,$7,$8,$9)",
                        request,
                        tenant,
                        conversation,
                        outbound,
                        channel,
                        str(request),
                        provider_id,
                        identity,
                        user,
                    )
                    await connection.execute(
                        "INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,"
                        "payload,status,completed_at) "
                        "VALUES($1,'messaging','whatsapp.send','outbound_request',$2,'{}',"
                        "'succeeded',$3)",
                        tenant,
                        request,
                        accepted,
                    )
                    await connection.execute(
                        "INSERT INTO messaging.message_delivery_events(tenant_id,message_id,"
                        "provider_event_id,status,occurred_at) VALUES($1,$2,$3,'sent',$4)",
                        tenant,
                        outbound,
                        "meta_accepted_" + provider_id,
                        accepted,
                    )
                    if delivery is not None:
                        await connection.execute(
                            "INSERT INTO messaging.message_delivery_events(tenant_id,message_id,"
                            "provider_event_id,status,occurred_at) VALUES($1,$2,$3,'delivered',$4)",
                            tenant,
                            outbound,
                            str(uuid4()),
                            base + timedelta(seconds=delivery),
                        )

                first_provider_id = None
                for index in range(30):
                    inbound, provider_id = await receipt()
                    first_provider_id = first_provider_id or provider_id
                    await reply(
                        inbound,
                        10 + index,
                        delivery=60 if index == 0 else -1 if index == 1 else None,
                    )
                inbound, _ = await receipt()
                await reply(inbound, 180)
                inbound, _ = await receipt()
                await reply(inbound, 20, human=True)
                await receipt()  # Lost/no exactly linked acceptance.
                await receipt("image", matched=False)
                inbound, _ = await receipt()
                await reply(inbound, 20, human=True, linked=False)
                await receipt(matched=False, provider_id=first_provider_id)  # Duplicate receipt.
                outside_id = str(uuid4())
                await receipt(matched=False, at=base - timedelta(days=1), provider_id=outside_id)
                await receipt(matched=False, provider_id=outside_id)  # Prior-window duplicate.
                await receipt(matched=False, at=observed - timedelta(seconds=30))
                await connection.execute(
                    "INSERT INTO ops.inbound_events(provider,provider_account_id,provider_event_id,"
                    "event_type,payload,received_at) VALUES('meta','unknown-synthetic',$1,"
                    "'whatsapp.message.audio',$2::jsonb,$3)",
                    str(uuid4()),
                    json.dumps({"providerMessageId": first_provider_id}),
                    base,
                )
            result = await sli.snapshot(connection, base, observed, observed)
            group = next(row for row in result["groups"] if row["denominator"] == 35)
            assert group["raw_receipts"] == 38 and group["duplicate_receipts"] == 2
            assert group["unique_receipts"] == 36 and group["pending_window"] == 1
            assert group["accepted_within_120s"] == 31 and group["accepted_late"] == 1
            assert group["no_exact_acceptance"] == 3 and group["unmatched"] == 1
            assert group["nontext"] == 1 and group["exact_human"] == 1
            assert group["ambiguous_human_candidate"] == 2  # Both same-conversation candidates.
            assert group["provider_reported_delivered"] == 1
            assert group["invalid_delivery_clock"] == 1
            assert group["acceptance_samples"] == 32
            assert group["acceptance_p50_seconds"] == pytest.approx(24.5)
            assert group["acceptance_p95_seconds"] == pytest.approx(38.45)
            unknown = next(row for row in result["groups"] if row["tenant_alias"] == "unattributed")
            assert unknown["denominator"] == 1 and unknown["accepted_within_120s"] == 0
            assert unknown["acceptance_p50_seconds"] is None
            assert unknown["acceptance_p95_seconds"] is None
            assert not result["certifiedSLI"]
            serialized = json.dumps(result)
            assert str(tenant) not in serialized and account not in serialized
        finally:
            await connection.close()

    asyncio.run(exercise())
