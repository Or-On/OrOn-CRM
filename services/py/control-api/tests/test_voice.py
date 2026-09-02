from __future__ import annotations

import datetime as dt
from uuid import UUID, uuid4

import jwt
from control_api.app import create_app
from control_api.auth import ServiceAssertionVerifier, ServicePrincipal
from control_api.voice import VoiceSessionSummary
from httpx import ASGITransport, AsyncClient
from or_on_platform.config import PlatformSettings
from oron_common import Direction
from oron_sessions.models import SessionStatus

SECRET = "phase5-service-assertion-secret-long-enough"


class FakeProbe:
    async def is_ready(self) -> bool:
        return True

    async def close(self) -> None:
        return None


class FakeVoiceRepository:
    def __init__(self) -> None:
        self.principal: ServicePrincipal | None = None
        self.closed = False

    async def list_sessions(self, principal: ServicePrincipal) -> list[VoiceSessionSummary]:
        self.principal = principal
        return [
            VoiceSessionSummary(
                session_id=uuid4(),
                contact_id=None,
                platform_campaign_id=None,
                provider="simulator",
                direction=Direction.OUTBOUND,
                status=SessionStatus.ENDED,
                answered=True,
                outcome="fixture_complete",
                created_at=dt.datetime(2026, 9, 2, tzinfo=dt.UTC),
                ended_at=dt.datetime(2026, 9, 2, 0, 1, tzinfo=dt.UTC),
            )
        ]

    async def close(self) -> None:
        self.closed = True


def _settings() -> PlatformSettings:
    return PlatformSettings(_env_file=None, PLATFORM_ENV="test", PLATFORM_SERVICE="control-api")


def _token(
    *,
    tenant_id: UUID | None = None,
    capability: str | None = "voice:read",
    audience: str = "control-api",
    lifetime_seconds: int = 60,
) -> str:
    now = dt.datetime.now(dt.UTC)
    claims: dict[str, object] = {
        "iss": "or-on-platform-web",
        "aud": audience,
        "sub": str(uuid4()),
        "tenant_id": str(tenant_id or uuid4()),
        "role": "agent",
        "session_id": str(uuid4()),
        "jti": str(uuid4()),
        "iat": now,
        "exp": now + dt.timedelta(seconds=lifetime_seconds),
    }
    if capability is not None:
        claims["capability"] = capability
    return jwt.encode(claims, SECRET, algorithm="HS256")


async def test_voice_sessions_require_and_propagate_canonical_identity() -> None:
    tenant_id = uuid4()
    repository = FakeVoiceRepository()
    app = create_app(
        settings=_settings(),
        database_probe=FakeProbe(),
        voice_repository=repository,
        assertion_verifier=ServiceAssertionVerifier(SECRET),
    )
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.get(
            "/api/v1/voice/sessions",
            headers={"authorization": f"Bearer {_token(tenant_id=tenant_id)}"},
        )

    assert response.status_code == 200
    assert response.json()["items"][0]["provider"] == "simulator"
    assert repository.principal is not None
    assert repository.principal.tenant_id == tenant_id
    assert repository.closed


async def test_voice_sessions_reject_wrong_audience_and_missing_capability() -> None:
    app = create_app(
        settings=_settings(),
        database_probe=FakeProbe(),
        voice_repository=FakeVoiceRepository(),
        assertion_verifier=ServiceAssertionVerifier(SECRET),
    )
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        wrong_audience = await client.get(
            "/api/v1/voice/sessions",
            headers={"authorization": f"Bearer {_token(audience='live-agent')}"},
        )
        missing_capability = await client.get(
            "/api/v1/voice/sessions",
            headers={"authorization": f"Bearer {_token(capability=None)}"},
        )
        excessive_lifetime = await client.get(
            "/api/v1/voice/sessions",
            headers={"authorization": f"Bearer {_token(lifetime_seconds=121)}"},
        )

    assert wrong_audience.status_code == 401
    assert missing_capability.status_code == 403
    assert excessive_lifetime.status_code == 401


async def test_voice_contract_exists_but_unconfigured_runtime_fails_closed() -> None:
    settings = PlatformSettings(
        _env_file=None,
        PLATFORM_ENV="test",
        PLATFORM_SERVICE="control-api",
        AUTH_SERVICE_SECRET=SECRET,
    )
    app = create_app(settings=settings, database_probe=FakeProbe())
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.get("/api/v1/voice/sessions")

    assert response.status_code == 503
    assert "/api/v1/voice/sessions" in app.openapi()["paths"]


def test_voice_database_requires_service_assertion_secret() -> None:
    settings = PlatformSettings(
        _env_file=None,
        PLATFORM_ENV="test",
        PLATFORM_SERVICE="control-api",
        VOICE_DATABASE_URL="postgresql://voice:test@localhost/platform",
    )

    try:
        create_app(settings=settings, database_probe=FakeProbe())
    except RuntimeError as error:
        assert str(error) == "AUTH_SERVICE_SECRET is required when VOICE_DATABASE_URL is configured"
    else:
        raise AssertionError(
            "voice database configuration must fail closed without an assertion secret"
        )
