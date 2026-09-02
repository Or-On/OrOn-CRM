from dispatcher_runtime.app import build
from fastapi.testclient import TestClient
from or_on_platform.config import PlatformSettings
from oron_dispatcher.config import DispatcherSettings


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
