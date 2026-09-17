from __future__ import annotations

import datetime as dt
from uuid import UUID, uuid4

import jwt
from control_api.app import create_app
from control_api.auth import ServiceAssertionVerifier, ServicePrincipal
from control_api.voice import (
    RealTelephonyDenied,
    SimulatedCallRequest,
    SimulatedCallResult,
    VoiceSessionSummary,
    require_real_telephony_authorization,
)
from httpx import ASGITransport, AsyncClient
from or_on_platform.config import PlatformSettings
from oron_common import CallCost, CallUsage, Direction
from oron_sessions.models import SessionStatus
from sqlalchemy.dialects import postgresql

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
                usage=CallUsage(call_seconds=60),
                cost=CallCost(stt=0.002, llm=0.001, tts=0.003),
            )
        ]

    async def simulate_call(
        self, principal: ServicePrincipal, command: SimulatedCallRequest
    ) -> SimulatedCallResult:
        self.principal = principal
        return SimulatedCallResult(
            session=(await self.list_sessions(principal))[0],
            created=True,
            event_types=[
                "voice.call.requested.v1",
                "voice.call.started.v1",
                "voice.call.answered.v1",
                "voice.call.ended.v1",
            ],
        )

    async def get_recording(self, principal: ServicePrincipal, session_id: UUID) -> bytes | None:
        self.principal = principal
        return b"RIFFfixture-wave"

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
    assert response.json()["items"][0]["cost"]["total"] == 0.006
    assert repository.principal is not None
    assert repository.principal.tenant_id == tenant_id
    assert repository.closed


async def test_voice_recording_is_tenant_authorized_and_streamed_as_wav() -> None:
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
        denied = await client.get(f"/api/v1/voice/sessions/{uuid4()}/recording")
        accepted = await client.get(
            f"/api/v1/voice/sessions/{uuid4()}/recording",
            headers={"authorization": f"Bearer {_token(tenant_id=tenant_id)}"},
        )

    assert denied.status_code == 401
    assert accepted.status_code == 200
    assert accepted.headers["content-type"] == "audio/wav"
    assert accepted.headers["cache-control"] == "private, no-store"
    assert accepted.content == b"RIFFfixture-wave"
    assert repository.principal is not None
    assert repository.principal.tenant_id == tenant_id


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


async def test_simulated_call_requires_write_capability() -> None:
    contact_id = uuid4()
    repository = FakeVoiceRepository()
    app = create_app(
        settings=_settings(),
        database_probe=FakeProbe(),
        voice_repository=repository,
        assertion_verifier=ServiceAssertionVerifier(SECRET),
    )
    command = {
        "contact_id": str(contact_id),
        "idempotency_key": "phase5-simulator-unit",
        "mode": "simulator",
    }
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        denied = await client.post(
            "/api/v1/voice/simulated-calls",
            headers={"authorization": f"Bearer {_token(capability='voice:read')}"},
            json=command,
        )
        accepted = await client.post(
            "/api/v1/voice/simulated-calls",
            headers={"authorization": f"Bearer {_token(capability='voice:write')}"},
            json=command,
        )

    assert denied.status_code == 403
    assert accepted.status_code == 200
    assert accepted.json()["created"] is True
    assert repository.principal is not None
    assert repository.principal.capability == "voice:write"


