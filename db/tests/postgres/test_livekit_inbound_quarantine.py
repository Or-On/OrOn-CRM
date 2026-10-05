"""Signed SIP guard decisions must survive real PostgreSQL claim settlement."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID, uuid4

import asyncpg
import pytest
from livekit.protocol.models import ParticipantInfo
from oron_dispatcher.dispatcher import Dispatcher
from oron_dispatcher.tenancy_client import PhoneResolution
from oron_dispatcher.webhook_ledger import PostgresWebhookLedger
from oron_dispatcher.webhook_pump import DurableWebhookPump

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]
REASONS = ("missing_inbound_rule", "inbound_rule_mismatch", "inbound_transport_mismatch")


@pytest.mark.parametrize("reason", REASONS)
async def test_new_safe_guard_reasons_settle_with_exact_claim_fence(postgres_url, reason):
    async def role(connection):
        await connection.execute("SET ROLE platform_voice")

    pool = await asyncpg.create_pool(postgres_url, min_size=1, max_size=1, setup=role)
    account, event = "guard-settle-" + uuid4().hex, "EV_" + uuid4().hex
    ledger = PostgresWebhookLedger(postgres_url, provider_account_id=account, pool=pool)
    admin = await asyncpg.connect(postgres_url)
    try:
        async with pool.acquire() as connection:
            assert await connection.fetchval("SELECT current_user") == "platform_voice"
        await ledger.accept(
            provider_event_id=event,
            event_type="participant_joined",
            payload={"id": event, "event": "participant_joined"},
        )
        delivery = (await ledger.claim_pending(1))[0]
        for bad_outcome, bad_reason in (
            ("quarantined", "private or arbitrary text"),
            ("processed", reason),
        ):
            with pytest.raises(asyncpg.InvalidParameterValueError):
                await ledger.settle(delivery, bad_outcome, bad_reason)
        before = await admin.fetchrow(
            "SELECT status,voice_claim_token,last_error_safe "
            "FROM ops.inbound_events WHERE id=$1::uuid",
            delivery.event_id,
        )
        assert before["status"] == "processing"
        assert str(before["voice_claim_token"]) == delivery.token
        assert before["last_error_safe"] is None
        # A different worker/token must not settle even with an allowed reason.
        async with pool.acquire() as connection:
            for checked_account, worker, token in (
                ("foreign-account", ledger._worker, delivery.token),
                (account, "foreign-worker", delivery.token),
                (account, ledger._worker, uuid4()),
            ):
                assert not await connection.fetchval(
                    "SELECT ops.settle_livekit_claim($1,$2::uuid,$3,$4::uuid,'quarantined',$5)",
                    checked_account,
                    delivery.event_id,
                    worker,
                    token,
                    reason,
                )
        assert await ledger.settle(delivery, "quarantined", reason)
        assert not await ledger.settle(delivery, "processed", None)
        with pytest.raises(asyncpg.InvalidParameterValueError):
            await ledger.settle(delivery, "quarantined", "private or arbitrary text")
        row = await admin.fetchrow(
            "SELECT status,last_error_safe,attempts,tenant_id,voice_claim_token,"
            "voice_lease_expires_at,processed_at FROM ops.inbound_events WHERE id=$1::uuid",
            delivery.event_id,
        )
        assert row["status"] == "quarantined" and row["last_error_safe"] == reason
        assert row["attempts"] == 1 and row["processed_at"] is not None
        assert row["tenant_id"] is row["voice_claim_token"] is row["voice_lease_expires_at"] is None
        assert await ledger.claim_pending(1) == []
    finally:
        await pool.close()
        await admin.execute(
            "DELETE FROM ops.inbound_events WHERE provider='livekit' AND provider_account_id=$1",
            account,
        )
        await admin.close()


@pytest.mark.parametrize("reason", REASONS)
async def test_real_pump_preserves_guard_quarantine_after_room_deletion_and_replay(
    postgres_url, reason
):
    async def role(connection):
        await connection.execute("SET ROLE platform_voice")

    pool = await asyncpg.create_pool(postgres_url, min_size=1, max_size=2, setup=role)
    account, event_id = "guard-pump-" + uuid4().hex, "EV_" + uuid4().hex
    room, tenant = "fictional-guard-" + uuid4().hex, uuid4()
    ledger = PostgresWebhookLedger(postgres_url, provider_account_id=account, pool=pool)
    admin = await asyncpg.connect(postgres_url)
    alive, handler_calls = True, 0

    async def hangup(_room):
        nonlocal alive
        alive = False

    sessions = SimpleNamespace(
        begin=AsyncMock(return_value=True), finalize=AsyncMock(), ready=AsyncMock()
    )
    launch = AsyncMock()
    dispatcher = Dispatcher(
        settings=SimpleNamespace(
            room_prefix="call-",
            bot_identity="fixture",
            enable_twilio_inbound=True,
            twilio_inbound_routes=(
                SimpleNamespace(did="+14155550101", tenant_id=tenant, trunk_id="ST_fixture"),
            ),
        ),
        sessions=sessions,
        sip_client=SimpleNamespace(configured=False),
        launch_bot=launch,
        resolve_phone=AsyncMock(
            return_value=PhoneResolution(
                tenant_id=tenant,
                flow_id=uuid4(),
                dispatch_rule_id="simulator-fixture"
                if reason == "inbound_rule_mismatch"
                else "SDR_fixture",
            )
        ),
        hangup_room=hangup,
        mint_token=Mock(),
    )
    event = SimpleNamespace(
        room=SimpleNamespace(name=room),
        participant=SimpleNamespace(
            kind=ParticipantInfo.SIP,
            attributes={
                "sip.trunkPhoneNumber": "+14155550101",
                "sip.phoneNumber": "+14155550102",
                "sip.ruleID": "" if reason == "missing_inbound_rule" else "SDR_fixture",
                "sip.trunkID": "ST_foreign"
                if reason == "inbound_transport_mismatch"
                else "ST_fixture",
            },
        ),
    )

    async def handle(_delivery):
        nonlocal handler_calls
        handler_calls += 1
        if alive:  # same current-participant gate as the production composition
            await dispatcher.handle_participant_joined(event)

    pump = DurableWebhookPump(ledger, handle)
    body = {"id": event_id, "event": "participant_joined", "room": {"name": room}}
    try:
        claim = await ledger.accept(
            provider_event_id=event_id, event_type="participant_joined", payload=body
        )
        delivery = (await ledger.claim_pending(1))[0]
        await pump._process(delivery)
        sessions.begin.assert_not_awaited()
        launch.assert_not_awaited()
        assert alive is (reason == "missing_inbound_rule")
        row = await admin.fetchrow(
            "SELECT status,last_error_safe,attempts FROM ops.inbound_events WHERE id=$1",
            UUID(claim.event_id),
        )
        assert dict(row) == {"status": "quarantined", "last_error_safe": reason, "attempts": 1}
        replay = await ledger.accept(
            provider_event_id=event_id, event_type="participant_joined", payload=body
        )
        assert not replay.should_process and replay.event_id == claim.event_id
        assert await ledger.claim_pending(1) == []
        assert handler_calls == 1
        # Later events in the same room are no longer blocked behind a failed lease.
        later_id = "EV_" + uuid4().hex
        await ledger.accept(
            provider_event_id=later_id,
            event_type="room_finished",
            payload={"id": later_id, "event": "room_finished", "room": {"name": room}},
        )
        later = (await ledger.claim_pending(1))[0]
        assert later.event_id != claim.event_id
        assert await ledger.settle(later, "processed", None)
        assert (
            await admin.fetchval(
                "SELECT status FROM ops.inbound_events WHERE id=$1", UUID(claim.event_id)
            )
        ) == "quarantined"
    finally:
        await pump.close()
        await pool.close()
        await admin.execute(
            "DELETE FROM ops.inbound_events WHERE provider='livekit' AND provider_account_id=$1",
            account,
        )
        await admin.close()
