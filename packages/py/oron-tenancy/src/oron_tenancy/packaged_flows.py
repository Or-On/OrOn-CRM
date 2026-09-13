"""Publish an explicitly selected development-fixture catalog.

Runtime startup does not call this utility. Frozen publications remain immutable:
an identical replay is harmless, but a changed fixture or expansion requires a
new composition version. Tenant-authored flows are never touched by this utility.
"""

import uuid

from loguru import logger
from oron_flows.compose import Composition
from oron_flows.store import GLOBAL_TENANT, FlowStore
from pydantic import BaseModel


class PackagedFlowsResult(BaseModel):
    """Which packaged flows are now in the database, and what failed."""

    published: list[str] = []
    failed: list[str] = []


async def converge_packaged_flows(
    *, store: FlowStore, catalog: dict[uuid.UUID, Composition]
) -> PackagedFlowsResult:
    """Publish every packaged composition under the global tenant.

    One bad flow is recorded, not raised: a composition that no longer expands
    must not stop the API from serving every other flow. It surfaces as a failed
    load at call time, which is where the fallback already lives.
    """
    result = PackagedFlowsResult()
    for flow_id, composition in catalog.items():
        try:
            version = await store.publish(GLOBAL_TENANT, composition)
        except Exception as exc:
            logger.error(f"packaged flow {flow_id} could not be published ({type(exc).__name__})")
            result.failed.append(str(flow_id))
            continue
        result.published.append(str(flow_id))
        logger.debug(f"packaged flow {flow_id} published at v{version}")

    logger.info(
        f"packaged flow catalog converged: {len(result.published)} published"
        + (f", {len(result.failed)} FAILED" if result.failed else "")
    )
    return result
