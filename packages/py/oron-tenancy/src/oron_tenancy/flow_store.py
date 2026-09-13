"""PostgresFlowStore — the FlowStore backend that reads and writes the `flows`
table.

Lives here rather than in oron-flows because it needs oron-db: oron-flows is a
leaf package so the authoring tools (and the future builder UI) can import the
component library without dragging in a database driver.

Tenancy: runtime tenant lookups see only rows carrying that tenant's id. Legacy
or explicit development fixtures may still be stored with ``tenant_id IS NULL``
through ``GLOBAL_TENANT``, but they are visible only to that explicit store key,
never as a fallback for an ordinary tenant.

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


class FlowVersionConflict(RuntimeError):
    """A published key cannot be reused for different frozen content."""


def _owner(tenant_id: str) -> uuid.UUID | None:
    """Map the explicit development-fixture key to an unowned database row."""

    return None if tenant_id == GLOBAL_TENANT else uuid.UUID(tenant_id)


def _visible_to(tenant_id: str) -> ColumnElement[bool]:
    """Rows owned by this tenant, or unowned rows for the explicit global key."""

    owner = _owner(tenant_id)
    return col(Flow.tenant_id).is_(None) if owner is None else col(Flow.tenant_id) == owner


def _flow_spec_from_row(row: Flow) -> FlowSpec:
    """Load a frozen spec while preserving pre-field persona metadata.

    Published flows created before ``persona_gender`` was added still carry the
    authoritative value in their immutable source composition. Hydrating that
    value here fixes existing calls without rewriting published JSON or losing
    version provenance.
    """

    payload = dict(row.spec)
    if "persona_gender" not in payload:
        source = row.source if isinstance(row.source, dict) else {}
        persona = source.get("persona") if isinstance(source, dict) else None
        gender = persona.get("gender") if isinstance(persona, dict) else None
        if gender in {"female", "male", "neutral"}:
            payload["persona_gender"] = gender
    return FlowSpec.model_validate(payload)


class PostgresFlowStore:
    """FlowStore over Postgres. The sessionmaker is injected — this class never
    builds an engine, so tests hand it the same one the rest of the suite uses."""

    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]):
        self._sessionmaker = sessionmaker

    @asynccontextmanager
    async def _scoped(self, tenant_id: str) -> AsyncIterator[AsyncSession]:
        """A transaction with the tenant GUC set, so RLS scopes the statement.

        GLOBAL_TENANT deliberately leaves the GUC unset for explicit fixture
        tooling. Runtime callers always provide a tenant UUID.
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
        return _flow_spec_from_row(row)

    async def load_latest(self, tenant_id: str, flow_id: uuid.UUID) -> FlowSpec:
        stmt = (
            select(Flow)
            .where(col(Flow.flow_id) == flow_id)
            .where(_visible_to(tenant_id))
            .order_by(col(Flow.version).desc())
            .limit(1)
        )
        async with self._scoped(tenant_id) as session:
            row = (await session.execute(stmt)).scalars().first()
        if row is None:
            raise FlowNotFound(f"flow {flow_id} not found for tenant {tenant_id}")
        return _flow_spec_from_row(row)

    async def publish(self, tenant_id: str, composition: Composition) -> int:
        """Expand, freeze and store under the composition's own version.

        Exact replays leave the original row untouched. A source, expanded spec,
        or component-library change requires a new version, including fixture
        publications. The insert arbitrates concurrent writers before comparing
        the winner in a fresh statement under PostgreSQL READ COMMITTED.
        """
        source = composition.model_dump(mode="json")
        spec = expand(composition).model_dump(mode="json")
        stmt = insert(Flow).values(
            flow_id=composition.flow.id,
            version=composition.flow.version,
            tenant_id=_owner(tenant_id),
            source=source,
            spec=spec,
            components_version=SPEC_VERSION,
        )
        async with self._scoped(tenant_id) as session:
            inserted = await session.execute(
                stmt.on_conflict_do_nothing(index_elements=["flow_id", "version"]).returning(
                    col(Flow.flow_id)
                )
            )
            if inserted.first() is None:
                existing = (
                    (
                        await session.execute(
                            select(Flow)
                            .where(
                                col(Flow.flow_id) == composition.flow.id,
                                col(Flow.version) == composition.flow.version,
                            )
                            .where(_visible_to(tenant_id))
                        )
                    )
                    .scalars()
                    .first()
                )
                if (
                    existing is None
                    or existing.source != source
                    or existing.spec != spec
                    or existing.components_version != SPEC_VERSION
                ):
                    # Do not disclose another tenant's colliding flow content.
                    raise FlowVersionConflict(
                        f"version {composition.flow.version} is already published; bump the version"
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
            # DISTINCT ON keeps the latest owned version for each flow.
            .distinct(col(Flow.flow_id))
            .order_by(col(Flow.flow_id), col(Flow.version).desc())
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
            stmt = stmt.order_by(col(Flow.version).desc()).limit(1)
        else:
            stmt = stmt.where(col(Flow.version) == version)
        async with self._scoped(tenant_id) as session:
            row = (await session.execute(stmt)).scalars().first()
        if row is None:
            raise FlowNotFound(f"flow {flow_id} v{version or 'latest'} not found for {tenant_id}")
        return Composition.model_validate(row.source)
