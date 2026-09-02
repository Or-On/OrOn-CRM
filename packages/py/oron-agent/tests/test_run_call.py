import uuid
from unittest.mock import AsyncMock, patch

import pytest
from oron_agent.bot import RealVoiceProvidersDenied, run_call
from oron_agent.config import Settings
from oron_common import CallContext


def _settings() -> Settings:
    return Settings(
        LIVEKIT_URL="ws://localhost:7880",
        LIVEKIT_API_KEY="APIoron",
        LIVEKIT_API_SECRET="secret_secret_secret_secret_secret_0",
        GOOGLE_CLOUD_PROJECT="proj",
        SONIOX_API_KEY="x",
        ENABLE_REAL_VOICE_PROVIDERS=True,
    )


async def test_run_call_builds_transport_for_the_given_room():
    ctx = CallContext(
        call_id="call-abc", direction="inbound", flow_id=uuid.uuid4(), tenant_id=uuid.uuid4()
    )
    with (
        patch("oron_agent.bot.LiveKitTransport") as MockTransport,
        patch("oron_agent.bot.run_bot", new=AsyncMock()) as mock_run_bot,
    ):
        await run_call("call-abc", ctx, _settings())

    _, kwargs = MockTransport.call_args
    assert kwargs["room_name"] == "call-abc"
    assert isinstance(kwargs["token"], str) and kwargs["token"]
    mock_run_bot.assert_awaited_once()


async def test_the_bot_is_told_the_room_it_joined_not_the_one_in_settings():
    """`livekit_room` is a single deployment-wide default, and the dispatcher runs
    every call in-process against one shared Settings — so it is never the room a
    dispatched call is in. Read live on 2026-08-01: the agent finished a call in
    `call-705f8cafc410` and logged `Could not hang up room oron-dev: not_found`,
    leaving the SIP leg open.
    """
    st = _settings()
    ctx = CallContext(
        call_id="call-abc", direction="inbound", flow_id=uuid.uuid4(), tenant_id=uuid.uuid4()
    )
    with (
        patch("oron_agent.bot.LiveKitTransport"),
        patch("oron_agent.bot.run_bot", new=AsyncMock()) as mock_run_bot,
    ):
        await run_call("call-abc", ctx, st)

    assert st.livekit_room != "call-abc", "the default has to differ, or this proves nothing"
    assert mock_run_bot.await_args.kwargs["room"] == "call-abc"


async def test_run_call_denies_before_livekit_construction_by_default():
    ctx = CallContext(
        call_id="call-denied",
        direction="browser",
        flow_id=uuid.uuid4(),
        tenant_id=uuid.uuid4(),
    )
    with (
        patch("oron_agent.bot.mint_room_token") as mint_token,
        pytest.raises(RealVoiceProvidersDenied, match="real voice providers are disabled"),
    ):
        await run_call("call-denied", ctx, Settings(_env_file=None))
    mint_token.assert_not_called()