async def test_voice_configuration_requires_manage_not_operate_capability() -> None:
    """An agent's `voice:write` operates calls; it must not publish flows, route
    numbers or create/run campaigns — those are flows/campaigns management."""

    class ManagingRepository(FakeVoiceRepository):
        async def run_campaign(self, principal: ServicePrincipal, campaign_id: UUID):
            self.principal = principal
            raise LookupError("campaign not found")

    repository = ManagingRepository()
    app = create_app(
        settings=_settings(),
        database_probe=FakeProbe(),
        voice_repository=repository,
        assertion_verifier=ServiceAssertionVerifier(SECRET),
    )
    flow_id = str(uuid4())
    requests = [
        ("/api/v1/voice/flows/publish", {"source": {}}),
        (
            "/api/v1/voice/phone-numbers",
            {"e164": "+972501234567", "flow_id": flow_id, "allowed_addresses": ["192.0.2.0/24"]},
        ),
        ("/api/v1/voice/campaigns", {"name": "Fictional", "flow_id": flow_id}),
        ("/api/v1/voice/campaigns/run", {"campaign_id": str(uuid4())}),
    ]
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        for path, body in requests:
            for capability in ("voice:read", "voice:write"):
                denied = await client.post(
                    path,
                    headers={"authorization": f"Bearer {_token(capability=capability)}"},
                    json=body,
                )
                assert denied.status_code == 403, (path, capability)
        managed = await client.post(
            "/api/v1/voice/campaigns/run",
            headers={"authorization": f"Bearer {_token(capability='voice:manage')}"},
            json={"campaign_id": str(uuid4())},
        )
        # Manage capability still reads.
        listed = await client.get(
            "/api/v1/voice/sessions",
            headers={"authorization": f"Bearer {_token(capability='voice:manage')}"},
        )

    assert managed.status_code == 404
    assert repository.principal is not None
    assert repository.principal.capability == "voice:manage"
    assert listed.status_code == 200


def test_real_telephony_requires_flag_and_explicit_action_approval() -> None:
    for enabled, approved in ((False, False), (False, True), (True, False)):
        try:
            require_real_telephony_authorization(
                enabled=enabled,
                explicit_approval=approved,
            )
        except RealTelephonyDenied:
            pass
        else:
            raise AssertionError("a missing real-telephony gate must deny the action")

    require_real_telephony_authorization(enabled=True, explicit_approval=True)


async def test_voice_contract_exists_but_unconfigured_runtime_fails_closed() -> None:
    settings = PlatformSettings(
        _env_file=None,
        PLATFORM_ENV="test",
        PLATFORM_SERVICE="control-api",
        AUTH_SERVICE_SECRET=SECRET,
        VOICE_DATABASE_URL=None,
    )
    app = create_app(settings=settings, database_probe=FakeProbe())
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.get("/api/v1/voice/sessions")

    assert response.status_code == 503
    assert "/api/v1/voice/sessions" in app.openapi()["paths"]


def test_phase5_voice_contract_exposes_all_operator_boundaries() -> None:
    app = create_app(
        settings=_settings(),
        database_probe=FakeProbe(),
        voice_repository=FakeVoiceRepository(),
        assertion_verifier=ServiceAssertionVerifier(SECRET),
    )
    paths = set(app.openapi()["paths"])
    assert {
        "/api/v1/voice/campaigns",
        "/api/v1/voice/campaigns/run",
        "/api/v1/voice/component-catalog",
        "/api/v1/voice/flows",
        "/api/v1/voice/flows/publish",
        "/api/v1/voice/flows/validate",
        "/api/v1/voice/phone-numbers",
        "/api/v1/voice/phone-numbers/reconciliation",
        "/api/v1/voice/session-detail",
        "/api/v1/voice/sessions",
        "/api/v1/voice/simulated-calls",
    }.issubset(paths)


def test_voice_database_requires_service_assertion_secret() -> None:
    settings = PlatformSettings(
        _env_file=None,
        PLATFORM_ENV="test",
        PLATFORM_SERVICE="control-api",
        AUTH_SERVICE_SECRET=None,
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


def test_phone_number_listing_is_scoped_to_the_principals_tenant() -> None:
    """`public.phone_numbers` carries no RLS policy — the dispatcher must resolve
    an inbound DID before any tenant is known. The listing statement's own
    predicate is therefore the whole isolation boundary: without it every
    operator with voice:read sees every tenant's numbers and flow bindings."""

    from control_api.voice import _tenant_phone_numbers

    tenant_id = uuid4()
    compiled = _tenant_phone_numbers(tenant_id).compile(
        dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
    )
    statement = " ".join(str(compiled).split())

    assert f"WHERE phone_numbers.tenant_id = '{tenant_id}'" in statement
    assert "ORDER BY phone_numbers.e164" in statement
