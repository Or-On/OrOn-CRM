from control_api.app import create_app
from httpx import ASGITransport, AsyncClient
from or_on_platform.config import PlatformSettings


class FakeProbe:
    def __init__(self, *, ready: bool) -> None:
        self.ready = ready
        self.closed = False

    async def is_ready(self) -> bool:
        return self.ready

    async def close(self) -> None:
        self.closed = True


def _settings() -> PlatformSettings:
    return PlatformSettings(_env_file=None, PLATFORM_ENV="test", PLATFORM_SERVICE="control-api")


async def test_liveness_reports_process_without_querying_dependency() -> None:
    probe = FakeProbe(ready=False)
    app = create_app(settings=_settings(), database_probe=probe)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.get("/health/live")

    assert response.status_code == 200
    assert response.json() == {"status": "alive", "service": "control-api", "version": "0.1.0"}
    assert probe.closed is True


async def test_readiness_succeeds_when_postgresql_is_available() -> None:
    app = create_app(settings=_settings(), database_probe=FakeProbe(ready=True))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.get("/health/ready")

    assert response.status_code == 200
    assert response.json()["dependencies"] == {"postgres": "ready"}


async def test_readiness_fails_when_postgresql_is_unavailable() -> None:
    app = create_app(settings=_settings(), database_probe=FakeProbe(ready=False))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.get("/health/ready")

    assert response.status_code == 503
    assert response.json() == {
        "status": "not_ready",
        "service": "control-api",
        "dependencies": {"postgres": "unavailable"},
    }
