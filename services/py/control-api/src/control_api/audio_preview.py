"""Explicit paid TTS preview; no transcript, storage, or provider work in a transaction."""

import asyncio
import base64
import unicodedata
from typing import Annotated, Any, Literal, Protocol
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from oron_db import set_tenant
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import text

from control_api.auth import InvalidServiceAssertion, ServiceAssertionVerifier, ServicePrincipal


def published_voice_quality(
    raw_quality: object, locale: object, *, configured: bool
) -> dict[str, Any] | None:
    """Resolve the same locale-aware legacy default used by the CRM editor.

    Older published versions predate the structured quality editor. They are
    still valid runtime versions, so an absent quality key must not make an
    authorized preview or typed evaluation disappear. An explicitly supplied
    malformed value remains invalid rather than being silently repaired.
    """
    if configured:
        return raw_quality if isinstance(raw_quality, dict) else None
    language = "he" if isinstance(locale, str) and locale.lower().startswith("he") else "en"
    return {"schemaVersion": "1.0", "language": language}


class AudioPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent_id: UUID
    version_id: UUID
    text: Annotated[str, Field(min_length=1, max_length=300)]
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def explicit_confirmation(cls, value: object) -> bool:
        if value is not True:
            raise ValueError("explicit confirmation is required")
        return True

    @field_validator("text")
    @classmethod
    def plain_text(cls, value: str) -> str:
        if not value.strip() or any(unicodedata.category(c).startswith("C") for c in value):
            raise ValueError("preview text must be bounded plain text")
        if any(c in value for c in "<>{}[]"):
            raise ValueError("preview text must not contain markup")
        return value.strip()


class AudioPreviewResult(BaseModel):
    request_id: UUID
    agent_id: UUID
    version_id: UUID
    audio_base64: str
    media_type: Literal["audio/wav"] = "audio/wav"
    provider: str
    model: str
    voice: str
    duration_seconds: float
    canonical_text: str
    speech_normalized_text: str
    expires_in_seconds: Literal[60] = 60
    evaluation_kind: Literal["paid_tts_preview"] = "paid_tts_preview"


class PreviewAudio(Protocol):
    audio: bytes
    provider: str
    model: str
    voice: str
    duration_seconds: float
    canonical_text: str
    speech_normalized_text: str


class PreviewProvider(Protocol):
    async def synthesize(
        self, text: str, quality: dict[str, Any], *, confirmed: bool
    ) -> PreviewAudio: ...


class PreviewRepository(Protocol):
    async def load_audio_preview_quality(
        self, principal: ServicePrincipal, agent_id: UUID, version_id: UUID
    ) -> dict[str, Any] | None: ...

    async def audit_audio_preview(
        self, principal: ServicePrincipal, version_id: UUID, request_id: UUID, status: str
    ) -> None: ...


class PostgresAudioPreviewRepository:
    def __init__(self, session_factory: Any) -> None:
        self._session_factory = session_factory

    async def _scope(self, database: Any, principal: ServicePrincipal) -> None:
        await set_tenant(database, principal.tenant_id)
        await database.execute(
            text(
                "SELECT set_config('app.current_user',:actor,true), "
                "set_config('app.current_role',:role,true)"
            ),
            {"actor": str(principal.user_id), "role": principal.role},
        )

    async def load_audio_preview_quality(
        self, principal: ServicePrincipal, agent_id: UUID, version_id: UUID
    ) -> dict[str, Any] | None:
        async with self._session_factory() as database, database.begin():
            await self._scope(database, principal)
            row = (
                (
                    await database.execute(
                        text("""
                SELECT version.channel_configuration->'quality' AS quality,
                       version.channel_configuration ? 'quality' AS quality_configured,
                       version.locale
                FROM agents.agent_profile_versions version
                JOIN agents.agent_profiles profile ON profile.id=version.agent_profile_id
                  AND profile.tenant_id=version.tenant_id
                  AND profile.archived_at IS NULL
                WHERE version.id=:version AND profile.id=:agent
                  AND version.tenant_id=:tenant AND 'voice'=ANY(version.channel_capabilities)
                  AND version.published_at IS NOT NULL AND version.validation_status='valid'
                  AND platform.canonical_actor_authorized()
            """),
                        {"version": version_id, "agent": agent_id, "tenant": principal.tenant_id},
                    )
                )
                .mappings()
                .one_or_none()
            )
            if row is None:
                return None
            return published_voice_quality(
                row["quality"], row["locale"], configured=row["quality_configured"] is True
            )

    async def audit_audio_preview(
        self, principal: ServicePrincipal, version_id: UUID, request_id: UUID, status: str
    ) -> None:
        async with self._session_factory() as database, database.begin():
            await self._scope(database, principal)
            await database.execute(
                text("""
                INSERT INTO audit.records
                  (tenant_id,actor_user_id,action,target_type,target_id,metadata)
                VALUES (:tenant,:actor,'agent.audio_preview','agent_version',:version,
                  jsonb_build_object('requestId',CAST(:request AS text),
                    'status',CAST(:status AS text)))
            """),
                {
                    "tenant": principal.tenant_id,
                    "actor": principal.user_id,
                    "version": version_id,
                    "request": str(request_id),
                    "status": status,
                },
            )


