"""Signed Cloud extensions retain SDK compatibility through durable replay."""

import asyncio
import base64
import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import asyncpg
import httpx
import pytest
from google.protobuf.json_format import ParseDict
from livekit import api
from livekit.protocol.webhook import WebhookEvent
from oron_dispatcher.dispatcher import Dispatcher
from oron_dispatcher.tenancy_client import PhoneResolution
from oron_dispatcher.webhook import create_app
from oron_dispatcher.webhook_ledger import PostgresWebhookLedger

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]
KEY = "fictional-webhook-key"
SECRET = "fictional-webhook-secret-fictional-webhook-secret"


def _signed(payload):
    body = json.dumps(payload, separators=(",", ":"))
    digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
    return body, api.AccessToken(KEY, SECRET).with_sha256(digest).to_jwt()


async def _post(client, payload):
    body, token = _signed(payload)
    return await client.post("/livekit/webhook", content=body, headers={"Authorization": token})


async def _settled(admin, account, event):
    async with asyncio.timeout(5):
        while True:
            row = await admin.fetchrow(
                "SELECT status,attempts,last_error_safe,payload,voice_claim_token "
                "FROM ops.inbound_events WHERE provider_account_id=$1 AND provider_event_id=$2",
                account,
                event,
            )
            if row and row["status"] in {"processed", "failed", "quarantined"}:
                return row
            await asyncio.sleep(0.02)


@pytest.mark.parametrize("kind", ["room_finished", "participant_joined", "foreign_trunk"])
async def test_signed_unknown_fields_survive_actual_pump_without_weakening_known_binding(
    postgres_url, kind
):
    async def role(connection):
        await connection.execute("SET ROLE platform_voice")

    pool = await asyncpg.create_pool(postgres_url, min_size=1, max_size=2, setup=role)
    admin = await asyncpg.connect(postgres_url)
    account, event, room = ("fictional-" + uuid4().hex for _ in range(3))
    tenant = uuid4()
    ledger = PostgresWebhookLedger(postgres_url, provider_account_id=account, pool=pool)
    sessions = SimpleNamespace(
        begin=AsyncMock(return_value=True),
        finalize=AsyncMock(return_value=True),
        ready=AsyncMock(return_value=True),
    )
    handle = SimpleNamespace(cancel=AsyncMock())
    launch, hangup = AsyncMock(return_value=handle), AsyncMock()
    dispatcher = Dispatcher(
        settings=SimpleNamespace(
            room_prefix="call-",
            bot_identity="fictional",
            enable_twilio_inbound=True,
            twilio_inbound_routes=(
                SimpleNamespace(did="+14155550101", tenant_id=tenant, trunk_id="ST_fictional"),
            ),
        ),
        sessions=sessions,
        sip_client=SimpleNamespace(configured=False),
        launch_bot=launch,
        resolve_phone=AsyncMock(
            return_value=PhoneResolution(
                tenant_id=tenant,
                flow_id=uuid4(),
                dispatch_rule_id="SDR_fictional",
            )
        ),
        hangup_room=hangup,
        mint_token=Mock(),
    )
    joined = {
        "event": "participant_joined",
        "id": event,
        "room": {"name": room},
        "participant": {
            "kind": "SIP",
            "attributes": {
                "sip.ruleID": "SDR_fictional",
                "sip.trunkID": "ST_fictional",
                "sip.trunkPhoneNumber": "+14155550101",
                "sip.phoneNumber": "+14155550102",
            },
        },
    }
    if kind == "room_finished":
        await dispatcher.handle_participant_joined(ParseDict(joined, WebhookEvent()))
        payload = {"id": event, "event": kind, "room": {"name": room}}
    else:
        payload = joined
        if kind == "foreign_trunk":
            payload["participant"]["attributes"]["sip.trunkID"] = "ST_foreign"
    # Fictional additive fields model Cloud schema drift without retaining a live payload.
    payload["futureEventField"] = {"revision": 2}
    payload["roomEndReason"] = "fictional_extension"
    payload["room"]["futureRoomField"] = True
    receiver = api.WebhookReceiver(api.TokenVerifier(KEY, SECRET))
    body, token = _signed(payload)
    assert receiver.receive(body, token).event == payload["event"]
    app = create_app(
        dispatcher=dispatcher,
        receiver=receiver,
        ledger=ledger,
        assertion_verifier=None,
        participant_is_current=AsyncMock(return_value=True),
    )
    try:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://fixture"
            ) as client,
        ):
            assert (await _post(client, payload)).status_code == 200
            row = await _settled(admin, account, event)
            expected = "quarantined" if kind == "foreign_trunk" else "processed"
            assert row["status"] == expected
            assert row["attempts"] == 1 and row["voice_claim_token"] is None
            assert json.loads(row["payload"]) == payload
            assert row["last_error_safe"] == (
                "inbound_transport_mismatch" if kind == "foreign_trunk" else None
            )
            duplicate = await _post(client, payload)
            assert duplicate.status_code == 200 and duplicate.json()["duplicate"]
            changed = {**payload, "futureEventField": {"revision": 3}}
            assert (await _post(client, changed)).status_code == 503
            assert (await _settled(admin, account, event))["attempts"] == 1
            if kind == "room_finished":
                assert dispatcher.active_calls() == []
                sessions.finalize.assert_awaited_once()
                handle.cancel.assert_awaited_once()
            elif kind == "foreign_trunk":
                launch.assert_not_awaited()
                sessions.begin.assert_not_awaited()
                hangup.assert_awaited_once_with(room)
            else:
                launch.assert_awaited_once()
                assert launch.await_args.args[1].tenant_id == tenant
                assert launch.await_args.args[1].sip_refer_supported is False
    finally:
        await pool.close()
        await admin.execute("DELETE FROM ops.inbound_events WHERE provider_account_id=$1", account)
        await admin.close()


