from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from dispatcher_runtime.app import build, compose_dispatcher
from fastapi.testclient import TestClient
from or_on_platform.config import PlatformSettings
from oron_agent.bot import RealVoiceProvidersDenied
from oron_agent.config import Settings as AgentSettings
from oron_dispatcher.config import DispatcherSettings
from oron_dispatcher.sip_client import SipClient
from oron_sessions import SessionStatus


def test_partial_dispatcher_runtime_is_live_but_honestly_not_ready() -> None:
    app = build(
        platform_settings=PlatformSettings(
            PLATFORM_ENV="test",
            VOICE_DATABASE_URL=None,
            AUTH_SERVICE_SECRET=None,
        ),
        dispatcher_settings=DispatcherSettings(
            _env_file=None,
            LIVEKIT_API_KEY=None,
            LIVEKIT_API_SECRET=None,
            ENABLE_REAL_TELEPHONY=False,
        ),
    )

    with TestClient(app) as client:
        assert client.get("/health/live").status_code == 200
        assert client.get("/health/ready").status_code == 503
        assert client.post("/livekit/webhook", content="{}").status_code == 503


def test_runtime_has_no_firebase_or_legacy_admin_routes() -> None:
    app = build(
        platform_settings=PlatformSettings(
            PLATFORM_ENV="test",
            VOICE_DATABASE_URL=None,
            AUTH_SERVICE_SECRET=None,
        ),
        dispatcher_settings=DispatcherSettings(_env_file=None),
    )
    paths = {route.path for route in app.routes}

    assert "/admin" not in paths
    assert "/auth-config" not in paths
    assert "/health/live" in paths
    assert "/livekit/webhook" in paths


async def test_composition_injects_provider_safe_retained_agent_launcher() -> None:
    sessions = AsyncMock()
    sessions.begin.return_value = True
    sessions.finalize.return_value = True
    dispatcher = compose_dispatcher(
        dispatcher_settings=DispatcherSettings(_env_file=None),
        agent_settings=AgentSettings(_env_file=None),
        sessions=sessions,
        sip_client=SipClient(
            url="http://127.0.0.1:7880",
            api_key="fixture",
            api_secret="fixture",
            trunk_id=None,
            enabled=False,
        ),
        resolve_phone=AsyncMock(return_value=None),
        hangup_room=AsyncMock(),
        mint_token=lambda _room, _identity: "fixture-token",
    )

    with pytest.raises(RealVoiceProvidersDenied, match="disabled"):
        await dispatcher.start_browser_call(flow_id=uuid4(), tenant_id=uuid4())

    sessions.begin.assert_awaited_once()
    assert sessions.finalize.await_args.kwargs["status"] is SessionStatus.FAILED
