from __future__ import annotations

import asyncio
from uuid import uuid4

import asyncpg
import pytest
from oron_dispatcher.webhook_ledger import PostgresWebhookLedger

pytestmark = [pytest.mark.postgres, pytest.mark.integration]


async def voice_pool(url):
    async def initialize(c):
        await c.execute("SET ROLE platform_voice")

    return await asyncpg.create_pool(url, min_size=1, max_size=3, init=initialize)


async def test_concurrent_room_claim_order_and_stale_fences(postgres_url):
    account = "fixture-" + uuid4().hex
    pool = await voice_pool(postgres_url)
    one = PostgresWebhookLedger(postgres_url, provider_account_id=account, pool=pool)
    two = PostgresWebhookLedger(postgres_url, provider_account_id=account, pool=pool)
    try:
        for kind in ("participant_joined", "room_finished"):
            eid = uuid4().hex
            await one.accept(
                provider_event_id=eid,
                event_type=kind,
                payload={"id": eid, "event": kind, "room": {"name": "room"}},
            )
        claims = await asyncio.gather(one.claim_pending(8), two.claim_pending(8))
        assert sum(map(len, claims)) == 1
        owner, other = (one, two) if claims[0] else (two, one)
        old = next(rows[0] for rows in claims if rows)
        assert old.payload["event"] == "participant_joined"
        assert not await other.renew(old)
        admin = await asyncpg.connect(postgres_url)
        try:
            await admin.execute(
                "UPDATE ops.inbound_events SET voice_lease_expires_at=clock_timestamp()"
                "-interval '1 second' WHERE id=$1::uuid",
                old.event_id,
            )
        finally:
            await admin.close()
        assert not await owner.renew(old)
        fresh = (await other.claim_pending(8))[0]
        assert fresh.token != old.token
        assert not await owner.settle(old, "processed", None)
        assert await other.settle(fresh, "processed", None)
        last = (await owner.claim_pending(8))[0]
        assert last.payload["event"] == "room_finished"
        assert await owner.settle(last, "processed", None)
    finally:
        await pool.close()


async def test_envelope_collision_direct_access_and_other_role_denied(postgres_url):
    account = "fixture-" + uuid4().hex
    pool = await voice_pool(postgres_url)
    ledger = PostgresWebhookLedger(postgres_url, provider_account_id=account, pool=pool)
    try:
        eid = uuid4().hex
        payload = {"id": eid, "event": "room_finished", "room": {"name": "room"}}
        await ledger.accept(provider_event_id=eid, event_type="room_finished", payload=payload)
        with pytest.raises(asyncpg.InvalidParameterValueError):
            await ledger.accept(
                provider_event_id=eid,
                event_type="room_finished",
                payload={**payload, "room": {"name": "changed"}},
            )
        with pytest.raises(asyncpg.InvalidParameterValueError):
            await ledger.accept(
                provider_event_id=eid,
                event_type="room_finished",
                payload={**payload, "id": "mismatch"},
            )
        async with pool.acquire() as c:
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await c.fetch("SELECT * FROM ops.inbound_events")
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await c.execute(
                    "INSERT INTO ops.inbound_events(provider,provider_account_id,"
                    "provider_event_id,event_type,payload) VALUES('meta','x','x','x','{}')"
                )
        admin = await asyncpg.connect(postgres_url)
        try:
            assert not await admin.fetchval(
                "SELECT has_function_privilege('platform_worker',"
                "'ops.accept_livekit_event(text,text,text,jsonb)','EXECUTE')"
            )
        finally:
            await admin.close()
    finally:
        await pool.close()


async def test_terminal_exhaustion_and_restart_replay(postgres_url):
    account = "fixture-" + uuid4().hex
    pool = await voice_pool(postgres_url)
    before = PostgresWebhookLedger(postgres_url, provider_account_id=account, pool=pool)
    after = PostgresWebhookLedger(postgres_url, provider_account_id=account, pool=pool)
    eid = uuid4().hex
    try:
        await before.accept(
            provider_event_id=eid,
            event_type="participant_joined",
            payload={"id": eid, "event": "participant_joined"},
        )
        old = (await before.claim_pending(1))[0]
        admin = await asyncpg.connect(postgres_url)
        try:
            await admin.execute(
                "UPDATE ops.inbound_events SET voice_lease_expires_at=clock_timestamp()"
                "-interval '1 second' WHERE id=$1::uuid",
                old.event_id,
            )
            replay = (await after.claim_pending(1))[0]
            assert replay.token != old.token
            await admin.execute(
                "UPDATE ops.inbound_events SET max_attempts=attempts WHERE id=$1::uuid",
                old.event_id,
            )
            assert await after.settle(replay, "failed", "dispatcher_handler_failed")
            row = await admin.fetchrow(
                "SELECT status,last_error_safe FROM ops.inbound_events WHERE id=$1::uuid",
                old.event_id,
            )
            assert row["status"] == "quarantined"
            assert row["last_error_safe"] == "dispatcher_attempts_exhausted"
            assert await after.claim_pending(1) == []
        finally:
            await admin.close()
    finally:
        await pool.close()


