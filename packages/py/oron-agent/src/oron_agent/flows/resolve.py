"""Resolve the tenant-owned, published FlowSpec a call should run."""

from loguru import logger
from oron_common import CallContext
from oron_flows.graph import FlowSpec

from oron_agent.runtime_sessions import RuntimeSessions


class StoredFlowUnavailable(RuntimeError):
    """The requested published flow could not be loaded from PostgreSQL."""


async def resolve_flow_spec(sessions: RuntimeSessions, ctx: CallContext) -> FlowSpec:
    """Return the stored spec, failing closed when it cannot be loaded.

    Running a packaged fictional script after a missing/invalid database lookup
    can make a real caller hear behavior the tenant never configured. The
    dispatcher and direct development entrypoint therefore both require a real
    published flow.
    """
    spec = await sessions.get_flow(ctx.flow_id, tenant_id=ctx.tenant_id)
    if spec is not None:
        return spec

    logger.error(
        "stored flow unavailable; refusing to start voice runtime "
        f"(flow={ctx.flow_id}, session={ctx.session_id})"
    )
    raise StoredFlowUnavailable(f"published flow {ctx.flow_id} is unavailable")
