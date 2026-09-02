"""Canonical read-only voice surface backed by retained Or-on sessions."""

from __future__ import annotations

import datetime as dt
from typing import Annotated, Any, Literal, Protocol, cast
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from oron_common import Direction
from oron_db import make_engine, make_sessionmaker, set_tenant
from oron_sessions.models import Session, SessionEvent, SessionStatus
from pydantic import BaseModel, Field
from sqlalchemy import bindparam, func, select, text
from sqlalchemy.dialects.postgresql import JSONB, insert
from sqlalchemy.exc import IntegrityError
from sqlmodel import col

from control_api.auth import (
    InvalidServiceAssertion,
    ServiceAssertionVerifier,
    ServicePrincipal,
)

_SESSION_TABLE = cast(Any, Session).__table__
_SESSION_EVENT_TABLE = cast(Any, SessionEvent).__table__


class VoiceSessionSummary(BaseModel):
    session_id: UUID
    contact_id: UUID | None
    platform_campaign_id: UUID | None
    provider: str
    direction: Direction
    status: SessionStatus
    answered: bool | None
    outcome: str | None
    created_at: dt.datetime
    ended_at: dt.datetime | None


class VoiceSessionList(BaseModel):
    items: list[VoiceSessionSummary]


class SimulatedCallRequest(BaseModel):
    contact_id: UUID
    idempotency_key: Annotated[
        str,
        Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$"),
    ]
    mode: Literal["simulator"] = "simulator"


class SimulatedCallResult(BaseModel):
    session: VoiceSessionSummary
    created: bool
    event_types: list[str]


class RealTelephonyDenied(RuntimeError):
    """A safe denial that contains no credentials or provider details."""


class SimulatedCallConflict(ValueError):
    """An idempotency key was reused for a different logical command."""


def require_real_telephony_authorization(*, enabled: bool, explicit_approval: bool) -> None:
    """Enforce both real-action gates before a future provider adapter is built."""

    if not enabled:
        raise RealTelephonyDenied("real telephony is disabled")
    if not explicit_approval:
        raise RealTelephonyDenied("real telephony requires explicit per-action approval")


class VoiceRepository(Protocol):
    async def list_sessions(self, principal: ServicePrincipal) -> list[VoiceSessionSummary]: ...

    async def simulate_call(
        self, principal: ServicePrincipal, command: SimulatedCallRequest
    ) -> SimulatedCallResult: ...

    async def close(self) -> None: ...


class PostgresVoiceRepository:
    """One role-scoped repository; every request sets transaction-local identity."""

    def __init__(self, database_url: str) -> None:
        normalized = database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
        self._engine = make_engine(normalized)
        self._sessionmaker = make_sessionmaker(self._engine)

    async def list_sessions(self, principal: ServicePrincipal) -> list[VoiceSessionSummary]:
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, principal.tenant_id)
            await database.execute(
                select(func.set_config("app.current_user", str(principal.user_id), True))
            )
            await database.execute(
                select(func.set_config("app.current_role", principal.role, True))
            )
            rows = list(
                (
                    await database.execute(
                        select(Session)
                        .order_by(col(Session.created_at).desc(), col(Session.session_id).desc())
                        .limit(50)
                    )
                ).scalars()
            )
            return [_summary(row) for row in rows]

    async def simulate_call(
        self, principal: ServicePrincipal, command: SimulatedCallRequest
    ) -> SimulatedCallResult:
        session_id = uuid5(
            NAMESPACE_URL,
            f"or-on-platform:voice-simulator:{principal.tenant_id}:{command.idempotency_key}",
        )
        now = dt.datetime.now(dt.UTC)
        event_payloads: tuple[tuple[str, dict[str, object]], ...] = (
            ("voice.call.requested.v1", {"mode": "simulator"}),
            ("voice.call.started.v1", {"mode": "simulator"}),
            ("voice.call.answered.v1", {"answered": True}),
            (
                "voice.call.transcript.updated.v1",
                {"text": "Fictional simulator transcript."},
            ),
            (
                "voice.call.outcome.recorded.v1",
                {"outcome": "simulator_completed"},
            ),
            ("voice.call.ended.v1", {"answered": True}),
        )
        async with self._sessionmaker() as database, database.begin():
            await set_tenant(database, principal.tenant_id)
            await database.execute(
                select(func.set_config("app.current_user", str(principal.user_id), True))
            )
            await database.execute(
                select(func.set_config("app.current_role", principal.role, True))
            )
            inserted = await database.execute(
                insert(_SESSION_TABLE)
                .values(
                    session_id=session_id,
                    tenant_id=principal.tenant_id,
                    provider="simulator",
                    direction=Direction.OUTBOUND,
                    room=f"simulator:{session_id}",
                    flow_id=UUID(int=0),
                    status=SessionStatus.ENDED,
                    answered=True,
                    outcome="simulator_completed",
                    ended_at=now,
                    contact_id=command.contact_id,
                    initiated_by_user_id=principal.user_id,
                    provider_call_id=f"simulator:{session_id}",
                    idempotency_key=command.idempotency_key,
                    call_seconds=12.0,
                    carrier="",
                    llm_model="simulator",
                    tts_model="simulator",
                    stt_audio_seconds=12.0,
                )
                .on_conflict_do_nothing(index_elements=[_SESSION_TABLE.c.session_id])
                .returning(_SESSION_TABLE.c.session_id)
            )
            created = inserted.scalar_one_or_none() is not None
            if created:
                await database.execute(
                    insert(_SESSION_EVENT_TABLE),
                    [
                        {
                            "id": uuid5(
                                NAMESPACE_URL,
                                f"or-on-platform:voice-event:{session_id}:{sequence}",
                            ),
                            "tenant_id": principal.tenant_id,
                            "session_id": session_id,
                            "sequence": sequence,
                            "event_type": event_type,
                            "version": 1,
                            "provider": "simulator",
                            "idempotency_key": f"{command.idempotency_key}:{sequence}",
                            "payload": payload,
                            "occurred_at": now + dt.timedelta(milliseconds=sequence),
                        }
                        for sequence, (event_type, payload) in enumerate(event_payloads)
                    ],
                )
                outbox_statement = text(
                    """
                    INSERT INTO ops.outbox_events
                      (tenant_id, event_type, aggregate_type, aggregate_id, payload)
                    VALUES (:tenant_id, :event_type, 'voice_session', :session_id, :payload)
                    """
                ).bindparams(bindparam("payload", type_=JSONB))
                await database.execute(
                    outbox_statement,
                    [
                        {
                            "tenant_id": principal.tenant_id,
                            "event_type": event_type,
                            "session_id": session_id,
                            "payload": {"session_id": str(session_id), **payload},
                        }
                        for event_type, payload in event_payloads
                    ],
                )
                audit_statement = text(
                    """
                    INSERT INTO audit.records
                      (tenant_id, actor_user_id, action, target_type, target_id,
                       request_id, metadata)
                    VALUES (:tenant_id, :actor_user_id, 'voice.simulated_call.completed',
                            'voice_session', :session_id, :request_id, :metadata)
                    """
                ).bindparams(bindparam("metadata", type_=JSONB))
                await database.execute(
                    audit_statement,
                    {
                        "tenant_id": principal.tenant_id,
                        "actor_user_id": principal.user_id,
                        "session_id": session_id,
                        "request_id": command.idempotency_key,
                        "metadata": {"provider": "simulator"},
                    },
                )
            row = (
                await database.execute(select(Session).where(col(Session.session_id) == session_id))
            ).scalar_one()
            if row.contact_id != command.contact_id:
                raise SimulatedCallConflict(
                    "idempotency key is already bound to another simulated call"
                )
            return SimulatedCallResult(
                session=_summary(row),
                created=created,
                event_types=[event_type for event_type, _ in event_payloads],
            )

    async def close(self) -> None:
        await self._engine.dispose()


