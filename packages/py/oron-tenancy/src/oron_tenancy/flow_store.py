"""PostgresFlowStore — the FlowStore backend that reads and writes the `flows`
table.

Lives here rather than in oron-flows because it needs oron-db: oron-flows is a
leaf package so the authoring tools (and the future builder UI) can import the
component library without dragging in a database driver.

Tenancy: the packaged catalog is stored with `tenant_id IS NULL` and is readable
by every tenant; a tenant's own flows carry their id and are visible only to
them. RLS (migration 0007) enforces that split at the database; the predicate
here states the same rule so the queries are honest on their own.

Every method opens its own transaction and sets the `app.current_tenant` GUC
from the tenant_id it was handed. It has to: the policy is FORCE, so a session
that never sets the GUC sees the packaged catalog and nothing else — a store
that borrowed an unscoped session would silently fail to find tenant flows.
"""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from oron_db import set_tenant
from oron_flows.components import SPEC_VERSION
from oron_flows.compose import Composition, expand
from oron_flows.graph import FlowSpec
from oron_flows.store import GLOBAL_TENANT, FlowListing
from sqlalchemy import ColumnElement, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col

from oron_tenancy.models import Flow


class FlowNotFound(LookupError):
    """No such flow for this tenant. Raised rather than returning None: the
    caller asked for one specific flow, and quietly substituting another is how
    a caller ends up hearing the wrong script."""


def _owner(tenant_id: str) -> uuid.UUID | None:
    """The `tenant_id` column value for a store-level tenant key. GLOBAL_TENANT
    maps to NULL — the packaged catalog belongs to nobody."""
    return None if tenant_id == GLOBAL_TENANT else uuid.UUID(tenant_id)


def _visible_to(tenant_id: str) -> ColumnElement[bool]:
    """Rows this tenant may run: the packaged catalog, plus its own if it has one."""
    owner = _owner(tenant_id)
    packaged = col(Flow.tenant_id).is_(None)
    return packaged if owner is None else (col(Flow.tenant_id) == owner) | packaged


class PostgresFlowStore:
    """FlowStore over Postgres. The sessionmaker is injected — this class never
    builds an engine, so tests hand it the same one the rest of the suite uses."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]):
        self._sessionmaker = sessionmaker

    @asynccontextmanager
    async def _scoped(self, tenant_id: str) -> AsyncIterator[AsyncSession]:
        """A transaction with the tenant GUC set, so RLS scopes the statement.

        GLOBAL_TENANT deliberately leaves the GUC unset: that is the state in
        which the policy admits reading and writing the packaged catalog.
        """
        async with self._sessionmaker() as session, session.begin():
            if tenant_id != GLOBAL_TENANT:
                await set_tenant(session, tenant_id)
            yield session

    async def load(self, tenant_id: str, flow_id: uuid.UUID, version: int) -> FlowSpec:
        stmt = (
            select(Flow)
            .where(col(Flow.flow_id) == flow_id, col(Flow.version) == version)
            .where(_visible_to(tenant_id))
        )
        async with self._scoped(tenant_id) as session:
            row = (await session.execute(stmt)).scalars().first()
        if row is None:
            raise FlowNotFound(f"flow {flow_id} v{version} not found for tenant {tenant_id}")
        return FlowSpec.model_validate(row.spec)

    async def load_latest(self, tenant_id: str, flow_id: uuid.UUID) -> FlowSpec:
        stmt = (
            select(Flow)
            .where(col(Flow.flow_id) == flow_id)
            .where(_visible_to(tenant_id))
            # A tenant's own flow outranks a packaged one sharing its id, whatever
            # the versions are: `is_(None)` sorts false-before-true, so owned rows
            # come first. Publishing cannot create that collision, but nothing
            # stops a hand-written row from doing so, and the winner must not
            # depend on which the planner happened to reach first.
            .order_by(col(Flow.tenant_id).is_(None), col(Flow.version).desc())
            .limit(1)
        )
        async with self._scoped(tenant_id) as session:
            row = (await session.execute(stmt)).scalars().first()
        if row is None:
            raise FlowNotFound(f"flow {flow_id} not found for tenant {tenant_id}")
        return FlowSpec.model_validate(row.spec)

    async def publish(self, tenant_id: str, composition: Composition) -> int:
        """Expand, freeze and store under the composition's own version.

        Idempotent on (flow_id, version): republishing the same version
        overwrites it. That is what makes packaged-catalog convergence safe to
        run on every boot, and it is why authoring a *change* means bumping the
        version rather than editing in place.
        """
        stmt = insert(Flow).values(
            flow_id=composition.flow.id,
            version=composition.flow.version,
            tenant_id=_owner(tenant_id),
            source=composition.model_dump(mode="json"),
            spec=expand(composition).model_dump(mode="json"),
            components_version=SPEC_VERSION,
        )
        async with self._scoped(tenant_id) as session:
            await session.execute(
                stmt.on_conflict_do_update(
                    index_elements=["flow_id", "version"],
                    set_={
                        "source": stmt.excluded.source,
                        "spec": stmt.excluded.spec,
                        "components_version": stmt.excluded.components_version,
                    },
                )
            )
        return composition.flow.version

    async def list_versions(self, tenant_id: str, flow_id: uuid.UUID) -> list[int]:
        stmt = (
            select(col(Flow.version))
            .where(col(Flow.flow_id) == flow_id)
            .where(_visible_to(tenant_id))
            .order_by(col(Flow.version))
        )
        async with self._scoped(tenant_id) as session:
            return list((await session.execute(stmt)).scalars())

    async def list_flows(self, tenant_id: str) -> list[FlowListing]:
        stmt = (
            select(Flow)
            .where(_visible_to(tenant_id))
            # DISTINCT ON keeps one row per flow, and the ORDER BY decides which:
            # the same precedence load_latest uses, so a listing never advertises
            # a version the answer path would not run.
            .distinct(col(Flow.flow_id))
            .order_by(col(Flow.flow_id), col(Flow.tenant_id).is_(None), col(Flow.version).desc())
        )
        async with self._scoped(tenant_id) as session:
            rows = list((await session.execute(stmt)).scalars())
        return [
            FlowListing(
                flow_id=row.flow_id,
                name=row.source["flow"].get("name") or str(row.flow_id),
                language=row.source["flow"]["language"],
                latest_version=row.version,
                packaged=row.tenant_id is None,
            )
            for row in rows
        ]

    async def load_source(
        self, tenant_id: str, flow_id: uuid.UUID, version: int | None = None
    ) -> Composition:
        stmt = select(Flow).where(col(Flow.flow_id) == flow_id).where(_visible_to(tenant_id))
        if version is None:
            stmt = stmt.order_by(col(Flow.tenant_id).is_(None), col(Flow.version).desc()).limit(1)
        else:
            stmt = stmt.where(col(Flow.version) == version)
        async with self._scoped(tenant_id) as session:
            row = (await session.execute(stmt)).scalars().first()
        if row is None:
            raise FlowNotFound(f"flow {flow_id} v{version or 'latest'} not found for {tenant_id}")
        return Composition.model_validate(row.source)
