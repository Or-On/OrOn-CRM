"""Authoritative DID routing runs under the real voice role, without broad grants."""

from uuid import uuid4

import pytest
from dispatcher_runtime.persistence import PostgresVoiceRuntime, _async_database_url
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


@pytest.mark.parametrize("state", ["active", "disabled", "foreign_flow", "missing_flow"])
async def test_phone_resolution_requires_active_tenant_and_owned_flow(postgres_url, state):
    engine = create_async_engine(_async_database_url(postgres_url))
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                tenant, foreign, flow = uuid4(), uuid4(), uuid4()
                for identity in (tenant, foreign):
                    await connection.execute(
                        text(
                            "INSERT INTO tenants(id,name,slug,status) "
                            "VALUES(:id,'Fictional inbound',:slug,:status)"
                        ),
                        {
                            "id": identity,
                            "slug": f"inbound-proof-{identity}",
                            "status": "disabled"
                            if identity == tenant and state == "disabled"
                            else "active",
                        },
                    )
                if state != "missing_flow":
                    await connection.execute(
                        text(
                            "INSERT INTO flows"
                            "(flow_id,version,tenant_id,source,spec,components_version) "
                            "VALUES(:flow,1,:tenant,'{}','{}','fixture')"
                        ),
                        {"flow": flow, "tenant": foreign if state == "foreign_flow" else tenant},
                    )
                await connection.execute(
                    text(
                        "INSERT INTO phone_numbers(id,tenant_id,e164,flow_id,dispatch_rule_id) "
                        "VALUES(:id,:tenant,'+14155550109',:flow,'SDR_fictional')"
                    ),
                    {"id": uuid4(), "tenant": tenant, "flow": flow},
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                assert (
                    await connection.execute(text("SELECT current_user"))
                ).scalar_one() == "platform_voice"
                runtime = object.__new__(PostgresVoiceRuntime)
                runtime._sessionmaker = async_sessionmaker(
                    bind=connection,
                    class_=AsyncSession,
                    expire_on_commit=False,
                    join_transaction_mode="create_savepoint",
                )
                resolution = await runtime.resolve_phone("+14155550109")
                if state == "active":
                    assert resolution is not None
                    assert resolution.tenant_id == tenant and resolution.flow_id == flow
                    assert resolution.dispatch_rule_id == "SDR_fictional"
                else:
                    assert resolution is None
                assert await runtime.resolve_phone("+14155550108") is None
                # Tenant context remains transaction-local to the borrowed session.
                assert (
                    await connection.execute(
                        text("SELECT nullif(current_setting('app.current_tenant',true),'')")
                    )
                ).scalar_one() is None
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()
