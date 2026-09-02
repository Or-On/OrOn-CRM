from __future__ import annotations

import datetime as dt
from uuid import uuid4

import jwt
from control_api.app import create_app
from control_api.auth import ServiceAssertionVerifier
from httpx import ASGITransport, AsyncClient
from or_on_platform.config import PlatformSettings

SECRET = "phase6-service-assertion-secret-long-enough"


class FakeProbe:
    async def is_ready(self) -> bool:
        return True

    async def close(self) -> None:
        return None


def _token(capability: str = "orchestration:write") -> str:
    now = dt.datetime.now(dt.UTC)
    return jwt.encode(
        {
            "iss": "or-on-platform-web",
            "aud": "control-api",
            "sub": str(uuid4()),
            "tenant_id": str(uuid4()),
            "session_id": str(uuid4()),
            "jti": str(uuid4()),
            "role": "owner",
            "capability": capability,
            "iat": int(now.timestamp()),
            "exp": int((now + dt.timedelta(seconds=60)).timestamp()),
        },
        SECRET,
        algorithm="HS256",
    )


async def test_canonical_flow_contract_compiles_retained_adapters() -> None:
    settings = PlatformSettings(_env_file=None, PLATFORM_ENV="test", PLATFORM_SERVICE="control-api")
    app = create_app(
        settings=settings,
        database_probe=FakeProbe(),
        assertion_verifier=ServiceAssertionVerifier(SECRET),
    )
    payload = {
        "schemaVersion": "1.0",
        "channels": ["whatsapp", "voice"],
        "nodes": [
            {"id": "start", "type": "start"},
            {"id": "call", "type": "voice.call"},
            {"id": "message", "type": "message.send"},
            {"id": "end", "type": "end"},
        ],
        "edges": [
            {"id": "voice", "source": "start", "target": "call"},
            {"id": "message", "source": "start", "target": "message"},
            {"id": "voice-end", "source": "call", "target": "end"},
            {"id": "message-end", "source": "message", "target": "end"},
        ],
    }
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.post(
            "/api/v1/orchestration/flows/validate",
            json=payload,
            headers={"authorization": f"Bearer {_token()}"},
        )
        forbidden = await client.post(
            "/api/v1/orchestration/flows/validate",
            json=payload,
            headers={"authorization": f"Bearer {_token('voice:write')}"},
        )

    assert response.status_code == 200
    result = response.json()
    assert result["valid"] is True
    assert result["adapters"]["voice"]["schemaVersion"] == "oron-flow.v1"
    assert result["adapters"]["whatsapp"]["schemaVersion"] == "wacrm-automation.v1"
    assert forbidden.status_code == 403


async def test_canonical_flow_contract_rejects_incompatible_graph() -> None:
    settings = PlatformSettings(_env_file=None, PLATFORM_ENV="test", PLATFORM_SERVICE="control-api")
    app = create_app(
        settings=settings,
        database_probe=FakeProbe(),
        assertion_verifier=ServiceAssertionVerifier(SECRET),
    )
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.post(
            "/api/v1/orchestration/flows/validate",
            json={
                "schemaVersion": "1.0",
                "channels": ["voice"],
                "nodes": [
                    {"id": "start", "type": "start"},
                    {"id": "message", "type": "message.send"},
                ],
                "edges": [{"id": "broken", "source": "start", "target": "missing"}],
            },
            headers={"authorization": f"Bearer {_token()}"},
        )
    assert response.status_code == 200
    assert response.json()["valid"] is False
    assert "flow must contain at least one end node" in response.json()["errors"]