async def test_actual_signed_ingress_ack_survives_blocked_handler_and_restart(postgres_url):
    import base64
    import hashlib
    import json
    import time
    from unittest.mock import AsyncMock

    import httpx
    from livekit import api
    from oron_dispatcher.webhook import create_app

    account = "fixture-" + uuid4().hex
    pool = await voice_pool(postgres_url)
    ledger = PostgresWebhookLedger(postgres_url, provider_account_id=account, pool=pool)
    started, cleaned = asyncio.Event(), asyncio.Event()
    dispatcher = AsyncMock()

    async def blocked(event):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()

    dispatcher.handle_room_finished.side_effect = blocked
    eid = "EV_" + uuid4().hex
    body = json.dumps({"id": eid, "event": "room_finished", "room": {"name": "room"}})
    key, secret = "fixture-key", "fixture-secret-fixture-secret-fixture"
    digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
    token = api.AccessToken(key, secret).with_sha256(digest).to_jwt()
    receiver = api.WebhookReceiver(api.TokenVerifier(key, secret))
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
            before = time.monotonic()
            response = await client.post(
                "/livekit/webhook", content=body, headers={"Authorization": token}
            )
            assert response.status_code == 200
            assert time.monotonic() - before < 1
            await asyncio.wait_for(started.wait(), 1)
            assert not cleaned.is_set()
            duplicate = await client.post(
                "/livekit/webhook", content=body, headers={"Authorization": token}
            )
            assert duplicate.json()["duplicate"]
        assert cleaned.is_set()
        dispatcher.drain.assert_awaited_once()
        admin = await asyncpg.connect(postgres_url)
        try:
            row = await admin.fetchrow(
                "SELECT id,status FROM ops.inbound_events WHERE provider_account_id=$1 "
                "AND provider_event_id=$2",
                account,
                eid,
            )
            assert row["status"] == "processing"
            await admin.execute(
                "UPDATE ops.inbound_events SET voice_lease_expires_at=clock_timestamp()"
                "-interval '1 second' WHERE id=$1",
                row["id"],
            )
            restarted = PostgresWebhookLedger(postgres_url, provider_account_id=account, pool=pool)
            replay = (await restarted.claim_pending(1))[0]
            assert await restarted.settle(replay, "processed", None)
        finally:
            await admin.close()
    finally:
        await pool.close()


async def test_replayed_join_missing_current_participant_never_starts_agent(postgres_url):
    import base64
    import hashlib
    import json
    from unittest.mock import AsyncMock

    import httpx
    from livekit import api
    from oron_dispatcher.webhook import create_app

    account = "fixture-" + uuid4().hex
    pool = await voice_pool(postgres_url)
    ledger = PostgresWebhookLedger(postgres_url, provider_account_id=account, pool=pool)
    checked = asyncio.Event()
    dispatcher = AsyncMock()

    async def no_longer_present(event):
        checked.set()
        return False

    eid = "EV_" + uuid4().hex
    body = json.dumps(
        {
            "id": eid,
            "event": "participant_joined",
            "room": {"name": "room"},
            "participant": {"sid": "old-sid", "identity": "fixture", "kind": "SIP"},
        }
    )
    key, secret = "fixture-key", "fixture-secret-fixture-secret-fixture"
    digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
    token = api.AccessToken(key, secret).with_sha256(digest).to_jwt()
    app = create_app(
        dispatcher=dispatcher,
        receiver=api.WebhookReceiver(api.TokenVerifier(key, secret)),
        ledger=ledger,
        assertion_verifier=None,
        participant_is_current=no_longer_present,
    )
    try:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://fixture"
            ) as client,
        ):
            assert (
                await client.post(
                    "/livekit/webhook", content=body, headers={"Authorization": token}
                )
            ).status_code == 200
            await asyncio.wait_for(checked.wait(), 1)
        dispatcher.handle_participant_joined.assert_not_awaited()
    finally:
        await pool.close()
