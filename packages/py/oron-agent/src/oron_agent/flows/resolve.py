"""Resolve the FlowSpec a call should run.

The store is the source of truth — it is the only place a tenant's own flows
exist. The packaged catalog is the parachute, and it is reached on the answer
path with a caller already connected, so this never raises.
"""

from loguru import logger
from oron_common import CallContext
from oron_flows.compose import expand
from oron_flows.graph import FlowSpec
from oron_flows.seeds import composition_for
from oron_sessions import SessionsClient


async def resolve_flow_spec(sessions: SessionsClient, ctx: CallContext) -> FlowSpec:
    """The stored spec for this call's flow, or the packaged copy if the store
    could not serve it."""
    spec = await sessions.get_flow(ctx.flow_id, tenant_id=ctx.tenant_id)
    if spec is not None:
        return spec

    composition = composition_for(ctx.flow_id)
    if composition.flow.id != ctx.flow_id:
        # sessions.flow_id records what was asked for, so say what actually ran.
        logger.warning(
            f"flow {ctx.flow_id} is in neither the store nor this build; ran "
            f"{composition.flow.id} (session={ctx.session_id})"
        )
    else:
        logger.warning(f"flow {ctx.flow_id} not served by the store; ran the packaged copy")
    return expand(composition)
