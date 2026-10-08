"""Read-only authoring inspection using the runtime's pure voice compiler."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from oron_common.voice_instructions import (
    compose_voice_instruction_snapshot,
    support_profile_from_database,
)
from oron_db import set_tenant
from oron_flows.graph import FlowSpec
from pydantic import BaseModel
from sqlalchemy import text

from control_api.auth import InvalidServiceAssertion, ServiceAssertionVerifier, ServicePrincipal


class EffectivePromptResult(BaseModel):
    text: str
    blocks: list[dict[str, Any]]
    hash: str
    hashScope: str
    compositionVersion: str
    characterCount: int
    scriptedOpening: dict[str, Any] | None = None
    exclusions: list[str]


class PostgresEffectivePromptRepository:
    def __init__(self, session_factory: Any) -> None:
        self._sessions = session_factory

    async def inspect(
        self,
        principal: ServicePrincipal,
        agent_id: UUID,
        version_id: UUID,
        flow_id: UUID | None,
        flow_version: int | None,
        node_id: str | None,
    ) -> EffectivePromptResult | None:
        async with self._sessions() as db, db.begin():
            await set_tenant(db, principal.tenant_id)
            await db.execute(
                text(
                    "SELECT set_config('app.current_user',:actor,true), "
                    "set_config('app.current_role',:role,true)"
                ),
                {"actor": str(principal.user_id), "role": principal.role},
            )
            row = (
                (
                    await db.execute(
                        text("""
                SELECT v.system_prompt, v.channel_configuration
                FROM agents.agent_profile_versions v
                JOIN agents.agent_profiles p ON p.id=v.agent_profile_id AND p.tenant_id=v.tenant_id
                WHERE v.tenant_id=:tenant AND p.id=:agent AND v.id=:version
                  AND p.archived_at IS NULL AND 'voice'=ANY(v.channel_capabilities)
                  AND platform.canonical_actor_authorized()
            """),
                        {"tenant": principal.tenant_id, "agent": agent_id, "version": version_id},
                    )
                )
                .mappings()
                .one_or_none()
            )
            if row is None:
                return None
            raw = (
                await db.execute(text("SELECT platform.current_voice_tenant_support_profile()"))
            ).scalar_one_or_none()
            if not isinstance(raw, dict):
                raise HTTPException(409, "tenant support profile unavailable")
            profile = support_profile_from_database(
                raw.get("supportProfile"),
                tenant_name=str(raw["tenantName"]),
                display_name=raw.get("displayName"),
                business_name=raw.get("businessName"),
                locale=str(raw.get("locale") or "en"),
                timezone=str(raw.get("timezone") or "UTC"),
            )
            configuration = row["channel_configuration"] or {}
            prompt = configuration.get("voiceInstructions") or row["system_prompt"]
            node_instruction = None
            opening = None
            if flow_id is not None:
                retained = (
                    await db.execute(
                        text("""
                    SELECT spec FROM public.flows
                    WHERE tenant_id=:tenant AND flow_id=:flow AND version=:version
                """),
                        {"tenant": principal.tenant_id, "flow": flow_id, "version": flow_version},
                    )
                ).scalar_one_or_none()
                if retained is None:
                    return None
                spec = FlowSpec.model_validate(retained)
                selected = next((n for n in spec.nodes if n.name == (node_id or spec.entry)), None)
                if selected is None:
                    raise HTTPException(400, "unknown retained node")
                node_instruction = selected.role_message
                says = [
                    a.text for a in selected.pre_actions if a.type.value == "tts_say" and a.text
                ]
                if says:
                    opening = {
                        "text": "\n".join(says),
                        "source": "retained-node-pre-actions",
                        "flowId": str(flow_id),
                        "flowVersion": flow_version,
                        "nodeId": selected.name,
                    }
            elif node_id is not None:
                raise HTTPException(400, "node selection requires a retained flow")
            snapshot = compose_voice_instruction_snapshot(
                profile,
                agent_prompt=prompt,
                persona_gender="female",
                agent_role_title=configuration.get("roleTitle"),
                node_instruction=node_instruction,
            )
            return EffectivePromptResult(
                **snapshot,
                scriptedOpening=opening,
                exclusions=[
                    "Empty interaction authoring preview; not a customer request replay.",
                    "History, customer data, retrieved knowledge and tool results are excluded.",
                    "Dynamic fields, tools, task messages and locale changes are excluded.",
                ],
            )


def create_effective_prompt_router(
    repository: PostgresEffectivePromptRepository | None,
    verifier: ServiceAssertionVerifier | None,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/orchestration/agents", tags=["orchestration"])
    bearer = HTTPBearer(auto_error=False)

    async def authorized(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    ) -> ServicePrincipal:
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(401, "authentication required")
        if repository is None or verifier is None:
            raise HTTPException(503, "effective prompt inspection unavailable")
        try:
            principal = verifier.verify(credentials.credentials)
        except InvalidServiceAssertion:
            raise HTTPException(401, "invalid service assertion") from None
        if principal.capability != "orchestration:read":
            raise HTTPException(403, "orchestration read capability required")
        return principal

    @router.get(
        "/{agent_id}/versions/{version_id}/effective-prompt",
        response_model=EffectivePromptResult,
        operation_id="get_agent_effective_prompt",
    )
    async def inspect_prompt(
        agent_id: UUID,
        version_id: UUID,
        response: Response,
        principal: Annotated[ServicePrincipal, Depends(authorized)],
        flow_id: UUID | None = None,
        flow_version: int | None = None,
        node_id: str | None = None,
    ) -> EffectivePromptResult:
        if (flow_id is None) != (flow_version is None) or (
            flow_version is not None and flow_version < 1
        ):
            raise HTTPException(
                400, "exact retained flow id and positive version must be selected together"
            )
        response.headers["Cache-Control"] = "private, no-store"
        assert repository is not None
        result = await repository.inspect(
            principal, agent_id, version_id, flow_id, flow_version, node_id
        )
        if result is None:
            raise HTTPException(404, "configuration not found")
        return result

    return router
