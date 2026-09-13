"""Control API authentication and command contracts without providers or DB."""

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import jwt
import pytest
from control_api.auth import ServiceAssertionVerifier, ServicePrincipal
from control_api.voice_control import (
    PostgresVoiceControlRepository,
    VoiceControlStatus,
    create_voice_control_router,
)
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

SECRET = "voice-control-fixture-signing-secret-long-enough"


def token(capability):
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "iss": "or-on-platform-web",
            "aud": "control-api",
            "sub": str(uuid4()),
            "tenant_id": str(uuid4()),
            "role": "agent",
            "session_id": str(uuid4()),
            "jti": str(uuid4()),
            "iat": now,
            "exp": now + timedelta(seconds=60),
            "capability": capability,
        },
        SECRET,
        algorithm="HS256",
    )


async def test_viewer_status_requires_auth_and_write_requires_explicit_capability():
    repository = AsyncMock()
    session = uuid4()
    repository.get.return_value = VoiceControlStatus(
        session_id=session,
        epoch=0,
        desired_mode="ai",
        status="pending",
        active=True,
        can_operate=False,
    )
    app = FastAPI()
    app.include_router(create_voice_control_router(repository, ServiceAssertionVerifier(SECRET)))
    async with AsyncClient(transport=ASGITransport(app), base_url="http://fixture") as client:
        path = f"/api/v1/voice/sessions/{session}/control"
        assert (await client.get(path)).status_code == 401
        headers = {"Authorization": f"Bearer {token('voice:read')}"}
        response = await client.get(path, headers=headers)
        assert response.status_code == 200
        assert response.json()["human_connection"] == "not_managed"
        denied = await client.post(
            path,
            headers=headers,
            json={
                "mode": "paused",
                "expected_epoch": 0,
                "idempotency_key": "fixture-key",
            },
        )
        assert denied.status_code == 403
        repository.command.assert_not_awaited()


@pytest.mark.parametrize("ack", [None, "stale", "future"])
async def test_missing_stale_or_future_worker_ack_is_not_applied(ack):
    now = datetime.now(UTC)
    result = Mock()
    result.mappings.return_value.one_or_none.return_value = {
        "epoch": 3,
        "desired_mode": "paused",
        "acknowledged_epoch": 3,
        "worker_mode": "paused",
        "acknowledged_at": None
        if ack is None
        else now + timedelta(seconds=30 if ack == "future" else -30),
        "requested_at": now - timedelta(seconds=15),
        "command_id": uuid4(),
        "active": True,
        "can_operate": True,
        "resume_authorized": True,
    }
    database = AsyncMock()
    database.execute.return_value = result
    principal = ServicePrincipal(
        tenant_id=uuid4(),
        user_id=uuid4(),
        role="agent",
        capability="voice:read",
        session_id=uuid4(),
    )
    repository = PostgresVoiceControlRepository(Mock())
    status = await repository._status(database, principal, uuid4())
    assert status.status == "worker_unavailable"


@pytest.mark.parametrize("extra", [{"mode": "human"}, {"expected_epoch": True}, {"force": True}])
async def test_invalid_control_commands_never_reach_repository(extra):
    repository = AsyncMock()
    app = FastAPI()
    app.include_router(create_voice_control_router(repository, ServiceAssertionVerifier(SECRET)))
    async with AsyncClient(transport=ASGITransport(app), base_url="http://fixture") as client:
        response = await client.post(
            f"/api/v1/voice/sessions/{uuid4()}/control",
            headers={"Authorization": f"Bearer {token('voice:write')}"},
            json={"mode": "paused", "expected_epoch": 0, "idempotency_key": "fixture-key", **extra},
        )
        assert response.status_code == 422
        repository.command.assert_not_awaited()
