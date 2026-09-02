from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
from unittest.mock import AsyncMock
from uuid import uuid4

import jwt
from fastapi.testclient import TestClient
from livekit import api
from or_on_platform.service_auth import ServiceAssertionVerifier
from oron_dispatcher.dispatcher import DispatchResult, HealthReport
from oron_dispatcher.sip_client import RealTelephonyDenied
from oron_dispatcher.webhook import create_app
from oron_dispatcher.webhook_ledger import WebhookClaim

LIVEKIT_KEY = "test-key"
LIVEKIT_SECRET = "test-secret-test-secret-test-secret"
SERVICE_SECRET = "service-secret-service-secret-123456"


class FakeLedger:
    def __init__(self) -> None:
        self.seen: set[str] = set()
        self.completed: list[str] = []
        self.failed: list[str] = []

    async def claim(self, *, provider_event_id: str, event_type: str, payload: dict[str, object]):
        duplicate = provider_event_id in self.seen
        self.seen.add(provider_event_id)
        return WebhookClaim(event_id=provider_event_id, should_process=not duplicate)

    async def complete(self, event_id: str) -> None:
        self.completed.append(event_id)

    async def fail(self, event_id: str) -> None:
        self.failed.append(event_id)

    async def ready(self) -> bool:
        return True

    async def close(self) -> None:
        return None


def _livekit_delivery(event_id: str = "EV_fixture") -> tuple[str, str]:
    body = json.dumps(
        {
            "event": "room_finished",
            "id": event_id,
            "createdAt": 1,
            "room": {"name": "call-fixture"},
        },
        separators=(",", ":"),
    )
    digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
    token = api.AccessToken(LIVEKIT_KEY, LIVEKIT_SECRET).with_sha256(digest).to_jwt()
    return body, token


def _service_token(*, audience: str = "dispatcher", capability: str = "voice:dial") -> str:
    now = dt.datetime.now(dt.UTC)
    return jwt.encode(
        {
            "iss": "or-on-platform-web",
            "aud": audience,
            "sub": str(uuid4()),
            "tenant_id": str(uuid4()),
            "role": "owner",
            "session_id": str(uuid4()),
            "capability": capability,
            "jti": str(uuid4()),
            "iat": now,
            "exp": now + dt.timedelta(seconds=60),
        },
        SERVICE_SECRET,
        algorithm="HS256",
    )


def _dispatcher() -> AsyncMock:
    dispatcher = AsyncMock()
    dispatcher.health.return_value = HealthReport(
        status="ready",
        active_calls=0,
        persistence_ready=True,
        sip_configured=False,
    )
    dispatcher.place_outbound_call.return_value = DispatchResult(
        session_id=uuid4(), room="call-test", created=True
    )
    return dispatcher


def _app(dispatcher: AsyncMock, ledger: FakeLedger):
    receiver = api.WebhookReceiver(api.TokenVerifier(LIVEKIT_KEY, LIVEKIT_SECRET))
    return create_app(
        dispatcher=dispatcher,
        receiver=receiver,
        ledger=ledger,
        assertion_verifier=ServiceAssertionVerifier(SERVICE_SECRET, audience="dispatcher"),
    )


def test_signed_livekit_fixture_is_processed_once() -> None:
    dispatcher = _dispatcher()
    ledger = FakeLedger()
    body, token = _livekit_delivery()

    with TestClient(_app(dispatcher, ledger)) as client:
        first = client.post("/livekit/webhook", content=body, headers={"Authorization": token})
        second = client.post("/livekit/webhook", content=body, headers={"Authorization": token})

    assert first.status_code == 200 and first.json() == {"ok": True, "duplicate": False}
    assert second.status_code == 200 and second.json() == {"ok": True, "duplicate": True}
    dispatcher.handle_room_finished.assert_awaited_once()
    assert ledger.completed == ["EV_fixture"]


def test_livekit_signature_rejects_tampered_body() -> None:
    dispatcher = _dispatcher()
    ledger = FakeLedger()
    body, token = _livekit_delivery()
    tampered = body.replace("call-fixture", "call-attacker")

    with TestClient(_app(dispatcher, ledger)) as client:
        response = client.post(
            "/livekit/webhook", content=tampered, headers={"Authorization": token}
        )

    assert response.status_code == 401
    dispatcher.handle_room_finished.assert_not_awaited()
    assert ledger.seen == set()


def test_outbound_contract_rejects_invalid_service_auth_and_capability() -> None:
    dispatcher = _dispatcher()
    ledger = FakeLedger()
    request = {
        "phone_number": "+14155550100",
        "flow_id": str(uuid4()),
        "idempotency_key": "request-1000",
        "explicit_approval": True,
    }
    with TestClient(_app(dispatcher, ledger)) as client:
        missing = client.post("/api/v1/dispatch/outbound", json=request)
        wrong_audience = client.post(
            "/api/v1/dispatch/outbound",
            json=request,
            headers={"Authorization": f"Bearer {_service_token(audience='control-api')}"},
        )
        wrong_capability = client.post(
            "/api/v1/dispatch/outbound",
            json=request,
            headers={"Authorization": f"Bearer {_service_token(capability='voice:read')}"},
        )

    assert missing.status_code == 401
    assert wrong_audience.status_code == 401
    assert wrong_capability.status_code == 403
    dispatcher.place_outbound_call.assert_not_awaited()


def test_outbound_contract_requires_matching_idempotency_header() -> None:
    dispatcher = _dispatcher()
    ledger = FakeLedger()
    request = {
        "phone_number": "+14155550100",
        "flow_id": str(uuid4()),
        "idempotency_key": "request-1001",
        "explicit_approval": True,
    }
    headers = {
        "Authorization": f"Bearer {_service_token()}",
        "Idempotency-Key": "different-key",
    }
    with TestClient(_app(dispatcher, ledger)) as client:
        response = client.post("/api/v1/dispatch/outbound", json=request, headers=headers)

    assert response.status_code == 400
    dispatcher.place_outbound_call.assert_not_awaited()


def test_outbound_contract_surfaces_provider_safety_denial() -> None:
    dispatcher = _dispatcher()
    dispatcher.place_outbound_call.side_effect = RealTelephonyDenied("real telephony is disabled")
    ledger = FakeLedger()
    request = {
        "phone_number": "+14155550100",
        "flow_id": str(uuid4()),
        "idempotency_key": "request-1002",
        "explicit_approval": True,
    }
    headers = {
        "Authorization": f"Bearer {_service_token()}",
        "Idempotency-Key": "request-1002",
    }
    with TestClient(_app(dispatcher, ledger)) as client:
        response = client.post("/api/v1/dispatch/outbound", json=request, headers=headers)

    assert response.status_code == 503
    assert response.json()["detail"] == "real telephony is disabled"
