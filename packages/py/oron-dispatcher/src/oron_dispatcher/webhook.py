"""Signed LiveKit webhook and canonically authenticated dispatcher contracts."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal, Protocol
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from or_on_platform.service_auth import (
    InvalidServiceAssertion,
    ServiceAssertionVerifier,
    ServicePrincipal,
)
from oron_common import E164
from pydantic import BaseModel, Field

from oron_dispatcher.dispatcher import (
    Dispatcher,
    DispatchResult,
    HealthReport,
    PersistenceUnavailable,
)
from oron_dispatcher.sip_client import RealTelephonyDenied
from oron_dispatcher.webhook_ledger import WebhookLedger

logger = logging.getLogger(__name__)


class WebhookReceiver(Protocol):
    def receive(self, body: str, auth_token: str) -> Any: ...


class OutboundCallRequest(BaseModel):
    phone_number: E164
    flow_id: UUID
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    explicit_approval: bool = False


class WebhookAck(BaseModel):
    ok: bool = True
    duplicate: bool = False


class LiveStatus(BaseModel):
    status: Literal["alive"] = "alive"
    service: Literal["dispatcher"] = "dispatcher"


class ReadyStatus(BaseModel):
    status: Literal["ready", "not_ready"]
    dispatcher: HealthReport | None
    webhook_ledger_ready: bool


def create_app(
    *,
    dispatcher: Dispatcher | None,
    receiver: WebhookReceiver | None,
    ledger: WebhookLedger | None,
    assertion_verifier: ServiceAssertionVerifier | None,
) -> FastAPI:
    """Build the dispatcher HTTP boundary with injected process-owned state."""

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            if ledger is not None:
                await ledger.close()

    app = FastAPI(title="Or-On Platform Dispatcher", version="0.1.0", lifespan=lifespan)
    bearer = HTTPBearer(auto_error=False)

    async def require_dial_capability(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    ) -> ServicePrincipal:
        if assertion_verifier is None:
            raise HTTPException(
                status_code=503, detail="dispatcher authentication is not configured"
            )
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="authentication required")
        try:
            principal = assertion_verifier.verify(credentials.credentials)
        except InvalidServiceAssertion:
            raise HTTPException(status_code=401, detail="invalid service assertion") from None
        if principal.capability != "voice:dial":
            raise HTTPException(status_code=403, detail="voice dial capability required")
        return principal

    @app.get("/health/live", response_model=LiveStatus)
    async def liveness() -> LiveStatus:
        return LiveStatus()

    @app.get("/health/ready", response_model=ReadyStatus)
    async def readiness() -> ReadyStatus:
        report = await dispatcher.health() if dispatcher is not None else None
        ledger_ready = await ledger.ready() if ledger is not None else False
        ready = report is not None and report.persistence_ready and ledger_ready
        if not ready:
            raise HTTPException(
                status_code=503,
                detail=ReadyStatus(
                    status="not_ready",
                    dispatcher=report,
                    webhook_ledger_ready=ledger_ready,
                ).model_dump(),
            )
        return ReadyStatus(status="ready", dispatcher=report, webhook_ledger_ready=True)

    @app.post("/livekit/webhook", response_model=WebhookAck)
    async def livekit_webhook(request: Request) -> WebhookAck:
        if dispatcher is None or receiver is None or ledger is None:
            raise HTTPException(status_code=503, detail="dispatcher webhook is not ready")
        body = (await request.body()).decode("utf-8")
        try:
            event = receiver.receive(body, request.headers.get("authorization", ""))
            payload = json.loads(body)
            provider_event_id = str(event.id)
            event_type = str(event.event)
            if not provider_event_id or not event_type or not isinstance(payload, dict):
                raise ValueError("missing webhook identity")
        except Exception as exc:
            logger.warning("Rejected LiveKit webhook", extra={"error_type": type(exc).__name__})
            raise HTTPException(
                status_code=401, detail="invalid webhook signature or body"
            ) from None

        claim = await ledger.claim(
            provider_event_id=provider_event_id,
            event_type=event_type,
            payload=payload,
        )
        if not claim.should_process:
            return WebhookAck(duplicate=True)
        try:
            if event_type == "participant_joined":
                await dispatcher.handle_participant_joined(event)
            elif event_type == "room_finished":
                await dispatcher.handle_room_finished(event)
            await ledger.complete(claim.event_id)
        except Exception:
            await ledger.fail(claim.event_id)
            raise HTTPException(status_code=503, detail="webhook processing failed") from None
        return WebhookAck()

    @app.post("/api/v1/dispatch/outbound", response_model=DispatchResult)
    async def place_call(
        request: OutboundCallRequest,
        principal: ServicePrincipal = Depends(require_dial_capability),
        idempotency_header: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> DispatchResult:
        if dispatcher is None:
            raise HTTPException(status_code=503, detail="dispatcher is not ready")
        if idempotency_header != request.idempotency_key:
            raise HTTPException(status_code=400, detail="idempotency key mismatch")
        try:
            return await dispatcher.place_outbound_call(
                request.phone_number,
                principal.tenant_id,
                request.flow_id,
                idempotency_key=request.idempotency_key,
                explicit_approval=request.explicit_approval,
            )
        except RealTelephonyDenied as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        except PersistenceUnavailable:
            raise HTTPException(status_code=503, detail="call persistence is unavailable") from None

    return app