def _summary(row: Session) -> VoiceSessionSummary:
    if row.created_at is None:
        raise RuntimeError("persisted session is missing created_at")
    return VoiceSessionSummary(
        session_id=row.session_id,
        contact_id=row.contact_id,
        platform_campaign_id=row.platform_campaign_id,
        provider=row.provider,
        direction=row.direction,
        status=row.status,
        answered=row.answered,
        outcome=row.outcome,
        created_at=row.created_at,
        ended_at=row.ended_at,
    )


def create_voice_router(
    repository: VoiceRepository | None,
    verifier: ServiceAssertionVerifier | None,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/voice", tags=["voice"])
    bearer = HTTPBearer(auto_error=False)

    async def require_voice_read(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    ) -> ServicePrincipal:
        if repository is None or verifier is None:
            raise HTTPException(status_code=503, detail="voice API is not configured")
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="authentication required")
        try:
            principal = verifier.verify(credentials.credentials)
        except InvalidServiceAssertion:
            raise HTTPException(status_code=401, detail="invalid service assertion") from None
        if principal.capability not in {"voice:read", "voice:write"}:
            raise HTTPException(status_code=403, detail="voice capability required")
        return principal

    async def require_voice_write(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    ) -> ServicePrincipal:
        principal = await require_voice_read(credentials)
        if principal.capability != "voice:write":
            raise HTTPException(status_code=403, detail="voice write capability required")
        return principal

    async def configured_repository() -> VoiceRepository:
        if repository is None:
            raise HTTPException(status_code=503, detail="voice API is not configured")
        return repository

    @router.get(
        "/sessions",
        response_model=VoiceSessionList,
        operation_id="list_voice_sessions",
    )
    async def list_voice_sessions(
        principal: ServicePrincipal = Depends(require_voice_read),
        store: VoiceRepository = Depends(configured_repository),
    ) -> VoiceSessionList:
        return VoiceSessionList(items=await store.list_sessions(principal))

    @router.post(
        "/simulated-calls",
        response_model=SimulatedCallResult,
        operation_id="simulate_voice_call",
    )
    async def simulate_voice_call(
        command: SimulatedCallRequest,
        principal: ServicePrincipal = Depends(require_voice_write),
        store: VoiceRepository = Depends(configured_repository),
    ) -> SimulatedCallResult:
        try:
            return await store.simulate_call(principal, command)
        except (IntegrityError, SimulatedCallConflict) as error:
            # Foreign-key and persistence failures remain an opaque service
            # response; neither contact data nor database details cross the API.
            raise HTTPException(
                status_code=409, detail="simulated call could not be created"
            ) from error

    return router
