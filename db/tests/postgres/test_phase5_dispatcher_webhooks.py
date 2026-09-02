from __future__ import annotations

from uuid import uuid4

import asyncpg
import pytest
from oron_dispatcher.webhook_ledger import PostgresWebhookLedger

pytestmark = [pytest.mark.postgres, pytest.mark.integration]


async def test_platform_voice_can_durably_deduplicate_livekit_webhooks(
    postgres_url: str,
) -> None:
    provider_event_id = f"EV_{uuid4().hex}"

    async def assume_voice_role(connection: asyncpg.Connection) -> None:
        await connection.execute("SET ROLE platform_voice")

    pool = await asyncpg.create_pool(postgres_url, min_size=1, max_size=2, init=assume_voice_role)
    ledger = PostgresWebhookLedger(
        postgres_url,
        provider_account_id="phase5-live-test",
        pool=pool,
    )
    try:
        assert await ledger.ready() is True
        first = await ledger.claim(
            provider_event_id=provider_event_id,
            event_type="room_finished",
            payload={"id": provider_event_id, "event": "room_finished"},
        )
        assert first.should_process is True
        await ledger.complete(first.event_id)

        replay = await ledger.claim(
            provider_event_id=provider_event_id,
            event_type="room_finished",
            payload={"id": provider_event_id, "event": "room_finished"},
        )
        assert replay.event_id == first.event_id
        assert replay.should_process is False
    finally:
        await pool.close()
        admin = await asyncpg.connect(postgres_url)
        try:
            await admin.execute(
                "DELETE FROM ops.inbound_events WHERE provider = 'livekit' "
                "AND provider_account_id = 'phase5-live-test' AND provider_event_id = $1",
                provider_event_id,
            )
        finally:
            await admin.close()


async def test_platform_voice_has_only_required_webhook_ledger_privileges(
    pg: asyncpg.Connection,
) -> None:
    assert await pg.fetchval(
        "SELECT has_table_privilege('platform_voice', 'ops.inbound_events', 'SELECT,INSERT,UPDATE')"
    )
    assert not await pg.fetchval(
        "SELECT has_table_privilege('platform_voice', 'ops.inbound_events', 'DELETE')"
    )
    assert not await pg.fetchval(
        "SELECT has_table_privilege('platform_voice', 'ops.jobs', 'INSERT')"
    )
