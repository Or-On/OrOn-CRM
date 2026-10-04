from uuid import uuid4

import pytest
from dispatcher_runtime.persistence import PostgresVoiceRuntime, _async_database_url
from oron_common import CallUsage
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def test_voice_usage_checkpoint_commit_acknowledgment_retries_and_tenant_scope(postgres_url):
    engine = create_async_engine(_async_database_url(postgres_url))
    tenant, foreign, session, foreign_session = (uuid4() for _ in range(4))
    try:
        async with engine.connect() as connection:
            outer = await connection.begin()
            try:
                for owner, call in ((tenant, session), (foreign, foreign_session)):
                    await connection.execute(
                        text(
                            "INSERT INTO tenants(id,name,slug) VALUES(:id,'Fictional usage',:slug)"
                        ),
                        {"id": owner, "slug": str(owner)},
                    )
                    await connection.execute(
                        text(
                            "INSERT INTO sessions(session_id,tenant_id,direction,room,"
                            "flow_id,provider,status) "
                            "VALUES(:id,:tenant,'inbound',:room,:flow,'livekit','started')"
                        ),
                        {"id": call, "tenant": owner, "room": str(call), "flow": uuid4()},
                    )
                runtime = object.__new__(PostgresVoiceRuntime)
                runtime._sessionmaker = async_sessionmaker(
                    bind=connection,
                    class_=AsyncSession,
                    expire_on_commit=False,
                    join_transaction_mode="create_savepoint",
                )
                usage = CallUsage(llm_prompt_tokens=23, llm_completion_tokens=7)
                usage.record_model_event(23, 7)
                identifier = usage.pending_model_events()[0][0]
                await connection.execute(text("SET LOCAL ROLE platform_readonly"))
                with pytest.raises(DBAPIError):
                    await runtime.checkpoint_usage(session, tenant, usage=usage)
                assert len(usage.pending_model_events()) == 1
                await connection.execute(text("RESET ROLE"))
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                assert await runtime.checkpoint_usage(session, tenant, usage=usage)
                assert not usage.pending_model_events()
                assert await runtime.checkpoint_usage(session, tenant, usage=usage)
                async with connection.begin_nested():
                    await connection.execute(
                        text("SELECT set_config('app.current_tenant',:tenant,true)"),
                        {"tenant": str(tenant)},
                    )
                    assert not (
                        await connection.execute(
                            text(
                                "SELECT agents.record_voice_usage("
                                ":id,:session,999,999,CURRENT_TIMESTAMP)"
                            ),
                            {"id": identifier, "session": session},
                        )
                    ).scalar_one()
                with pytest.raises(DBAPIError, match="usage session unavailable"):
                    async with connection.begin_nested():
                        await connection.execute(
                            text("SELECT set_config('app.current_tenant',:tenant,true)"),
                            {"tenant": str(tenant)},
                        )
                        await connection.execute(
                            text(
                                "SELECT agents.record_voice_usage("
                                ":id,:session,1,1,CURRENT_TIMESTAMP)"
                            ),
                            {"id": uuid4(), "session": foreign_session},
                        )
                await connection.execute(text("RESET ROLE"))
                recorded = (
                    await connection.execute(
                        text(
                            "SELECT tenant_id,input_tokens,output_tokens "
                            "FROM agents.usage_events WHERE id=:id"
                        ),
                        {"id": identifier},
                    )
                ).one()
                assert tuple(recorded) == (tenant, 23, 7)
            finally:
                await outer.rollback()
    finally:
        await engine.dispose()
