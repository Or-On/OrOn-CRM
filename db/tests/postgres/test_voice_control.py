"""Actual PostgreSQL role/epoch/ack persistence; no call or provider is started."""

import asyncio
from uuid import uuid4

import pytest
from control_api.auth import ServicePrincipal
from control_api.voice_control import (
    PostgresVoiceControlRepository,
    VoiceControlCommand,
)
from dispatcher_runtime.persistence import PostgresVoiceRuntime, _async_database_url
from fastapi import HTTPException
from oron_common import CallContext, Direction
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def test_active_voice_control_scope_epochs_receipts_and_revocation(postgres_url):
    engine = create_async_engine(_async_database_url(postgres_url))
    tenant, user, session, other_tenant, other_user = (uuid4() for _ in range(5))
    context = CallContext(
        call_id="voice-control-fixture",
        session_id=session,
        tenant_id=tenant,
        flow_id=uuid4(),
        direction=Direction.INBOUND,
    )
    principal = ServicePrincipal(
        tenant_id=tenant,
        user_id=user,
        role="agent",
        capability="voice:write",
        session_id=uuid4(),
    )
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                for tenant_id, actor in [(tenant, user), (other_tenant, other_user)]:
                    await connection.execute(
                        text(
                            "INSERT INTO tenants(id,name,slug) VALUES (:id,'Control fixture',:slug)"
                        ),
                        {"id": tenant_id, "slug": f"voice-control-{tenant_id}"},
                    )
                    await connection.execute(
                        text("INSERT INTO users(id,email) VALUES(:id,:email)"),
                        {"id": actor, "email": f"control-{actor}@example.invalid"},
                    )
                    await connection.execute(
                        text(
                            "INSERT INTO memberships(user_id,tenant_id,role) "
                            "VALUES(:user,:tenant,'agent')"
                        ),
                        {"user": actor, "tenant": tenant_id},
                    )
                await connection.execute(
                    text("""
                    INSERT INTO sessions
                      (session_id,tenant_id,direction,room,flow_id,provider,status)
                    VALUES(:session,:tenant,'inbound','control-fixture',:flow,'livekit','started')
                    """),
                    {"session": session, "tenant": tenant, "flow": context.flow_id},
                )
                maker = async_sessionmaker(
                    bind=connection,
                    class_=AsyncSession,
                    expire_on_commit=False,
                    join_transaction_mode="create_savepoint",
                )
                repository = PostgresVoiceControlRepository(maker)
                runtime = object.__new__(PostgresVoiceRuntime)
                runtime._sessionmaker = maker
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                initial = await repository.get(principal, session)
                assert initial.epoch == 0 and initial.can_operate
                command = VoiceControlCommand(
                    mode="paused", expected_epoch=0, idempotency_key="pause-key"
                )
                requested = await repository.command(principal, session, command)
                assert requested.epoch == 1 and requested.status == "pending"
                replay = await repository.command(principal, session, command)
                assert replay.command_id == requested.command_id
                for changed in [
                    command.model_copy(update={"mode": "ai"}),
                    command.model_copy(update={"idempotency_key": "another-key"}),
                ]:
                    with pytest.raises(HTTPException) as conflict:
                        await repository.command(principal, session, changed)
                    assert conflict.value.status_code == 409
                other = principal.model_copy(
                    update={"tenant_id": other_tenant, "user_id": other_user}
                )
                with pytest.raises(HTTPException) as hidden:
                    await repository.get(other, session)
                assert hidden.value.status_code == 404
                current = await runtime.read_voice_control(context)
                assert current["epoch"] == 1 and current["mode"] == "paused"
                assert not await runtime.acknowledge_voice_control(context, 0, "ai")
                assert await runtime.acknowledge_voice_control(context, 1, "paused")
                applied = await repository.get(principal, session)
                assert applied.status == "applied" and applied.human_connection == "not_managed"
                receipt = (
                    (
                        await connection.execute(
                            text(
                                "SELECT worker_mode,acknowledged_at "
                                "FROM voice_session_control_commands WHERE id=:id"
                            ),
                            {"id": requested.command_id},
                        )
                    )
                    .mappings()
                    .one()
                )
                assert receipt["worker_mode"] == "paused" and receipt["acknowledged_at"] is not None
                resumed = await repository.command(
                    principal,
                    session,
                    VoiceControlCommand(
                        mode="ai",
                        expected_epoch=1,
                        idempotency_key="resume-key",
                    ),
                )
                assert resumed.epoch == 2 and resumed.status == "pending"
                assert not await runtime.acknowledge_voice_control(context, 1, "paused")

                # Workers cannot manufacture an ownership command with direct SQL.
                nested = await connection.begin_nested()
                with pytest.raises(DBAPIError):
                    await connection.execute(
                        text(
                            "UPDATE voice_session_controls SET desired_mode='ai' "
                            "WHERE session_id=:id"
                        ),
                        {"id": session},
                    )
                await nested.rollback()
                await connection.execute(text("RESET ROLE"))
                await connection.execute(
                    text("UPDATE users SET status='disabled' WHERE id=:id"), {"id": user}
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                assert not (await runtime.read_voice_control(context))["resume_authorized"]
                assert not await runtime.acknowledge_voice_control(context, 2, "ai")
                assert await runtime.acknowledge_voice_control(context, 2, "paused")
                with pytest.raises(HTTPException) as revoked:
                    await repository.command(
                        principal,
                        session,
                        VoiceControlCommand(
                            mode="ai",
                            expected_epoch=2,
                            idempotency_key="revoked-key",
                        ),
                    )
                assert revoked.value.status_code == 403
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()


async def test_concurrent_control_commands_have_one_epoch_winner(isolated_postgres_url):
    from db.tests.postgres.conftest import run_alembic

    await run_alembic(isolated_postgres_url, "upgrade", "head")
    engine = create_async_engine(_async_database_url(isolated_postgres_url))
    tenant, user, session = uuid4(), uuid4(), uuid4()
    principal = ServicePrincipal(
        tenant_id=tenant,
        user_id=user,
        role="agent",
        capability="voice:write",
        session_id=uuid4(),
    )
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text("INSERT INTO tenants(id,name,slug) VALUES(:id,'Control concurrency',:slug)"),
                {"id": tenant, "slug": f"control-race-{tenant}"},
            )
            await connection.execute(
                text("INSERT INTO users(id,email) VALUES(:id,:email)"),
                {"id": user, "email": f"race-{user}@example.invalid"},
            )
            await connection.execute(
                text(
                    "INSERT INTO memberships(user_id,tenant_id,role) VALUES(:user,:tenant,'agent')"
                ),
                {"user": user, "tenant": tenant},
            )
            await connection.execute(
                text("""
                INSERT INTO sessions(session_id,tenant_id,direction,room,flow_id,provider,status)
                VALUES(:session,:tenant,'inbound','control-race',:flow,'livekit','started')
                """),
                {"session": session, "tenant": tenant, "flow": uuid4()},
            )
        repository = PostgresVoiceControlRepository(
            async_sessionmaker(engine, expire_on_commit=False)
        )
        pause = VoiceControlCommand(
            mode="paused", expected_epoch=0, idempotency_key="same-pause-key"
        )
        first, replay = await asyncio.gather(
            repository.command(principal, session, pause),
            repository.command(principal, session, pause),
        )
        assert first.command_id == replay.command_id and first.epoch == replay.epoch == 1
        results = await asyncio.gather(
            repository.command(
                principal,
                session,
                VoiceControlCommand(
                    mode="ai",
                    expected_epoch=1,
                    idempotency_key="resume-race-key",
                ),
            ),
            repository.command(
                principal,
                session,
                VoiceControlCommand(
                    mode="paused",
                    expected_epoch=1,
                    idempotency_key="pause-race-key",
                ),
            ),
            return_exceptions=True,
        )
        assert (
            len(
                [
                    result
                    for result in results
                    if isinstance(result, HTTPException) and result.status_code == 409
                ]
            )
            == 1
        )
        assert (await repository.get(principal, session)).epoch == 2
    finally:
        await engine.dispose()
