"""Permission-checked paid typed evaluation; raw model output never crosses this API."""

import asyncio
from time import perf_counter
from typing import Annotated, Any, Literal, Protocol
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import text

from control_api.audio_preview import (
    AudioPreviewRequest,
    PostgresAudioPreviewRepository,
    published_voice_quality,
)
from control_api.auth import InvalidServiceAssertion, ServiceAssertionVerifier, ServicePrincipal


class AgentProviderEvaluationRequest(AudioPreviewRequest):
    text: Annotated[str, Field(min_length=1, max_length=1000)]


class AgentEvaluationSource(BaseModel):
    source_id: UUID
    document_id: UUID
    version: int
    fact_key: str


class AgentProviderEvaluationResult(BaseModel):
    request_id: UUID
    agent_id: UUID
    version_id: UUID
    evaluation_kind: Literal["paid_typed_llm"] = "paid_typed_llm"
    accepted_text: str
    recognized_text: None = None
    response: str
    decision: str
    sources: list[AgentEvaluationSource]
    model_ms: float
    validation_ms: float
    provider: str
    model: str
    cost_usd: None = None
    actions_executed: Literal[False] = False


class EvaluationRepository(Protocol):
    async def load_evaluation_context(
        self, principal: ServicePrincipal, agent_id: UUID, version_id: UUID
    ) -> dict[str, Any] | None: ...
    async def audit_evaluation(
        self, principal: ServicePrincipal, version_id: UUID, request_id: UUID, status: str
    ) -> None: ...


class GeneratedSelection(Protocol):
    @property
    def selection(self) -> str: ...
    @property
    def provider(self) -> str: ...
    @property
    def model(self) -> str: ...


class EvaluationProvider(Protocol):
    async def evaluate(
        self, text: str, context: dict[str, Any], tenant_id: str, *, confirmed: bool
    ) -> GeneratedSelection: ...


