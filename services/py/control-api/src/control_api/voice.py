"""Canonical read-only voice surface backed by retained Or-on sessions."""

from __future__ import annotations

import datetime as dt
from typing import Protocol
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from oron_common import Direction
from oron_db import make_engine, make_sessionmaker, set_tenant
from oron_sessions.models import Session, SessionStatus
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlmodel import col

from control_api.auth import (
    InvalidServiceAssertion,
    ServiceAssertionVerifier,
    ServicePrincipal,
)


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


class VoiceRepository(Protocol):
    async def list_sessions(self, principal: ServicePrincipal) -> list[VoiceSessionSummary]: ...

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

    return router
