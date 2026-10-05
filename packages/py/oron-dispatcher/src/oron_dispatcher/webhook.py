"""Signed LiveKit webhook and canonically authenticated dispatcher contracts."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any, Literal, Protocol
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from google.protobuf.json_format import ParseDict
from livekit.protocol.webhook import WebhookEvent
from or_on_platform.service_auth import (
    InvalidServiceAssertion,
    ServiceAssertionVerifier,
    ServicePrincipal,
)
from oron_common import E164
from pydantic import BaseModel, Field, model_validator

from oron_dispatcher.dispatcher import (
    AdmissionUnavailable,
    AgentStartupUnavailable,
    Dispatcher,
    DispatchResult,
    HealthReport,
    IdempotencyConflict,
    PersistenceUnavailable,
    UnroutableInboundCall,
)
from oron_dispatcher.sip_client import RealTelephonyDenied
from oron_dispatcher.twilio_inbound import CALLBACK_PATH, TwilioInboundHandler
from oron_dispatcher.webhook_ledger import PostgresWebhookLedger, WebhookLedger
from oron_dispatcher.webhook_pump import DurableDelivery, DurableWebhookPump

logger = logging.getLogger(__name__)
_MAX_WEBHOOK_BYTES = 262144


class WebhookReceiver(Protocol):
    def receive(self, body: str, auth_token: str) -> Any: ...


class OutboundCallRequest(BaseModel):
    phone_number: E164
    flow_id: UUID
    contact_id: UUID | None = None
    flow_version: int | None = Field(default=None, ge=1, strict=True)
    agent_version_id: UUID | None = None
    caller_gender: Literal["male", "female"] | None = None
    source_conversation_id: UUID | None = None
    handoff_id: UUID | None = None
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    explicit_approval: bool = False

    @model_validator(mode="after")
    def _cross_channel_binding_is_complete(self) -> OutboundCallRequest:
        references = (self.contact_id, self.source_conversation_id, self.handoff_id)
        if (self.source_conversation_id is not None or self.handoff_id is not None) and not all(
            value is not None for value in references
        ):
            raise ValueError(
                "contact_id, source_conversation_id and handoff_id must be supplied together"
            )
        return self


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
    ledger: WebhookLedger | PostgresWebhookLedger | None,
    assertion_verifier: ServiceAssertionVerifier | None,
    shutdown: Callable[[], Awaitable[None]] | None = None,
    participant_is_current: Callable[[Any], Awaitable[bool]] | None = None,
    twilio_inbound: TwilioInboundHandler | None = None,
) -> FastAPI:
    """Build the dispatcher HTTP boundary with injected process-owned state."""

    durable = ledger if isinstance(ledger, PostgresWebhookLedger) else None

    async def handle_durable(delivery: DurableDelivery) -> None:
        assert dispatcher is not None
        # Match WebhookReceiver's post-signature schema policy: Cloud can add
        # fields before this SDK knows them (for example roomEndReason). Keep
        # the original signed JSON in the ledger for collision checks/auditing.
        event = ParseDict(delivery.payload, WebhookEvent(), ignore_unknown_fields=True)
        if event.event == "participant_joined":
            if participant_is_current is None:
                raise RuntimeError("LiveKit participant liveness is not configured")
            if not await participant_is_current(event):
                return
            await dispatcher.handle_participant_joined(event)
        elif event.event == "room_finished":
            await dispatcher.handle_room_finished(event)

    pump = DurableWebhookPump(durable, handle_durable) if durable is not None else None

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if pump is not None and dispatcher is not None:
            pump.start()
        try:
            yield
        finally:
            try:
                if pump is not None:
                    await pump.close()
                if dispatcher is not None:
                    await dispatcher.drain()
            finally:
                if ledger is not None:
                    await ledger.close()
                if shutdown is not None:
                    await shutdown()

    app = FastAPI(title="Or-On Platform Dispatcher", version="0.1.0", lifespan=lifespan)
    bearer = HTTPBearer(auto_error=False)

    @app.post(CALLBACK_PATH, include_in_schema=False)
    async def twilio_voice_inbound(request: Request):
        if twilio_inbound is None:
            raise HTTPException(404, "not found")
        return await twilio_inbound.respond(request)

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
        ready = (
            report is not None
            and report.status == "ready"
            and report.persistence_ready
            and ledger_ready
            and (durable is None or participant_is_current is not None)
        )
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
        declared_length = request.headers.get("content-length")
        if declared_length is not None:
            if not declared_length.isascii() or not declared_length.isdecimal():
                raise HTTPException(status_code=400, detail="invalid content length")
            # Bound integer parsing as well as body buffering. Never trust a small
            # declaration: enforce the byte limit on every actual streamed chunk.
            if len(declared_length) > 20 or int(declared_length) > _MAX_WEBHOOK_BYTES:
                raise HTTPException(status_code=413, detail="webhook body is too large")
        raw = bytearray()
        async for chunk in request.stream():
            if len(chunk) > _MAX_WEBHOOK_BYTES - len(raw):
                raise HTTPException(status_code=413, detail="webhook body is too large")
            raw.extend(chunk)
        try:
            body = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise HTTPException(status_code=401, detail="invalid webhook body") from None
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

        if durable is not None:
            if pump is None or not pump.admitting or participant_is_current is None:
                raise HTTPException(
                    status_code=503, detail="durable webhook admission is not ready"
                )
            try:
                accepted = await durable.accept(
                    provider_event_id=provider_event_id, event_type=event_type, payload=payload
                )
            except Exception as exc:
                logger.warning(
                    "LiveKit durable accept failed", extra={"error_type": type(exc).__name__}
                )
                raise HTTPException(status_code=503, detail="webhook persistence failed") from None
            return WebhookAck(duplicate=not accepted.should_process)

        assert not isinstance(ledger, PostgresWebhookLedger)
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
        except AdmissionUnavailable:
            await ledger.quarantine(claim.event_id, "voice_admission_unavailable")
            return WebhookAck()
        except UnroutableInboundCall as unroutable:
            # Acknowledged so the provider stops redelivering, and durably
            # quarantined with a safe reason for reconciliation.
            logger.warning(
                "Quarantined unroutable inbound call", extra={"reason": unroutable.reason}
            )
            await ledger.quarantine(claim.event_id, unroutable.reason)
            return WebhookAck()
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
                flow_version=request.flow_version,
                agent_version_id=request.agent_version_id,
                idempotency_key=request.idempotency_key,
                explicit_approval=request.explicit_approval,
                caller_gender=request.caller_gender,
                contact_id=request.contact_id,
                source_conversation_id=request.source_conversation_id,
                handoff_id=request.handoff_id,
            )
        except IdempotencyConflict:
            raise HTTPException(
                status_code=409, detail="idempotency key is bound to different call parameters"
            ) from None
        except RealTelephonyDenied as exc:
            logger.warning(
                "Outbound voice routing denied",
                extra={"tenant_id": str(principal.tenant_id), "reason": str(exc)},
            )
            raise HTTPException(status_code=503, detail=str(exc)) from None
        except AgentStartupUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        except AdmissionUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        except PersistenceUnavailable:
            raise HTTPException(status_code=503, detail="call persistence is unavailable") from None

    return app