class PostgresAgentEvaluationRepository(PostgresAudioPreviewRepository):
    async def load_evaluation_context(
        self, principal: ServicePrincipal, agent_id: UUID, version_id: UUID
    ) -> dict[str, Any] | None:
        async with self._session_factory() as database, database.begin():
            await self._scope(database, principal)
            row = (
                (
                    await database.execute(
                        text("""
                SELECT system_prompt,channel_configuration->'quality' AS quality,
                       channel_configuration ? 'quality' AS quality_configured,
                       locale
                FROM agents.agent_profile_versions
                WHERE id=:version AND agent_profile_id=:agent AND tenant_id=:tenant
                  AND published_at IS NOT NULL AND validation_status='valid'
                  AND 'voice'=ANY(channel_capabilities) AND platform.canonical_actor_authorized()
            """),
                        {"version": version_id, "agent": agent_id, "tenant": principal.tenant_id},
                    )
                )
                .mappings()
                .one_or_none()
            )
            if row is None:
                return None
            quality = published_voice_quality(
                row["quality"], row["locale"], configured=row["quality_configured"] is True
            )
            if quality is None:
                return None
            documents = (
                (
                    await database.execute(
                        text("""
                SELECT source.id AS source_id,document.id AS document_id,
                       document.version,document.metadata
                FROM agents.agent_profile_versions agent
                JOIN agents.knowledge_sources source ON source.tenant_id=agent.tenant_id
                  AND (agent.knowledge_configuration->'sourceIds') ? source.id::text
                JOIN LATERAL (
                  SELECT d.* FROM agents.knowledge_documents d
                  WHERE d.source_id=source.id AND d.tenant_id=source.tenant_id
                    AND d.published_at IS NOT NULL ORDER BY d.version DESC LIMIT 1
                ) document ON TRUE
                WHERE agent.id=:version AND agent.tenant_id=:tenant
                  AND agent.knowledge_configuration->>'schemaVersion'='1.0'
                  AND jsonb_typeof(agent.knowledge_configuration->'sourceIds')='array'
                  AND source.status='published' AND document.revoked_at IS NULL
                  AND document.valid_from<=CURRENT_TIMESTAMP
                  AND (document.valid_until IS NULL OR document.valid_until>CURRENT_TIMESTAMP)
                ORDER BY source.id
            """),
                        {"version": version_id, "tenant": principal.tenant_id},
                    )
                )
                .mappings()
                .all()
            )
            return {
                "system_prompt": row["system_prompt"],
                "quality": quality,
                "knowledge": [
                    {
                        "tenantId": str(principal.tenant_id),
                        "sourceId": str(doc["source_id"]),
                        "documentId": str(doc["document_id"]),
                        "version": doc["version"],
                        "facts": doc["metadata"].get("facts", [])
                        if isinstance(doc["metadata"], dict)
                        and doc["metadata"].get("schemaVersion") == "1.0"
                        else [],
                    }
                    for doc in documents
                ],
            }

    async def audit_evaluation(
        self, principal: ServicePrincipal, version_id: UUID, request_id: UUID, status: str
    ) -> None:
        async with self._session_factory() as database, database.begin():
            await self._scope(database, principal)
            await database.execute(
                text("""
                INSERT INTO audit.records
                  (tenant_id,actor_user_id,action,target_type,target_id,metadata)
                VALUES (:tenant,:actor,'agent.provider_evaluation','agent_version',:version,
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


class AgentEvaluationService:
    def __init__(
        self,
        repository: EvaluationRepository,
        *,
        enabled: bool,
        provider: EvaluationProvider | None = None,
        admission: set[UUID] | None = None,
        timeout_seconds: float = 10,
    ) -> None:
        self._repository = repository
        self._enabled = enabled
        self._provider = provider
        self._active = admission if admission is not None else set()
        self._timeout = timeout_seconds

    async def evaluate(
        self, principal: ServicePrincipal, command: AgentProviderEvaluationRequest
    ) -> AgentProviderEvaluationResult:
        if not self._enabled:
            raise HTTPException(503, "evaluation providers are disabled")
        if principal.tenant_id in self._active or len(self._active) >= 2:
            raise HTTPException(429, "provider evaluation is busy; retry later")
        self._active.add(principal.tenant_id)
        request_id = uuid4()
        started = False
        try:
            context = await self._repository.load_evaluation_context(
                principal, command.agent_id, command.version_id
            )
            if context is None:
                raise HTTPException(404, "published agent version not available")
            await self._repository.audit_evaluation(
                principal, command.version_id, request_id, "started"
            )
            started = True
            from oron_agent.agent_evaluation import RealEvaluationProvider, render_evaluation

            if self._provider is None:
                self._provider = RealEvaluationProvider()
            model_started = perf_counter()
            async with asyncio.timeout(self._timeout):
                output = await self._provider.evaluate(
                    command.text, context, str(principal.tenant_id), confirmed=command.confirmed
                )
            model_ms = (perf_counter() - model_started) * 1000
            validation_started = perf_counter()
            fresh = await self._repository.load_evaluation_context(
                principal, command.agent_id, command.version_id
            )
            if fresh is None:
                raise HTTPException(403, "evaluation access changed")
            reply = render_evaluation(
                output.selection,
                fresh,
                str(principal.tenant_id),
                caller_text=command.text,
            )
            evidence = reply.evidence
            sources = (
                [
                    AgentEvaluationSource.model_validate(
                        {
                            "source_id": evidence["sourceId"],
                            "document_id": evidence["documentId"],
                            "version": evidence["version"],
                            "fact_key": evidence["factKey"],
                        }
                    )
                ]
                if evidence
                else []
            )
            result = AgentProviderEvaluationResult(
                request_id=request_id,
                agent_id=command.agent_id,
                version_id=command.version_id,
                accepted_text=command.text,
                response=reply.text,
                decision=reply.decision,
                sources=sources,
                model_ms=model_ms,
                validation_ms=(perf_counter() - validation_started) * 1000,
                provider=output.provider,
                model=output.model,
            )
            await self._repository.audit_evaluation(
                principal, command.version_id, request_id, "succeeded"
            )
            return result
        except asyncio.CancelledError:
            if started:
                await self._repository.audit_evaluation(
                    principal, command.version_id, request_id, "cancelled"
                )
            raise
        except Exception as error:
            if started:
                await self._repository.audit_evaluation(
                    principal, command.version_id, request_id, "failed"
                )
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(
                504 if isinstance(error, TimeoutError) else 503, "provider evaluation unavailable"
            ) from None
        finally:
            self._active.discard(principal.tenant_id)


def create_agent_evaluation_router(
    service: AgentEvaluationService | None, verifier: ServiceAssertionVerifier | None
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/orchestration/agents", tags=["orchestration"])
    bearer = HTTPBearer(auto_error=False)

    async def authorized(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    ) -> ServicePrincipal:
        if verifier is None or service is None:
            raise HTTPException(503, "evaluation is not configured")
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
        "/provider-evaluate",
        response_model=AgentProviderEvaluationResult,
        operation_id="evaluate_agent_provider",
    )
    async def evaluate_agent_provider(
        command: AgentProviderEvaluationRequest,
        request: Request,
        response: Response,
        principal: Annotated[ServicePrincipal, Depends(authorized)],
    ) -> AgentProviderEvaluationResult:
        response.headers["Cache-Control"] = "private, no-store"
        assert service is not None
        finished = asyncio.Event()

        async def disconnected():
            while not finished.is_set():
                if await request.is_disconnected():
                    return
                await asyncio.sleep(0.1)

        operation = asyncio.create_task(service.evaluate(principal, command))
        watcher = asyncio.create_task(disconnected())
        try:
            done, _ = await asyncio.wait({operation, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if watcher in done:
                raise HTTPException(499, "evaluation cancelled")
            return await operation
        finally:
            finished.set()
            operation.cancel()
            watcher.cancel()
            await asyncio.gather(operation, watcher, return_exceptions=True)

    return router
