"""Canonical cross-channel flow contract and retained-engine adapter proof."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from control_api.auth import InvalidServiceAssertion, ServiceAssertionVerifier, ServicePrincipal

Channel = Literal["voice", "whatsapp"]
NodeType = Literal["start", "end", "message.send", "voice.call", "crm.update", "handoff"]


class CanonicalFlowNode(BaseModel):
    id: Annotated[str, Field(min_length=1, max_length=120)]
    type: NodeType
    configuration: dict[str, Any] = Field(default_factory=dict)


class CanonicalFlowEdge(BaseModel):
    id: Annotated[str, Field(min_length=1, max_length=120)]
    source: Annotated[str, Field(min_length=1, max_length=120)]
    target: Annotated[str, Field(min_length=1, max_length=120)]


class CanonicalFlowContract(BaseModel):
    schema_version: Literal["1.0"] = Field(alias="schemaVersion")
    channels: list[Channel]
    nodes: list[CanonicalFlowNode]
    edges: list[CanonicalFlowEdge]


class CompiledFlowAdapter(BaseModel):
    schema_version: str = Field(alias="schemaVersion")
    nodes: list[CanonicalFlowNode]
    edges: list[CanonicalFlowEdge]


class CanonicalFlowValidationResult(BaseModel):
    valid: bool
    errors: list[str]
    adapters: dict[Channel, CompiledFlowAdapter] | None = None


_NODE_CHANNELS: dict[NodeType, frozenset[Channel]] = {
    "start": frozenset(("voice", "whatsapp")),
    "end": frozenset(("voice", "whatsapp")),
    "message.send": frozenset(("whatsapp",)),
    "voice.call": frozenset(("voice",)),
    "crm.update": frozenset(("voice", "whatsapp")),
    "handoff": frozenset(("voice", "whatsapp")),
}


def validate_and_compile(flow: CanonicalFlowContract) -> CanonicalFlowValidationResult:
    errors: set[str] = set()
    channels = frozenset(flow.channels)
    if not channels:
        errors.add("at least one channel is required")
    node_ids = [node.id for node in flow.nodes]
    if len(set(node_ids)) != len(node_ids):
        errors.add("node IDs must be unique")
    if sum(node.type == "start" for node in flow.nodes) != 1:
        errors.add("flow must contain exactly one start node")
    if not any(node.type == "end" for node in flow.nodes):
        errors.add("flow must contain at least one end node")
    known_ids = set(node_ids)
    for node in flow.nodes:
        if not (_NODE_CHANNELS[node.type] & channels):
            errors.add(f"node {node.id} is unsupported by the selected channels")
    for edge in flow.edges:
        if edge.source not in known_ids or edge.target not in known_ids:
            errors.add(f"edge {edge.id} references a missing node")
        if edge.source == edge.target:
            errors.add(f"edge {edge.id} cannot connect a node to itself")
    if errors:
        return CanonicalFlowValidationResult(valid=False, errors=sorted(errors))

    adapters: dict[Channel, CompiledFlowAdapter] = {}
    for channel in sorted(channels):
        nodes = sorted(
            (node for node in flow.nodes if channel in _NODE_CHANNELS[node.type]),
            key=lambda node: node.id,
        )
        included = {node.id for node in nodes}
        edges = sorted(
            (edge for edge in flow.edges if edge.source in included and edge.target in included),
            key=lambda edge: edge.id,
        )
        adapters[channel] = CompiledFlowAdapter(
            schemaVersion=("oron-flow.v1" if channel == "voice" else "wacrm-automation.v1"),
            nodes=nodes,
            edges=edges,
        )
    return CanonicalFlowValidationResult(valid=True, errors=[], adapters=adapters)


def create_orchestration_router(
    verifier: ServiceAssertionVerifier | None,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/orchestration", tags=["orchestration"])
    bearer = HTTPBearer(auto_error=False)

    async def require_orchestration_write(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    ) -> ServicePrincipal:
        if verifier is None:
            raise HTTPException(status_code=503, detail="orchestration API is not configured")
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="authentication required")
        try:
            principal = verifier.verify(credentials.credentials)
        except InvalidServiceAssertion:
            raise HTTPException(status_code=401, detail="invalid service assertion") from None
        if principal.capability != "orchestration:write":
            raise HTTPException(status_code=403, detail="orchestration write capability required")
        return principal

    @router.post(
        "/flows/validate",
        response_model=CanonicalFlowValidationResult,
        operation_id="validate_canonical_flow",
    )
    async def validate_canonical_flow(
        flow: CanonicalFlowContract,
        _: ServicePrincipal = Depends(require_orchestration_write),
    ) -> CanonicalFlowValidationResult:
        return validate_and_compile(flow)

    return router