class AudioPreviewService:
    """Process-owned admission cap; disabled until the existing voice flag is enabled."""

    def __init__(
        self,
        repository: PreviewRepository,
        *,
        enabled: bool,
        provider: PreviewProvider | None = None,
        admission: set[UUID] | None = None,
        timeout_seconds: float = 15,
    ) -> None:
        self._repository = repository
        self._enabled = enabled
        self._provider = provider
        self._timeout = timeout_seconds
        self._active: set[UUID] = admission if admission is not None else set()

    async def preview(
        self, principal: ServicePrincipal, command: AudioPreviewRequest
    ) -> AudioPreviewResult:
        if not self._enabled:
            raise HTTPException(503, "audio preview providers are disabled")
        if principal.tenant_id in self._active or len(self._active) >= 2:
            raise HTTPException(429, "audio preview is busy; retry later")
        self._active.add(principal.tenant_id)
        request_id = uuid4()
        started = False
        release_admission = True
        try:
            quality = await self._repository.load_audio_preview_quality(
                principal, command.agent_id, command.version_id
            )
            if quality is None:
                raise HTTPException(404, "published agent version not available")
            await self._repository.audit_audio_preview(
                principal, command.version_id, request_id, "started"
            )
            started = True
            if self._provider is None:
                # Optional existing runtime: core API startup never imports voice SDKs.
                from oron_agent.audio_preview import RealPreviewProvider

                self._provider = RealPreviewProvider()
            async with asyncio.timeout(self._timeout):
                audio = await self._provider.synthesize(
                    command.text, quality, confirmed=command.confirmed
                )
            if not 44 < len(audio.audio) <= 2_000_000 or not audio.audio.startswith(b"RIFF"):
                raise ValueError("invalid preview audio")
            # Revoked manager/version access must not release an already generated clip.
            if (
                await self._repository.load_audio_preview_quality(
                    principal, command.agent_id, command.version_id
                )
                is None
            ):
                raise HTTPException(403, "audio preview access changed")
            await self._repository.audit_audio_preview(
                principal, command.version_id, request_id, "succeeded"
            )
            return AudioPreviewResult(
                request_id=request_id,
                agent_id=command.agent_id,
                version_id=command.version_id,
                audio_base64=base64.b64encode(audio.audio).decode("ascii"),
                provider=audio.provider,
                model=audio.model,
                voice=audio.voice,
                duration_seconds=audio.duration_seconds,
                canonical_text=audio.canonical_text,
                speech_normalized_text=audio.speech_normalized_text,
            )
        except asyncio.CancelledError:
            if started:
                await self._repository.audit_audio_preview(
                    principal, command.version_id, request_id, "cancelled"
                )
            raise
        except Exception as error:
            if getattr(error, "provider_work_may_continue", False):
                release_admission = False
            if started:
                await self._repository.audit_audio_preview(
                    principal, command.version_id, request_id, "failed"
                )
            if isinstance(error, HTTPException):
                raise
            if isinstance(error, TimeoutError):
                raise HTTPException(504, "audio preview timed out") from None
            raise HTTPException(503, "audio preview is unavailable") from None
        finally:
            if release_admission:
                self._active.discard(principal.tenant_id)


def create_audio_preview_router(
    service: AudioPreviewService | None, verifier: ServiceAssertionVerifier | None
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/orchestration/agents", tags=["orchestration"])
    bearer = HTTPBearer(auto_error=False)

    async def authorized(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    ) -> ServicePrincipal:
        if verifier is None or service is None:
            raise HTTPException(503, "audio preview is not configured")
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(401, "authentication required")
        try:
            principal = verifier.verify(credentials.credentials)
        except InvalidServiceAssertion:
            raise HTTPException(401, "invalid service assertion") from None
        if principal.capability != "orchestration:write":
            raise HTTPException(403, "orchestration write capability required")
        return principal

    @router.post(
        "/audio-preview", response_model=AudioPreviewResult, operation_id="preview_agent_audio"
    )
    async def preview_agent_audio(
        command: AudioPreviewRequest,
        request: Request,
        response: Response,
        principal: Annotated[ServicePrincipal, Depends(authorized)],
    ) -> AudioPreviewResult:
        response.headers["Cache-Control"] = "private, no-store"
        assert service is not None
        finished = asyncio.Event()

        async def disconnected() -> None:
            while not finished.is_set():
                if await request.is_disconnected():
                    return
                await asyncio.sleep(0.1)

        synthesis = asyncio.create_task(service.preview(principal, command))
        watcher = asyncio.create_task(disconnected())
        try:
            done, _ = await asyncio.wait({synthesis, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if watcher in done:
                raise HTTPException(499, "audio preview cancelled")
            return await synthesis
        finally:
            finished.set()
            synthesis.cancel()
            watcher.cancel()
            await asyncio.gather(synthesis, watcher, return_exceptions=True)

    return router
