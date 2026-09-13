"""The real retained PostgreSQL store cannot mutate a published voice version."""

from uuid import uuid4

import pytest
from oron_flows.compose import expand
from oron_flows.seeds import EXAMPLE_HE_ID, composition_for
from oron_tenancy.flow_store import FlowVersionConflict, PostgresFlowStore
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def test_retained_publication_is_immutable_under_runtime_role(postgres_url):
    engine = create_async_engine(postgres_url.replace("postgresql://", "postgresql+asyncpg://", 1))
    tenant_id, other_tenant_id, flow_id = uuid4(), uuid4(), uuid4()
    composition = composition_for(EXAMPLE_HE_ID).model_copy(deep=True)
    composition.flow.id = flow_id
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                for tenant in (tenant_id, other_tenant_id):
                    await connection.execute(
                        text("INSERT INTO tenants(id,name,slug) VALUES (:id,'Flow fixture',:slug)"),
                        {"id": tenant, "slug": f"flow-immutable-{tenant}"},
                    )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                store = PostgresFlowStore(
                    async_sessionmaker(
                        bind=connection,
                        class_=AsyncSession,
                        expire_on_commit=False,
                        join_transaction_mode="create_savepoint",
                    )
                )
                version = await store.publish(str(tenant_id), composition)
                assert await store.publish(str(tenant_id), composition) == version
                assert await store.load(str(tenant_id), flow_id, version) == expand(composition)

                changed = composition.model_copy(deep=True)
                changed.persona.org = "Different fixture organization"
                with pytest.raises(FlowVersionConflict, match="bump the version"):
                    await store.publish(str(tenant_id), changed)
                assert await store.load_source(str(tenant_id), flow_id, version) == composition
                assert await store.load(str(tenant_id), flow_id, version) == expand(composition)

                with pytest.raises(FlowVersionConflict):
                    await store.publish(str(other_tenant_id), composition)

                changed.flow.version += 1
                assert await store.publish(str(tenant_id), changed) == version + 1
                assert await store.list_versions(str(tenant_id), flow_id) == [version, version + 1]
                assert await store.load(str(tenant_id), flow_id, version) == expand(composition)
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()
