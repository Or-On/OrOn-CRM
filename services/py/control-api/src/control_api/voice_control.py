"""Tenant-authorized AI pause/resume commands, never a human-connection claim."""

from datetime import UTC, datetime
from typing import Annotated, Literal, Protocol
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from oron_db import set_tenant
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from control_api.auth import InvalidServiceAssertion, ServiceAssertionVerifier, ServicePrincipal


class VoiceControlCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["paused", "ai"]
    expected_epoch: int = Field(ge=0, le=9007199254740990, strict=True)
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")


class VoiceControlStatus(BaseModel):
    session_id: UUID
    epoch: int
    desired_mode: Literal["ai", "paused"]
    acknowledged_epoch: int | None = None
    worker_mode: Literal["ai", "paused"] | None = None
    acknowledged_at: datetime | None = None
    command_id: UUID | None = None
    status: Literal["pending", "applied", "worker_unavailable"]
    active: bool
    can_operate: bool
    resume_required: bool = False
    human_connection: Literal["not_managed"] = "not_managed"


class VoiceControlRepository(Protocol):
    async def get(self, principal: ServicePrincipal, session_id: UUID) -> VoiceControlStatus: ...

    async def command(
        self, principal: ServicePrincipal, session_id: UUID, command: VoiceControlCommand
    ) -> VoiceControlStatus: ...


class PostgresVoiceControlRepository:
    """Shares the existing voice repository pool; every call owns its transaction."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]):
        self._sessionmaker = sessionmaker

    async def _scope(self, database: AsyncSession, principal: ServicePrincipal) -> None:
        await set_tenant(database, principal.tenant_id)
        await database.execute(
            text("SELECT set_config('app.current_user',:actor,true)"),
            {"actor": str(principal.user_id)},
        )
        allowed = await database.scalar(
            text("SELECT platform.voice_control_actor_allowed(:actor,false)"),
            {"actor": principal.user_id},
        )
        if not allowed:
            raise HTTPException(status_code=403, detail="voice control access is unavailable")

    async def _status(
        self, database: AsyncSession, principal: ServicePrincipal, session_id: UUID
    ) -> VoiceControlStatus:
        row = (
            (
                await database.execute(
                    text("""
                SELECT s.session_id,
                  s.status='started' AND s.ended_at IS NULL AND s.provider='livekit' AS active,
                  COALESCE(c.epoch,0) AS epoch,COALESCE(c.desired_mode,'ai') AS desired_mode,
                  c.acknowledged_epoch,c.worker_mode,c.acknowledged_at,c.command_id,
                  COALESCE(cmd.requested_at,s.created_at) AS requested_at,
                  platform.voice_control_actor_allowed(:actor,true) AS can_operate,
                  c.requested_by_user_id IS NULL OR
                    platform.voice_control_actor_allowed(c.requested_by_user_id,true)
                    AS resume_authorized
                FROM public.sessions s LEFT JOIN public.voice_session_controls c
                  ON c.session_id=s.session_id AND c.tenant_id=s.tenant_id
                LEFT JOIN public.voice_session_control_commands cmd
                  ON cmd.id=c.command_id AND cmd.tenant_id=s.tenant_id
                WHERE s.session_id=:session AND s.tenant_id=:tenant
                """),
                    {
                        "session": session_id,
                        "tenant": principal.tenant_id,
                        "actor": principal.user_id,
                    },
                )
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            raise HTTPException(status_code=404, detail="voice session not found")
        ack = row["acknowledged_at"]
        now = datetime.now(UTC)
        fresh = ack is not None and 0 <= (now - ack).total_seconds() <= 5
        applied = (
            fresh
            and row["acknowledged_epoch"] == row["epoch"]
            and row["worker_mode"] == row["desired_mode"]
        )
        unavailable = not row["active"] or (
            not fresh and (now - row["requested_at"]).total_seconds() > 5
        )
        return VoiceControlStatus(
            session_id=session_id,
            epoch=row["epoch"],
            desired_mode=row["desired_mode"],
            acknowledged_epoch=row["acknowledged_epoch"],
            worker_mode=row["worker_mode"],
            acknowledged_at=ack,
            command_id=row["command_id"],
            active=row["active"],
            can_operate=row["can_operate"]
            and principal.capability in {"voice:read", "voice:write"},
            resume_required=not row["resume_authorized"]
            or (row["desired_mode"] == "ai" and row["worker_mode"] == "paused"),
            status="worker_unavailable" if unavailable else "applied" if applied else "pending",
        )

    async def get(self, principal: ServicePrincipal, session_id: UUID) -> VoiceControlStatus:
        async with self._sessionmaker() as database, database.begin():
            await self._scope(database, principal)
            return await self._status(database, principal, session_id)

    async def command(
        self, principal: ServicePrincipal, session_id: UUID, command: VoiceControlCommand
    ) -> VoiceControlStatus:
        async with self._sessionmaker() as database, database.begin():
            await self._scope(database, principal)
            try:
                await database.execute(
                    text("SELECT platform.request_voice_control(:session,:mode,:epoch,:key)"),
                    {
                        "session": session_id,
                        "mode": command.mode,
                        "epoch": command.expected_epoch,
                        "key": command.idempotency_key,
                    },
                )
            except DBAPIError as exc:
                state = getattr(exc.orig, "sqlstate", None)
                if state == "42501":
                    raise HTTPException(403, "voice control operator is unavailable") from None
                if state == "P0002":
                    raise HTTPException(404, "active voice session unavailable") from None
                if state == "23505":
                    raise HTTPException(
                        409, "voice control command conflicts; refresh status"
                    ) from None
                raise HTTPException(503, "voice control persistence is unavailable") from None
            return await self._status(database, principal, session_id)


def create_voice_control_router(
    repository: VoiceControlRepository | None,
    verifier: ServiceAssertionVerifier | None,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/voice", tags=["voice"])
    bearer = HTTPBearer(auto_error=False)

    async def authorized(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    ) -> ServicePrincipal:
        if repository is None or verifier is None:
            raise HTTPException(503, "voice control is not configured")
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(401, "authentication required")
        try:
            principal = verifier.verify(credentials.credentials)
        except InvalidServiceAssertion:
            raise HTTPException(401, "invalid service assertion") from None
        if principal.capability not in {"voice:read", "voice:write"}:
            raise HTTPException(403, "voice capability required")
        return principal

    @router.get(
        "/sessions/{session_id}/control",
        response_model=VoiceControlStatus,
        operation_id="get_voice_session_control",
    )
    async def get_control(
        session_id: UUID,
        principal: Annotated[ServicePrincipal, Depends(authorized)],
    ) -> VoiceControlStatus:
        assert repository is not None
        return await repository.get(principal, session_id)

    @router.post(
        "/sessions/{session_id}/control",
        response_model=VoiceControlStatus,
        operation_id="set_voice_session_control",
    )
    async def set_control(
        session_id: UUID,
        command: VoiceControlCommand,
        principal: Annotated[ServicePrincipal, Depends(authorized)],
    ) -> VoiceControlStatus:
        if principal.capability != "voice:write":
            raise HTTPException(403, "voice write capability required")
        assert repository is not None
        return await repository.command(principal, session_id, command)

    return router
