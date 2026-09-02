"""Canonical voice actions reference frozen retained specs, never re-expand them."""

from uuid import UUID

from oron_flows.graph import FlowSpec


def adapt_retained_voice_flow(flow_id: UUID, version: int, stored_spec: object) -> FlowSpec:
    spec = FlowSpec.model_validate(stored_spec)
    if spec.id != flow_id or spec.version != version:
        raise ValueError("retained voice flow identity/version mismatch")
    return spec