@pytest.mark.parametrize(
    "invalid",
    [
        {"createdAt": {"invalid": True}},
        {"room": {"emptyTimeout": {"invalid": True}}},
    ],
)
async def test_known_malformed_fields_fail_signed_ingress_and_durable_replay(postgres_url, invalid):
    async def role(connection):
        await connection.execute("SET ROLE platform_voice")

    pool = await asyncpg.create_pool(postgres_url, min_size=1, max_size=2, setup=role)
    admin = await asyncpg.connect(postgres_url)
    account, event = "fictional-" + uuid4().hex, "EV_" + uuid4().hex
    ledger = PostgresWebhookLedger(postgres_url, provider_account_id=account, pool=pool)
    dispatcher = AsyncMock()
    payload = {"id": event, "event": "room_finished", "room": {"name": "fictional"}, **invalid}
    app = create_app(
        dispatcher=dispatcher,
        receiver=api.WebhookReceiver(api.TokenVerifier(KEY, SECRET)),
        ledger=ledger,
        assertion_verifier=None,
        participant_is_current=AsyncMock(return_value=True),
    )
    try:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://fixture"
            ) as client,
        ):
            assert (await _post(client, payload)).status_code == 401
            assert (
                await admin.fetchval(
                    "SELECT count(*) FROM ops.inbound_events WHERE provider_account_id=$1",
                    account,
                )
                == 0
            )
            # Directly inject only into this disposable fixture to exercise replay parsing.
            await ledger.accept(
                provider_event_id=event, event_type="room_finished", payload=payload
            )
            row = await _settled(admin, account, event)
            assert (
                row["status"] == "failed" and row["last_error_safe"] == "dispatcher_handler_failed"
            )
            dispatcher.handle_room_finished.assert_not_awaited()
    finally:
        await pool.close()
        await admin.execute("DELETE FROM ops.inbound_events WHERE provider_account_id=$1", account)
        await admin.close()
