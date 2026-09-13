"""Run the actual dispatcher evidence adapter against isolated PostgreSQL/RLS."""

import asyncio
import json
from uuid import uuid4

import pytest
from dispatcher_runtime.persistence import PostgresVoiceRuntime, _async_database_url
from oron_common import CallContext, Direction
from oron_dispatcher.dispatcher import IdempotencyConflict
from oron_sessions.crypto import LocalFieldCipher
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def test_voice_reader_rechecks_source_revoke_expiry_and_tenant(postgres_url):
    engine = create_async_engine(_async_database_url(postgres_url))
    tenant, profile, agent, source, document = (uuid4() for _ in range(5))
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                params = {
                    "tenant": tenant,
                    "profile": profile,
                    "agent": agent,
                    "source": source,
                    "document": document,
                    "slug": f"voice-quality-{tenant}",
                }
                await connection.execute(
                    text(
                        "INSERT INTO tenants(id,name,slug) "
                        "VALUES (:tenant,'Voice quality fixture',:slug)"
                    ),
                    params,
                )
                await connection.execute(
                    text(
                        "INSERT INTO agents.agent_profiles(id,tenant_id,name) "
                        "VALUES (:profile,:tenant,'Quality fixture')"
                    ),
                    params,
                )
                await connection.execute(
                    text("""
                    INSERT INTO agents.knowledge_sources(id,tenant_id,name,source_type,status)
                    VALUES (:source,:tenant,'Approved fixture','manual','published')
                """),
                    params,
                )
                params["facts"] = json.dumps(
                    {
                        "schemaVersion": "1.0",
                        "facts": [
                            {"factKey": "opening.hours", "value": "Open from 09:00 to 17:00."}
                        ],
                    }
                )
                await connection.execute(
                    text("""
                    INSERT INTO agents.knowledge_documents(id,tenant_id,source_id,title,
                        content_checksum,version,published_at,metadata)
                    VALUES (:document,:tenant,:source,'Hours','fixture-checksum',1,
                            CURRENT_TIMESTAMP,CAST(:facts AS jsonb))
                """),
                    params,
                )
                params["selection"] = json.dumps(
                    {"schemaVersion": "1.0", "sourceIds": [str(source)]}
                )
                await connection.execute(
                    text("""
                    INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,
                        version,system_prompt,channel_capabilities,validation_status,published_at,
                        knowledge_configuration)
                    VALUES (:agent,:tenant,:profile,1,'Fixture',ARRAY['voice'],'valid',
                        CURRENT_TIMESTAMP,CAST(:selection AS jsonb))
                """),
                    params,
                )
                runtime = object.__new__(PostgresVoiceRuntime)
                runtime._sessionmaker = async_sessionmaker(
                    bind=connection,
                    class_=AsyncSession,
                    expire_on_commit=False,
                    join_transaction_mode="create_savepoint",
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                found = await runtime.get_voice_knowledge(agent, tenant_id=tenant)
                assert found[0]["facts"][0]["value"] == "Open from 09:00 to 17:00."
                assert found[0]["documentId"] == str(document)
                assert await runtime.get_voice_knowledge(agent, tenant_id=uuid4()) == []
                await connection.execute(text("RESET ROLE"))
                for version, configuration in enumerate(
                    [
                        {"schemaVersion": "0.9", "sourceIds": [str(source)]},
                        {"schemaVersion": "1.0", "sourceIds": {str(source): True}},
                        {"schemaVersion": "1.0", "sourceIds": str(source)},
                    ],
                    start=2,
                ):
                    invalid_agent = uuid4()
                    await connection.execute(
                        text("""
                        INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,
                            version,system_prompt,channel_capabilities,validation_status,published_at,
                            knowledge_configuration)
                        VALUES (:invalid_agent,:tenant,:profile,:version,'Malformed fixture',
                            ARRAY['voice'],'valid',now(),CAST(:selection AS jsonb))
                    """),
                        {
                            **params,
                            "invalid_agent": invalid_agent,
                            "version": version,
                            "selection": json.dumps(configuration),
                        },
                    )
                    await connection.execute(text("SET LOCAL ROLE platform_voice"))
                    assert await runtime.get_voice_knowledge(invalid_agent, tenant_id=tenant) == []
                    await connection.execute(text("RESET ROLE"))
                await connection.execute(
                    text("UPDATE agents.knowledge_sources SET status='revoked' WHERE id=:source"),
                    params,
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                assert await runtime.get_voice_knowledge(agent, tenant_id=tenant) == []
                await connection.execute(text("RESET ROLE"))
                await connection.execute(
                    text("UPDATE agents.knowledge_sources SET status='published' WHERE id=:source"),
                    params,
                )
                await connection.execute(
                    text("""
                    INSERT INTO agents.knowledge_documents(tenant_id,source_id,title,
                        content_checksum,version,published_at,valid_from,valid_until,metadata)
                    VALUES (:tenant,:source,'Expired successor','fixture-checksum-2',2,
                        CURRENT_TIMESTAMP-INTERVAL '2 days',CURRENT_TIMESTAMP-INTERVAL '2 days',
                        CURRENT_TIMESTAMP-INTERVAL '1 day',CAST(:facts AS jsonb))
                """),
                    params,
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                assert await runtime.get_voice_knowledge(agent, tenant_id=tenant) == []
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()


async def test_voice_configuration_pins_exact_agent_and_rejects_ambiguous_bindings(postgres_url):
    engine = create_async_engine(_async_database_url(postgres_url))
    tenant, profile, agent, flow, retained = (uuid4() for _ in range(5))
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                params = {
                    "tenant": tenant,
                    "profile": profile,
                    "agent": agent,
                    "flow": flow,
                    "retained": retained,
                    "slug": f"binding-{tenant}",
                    "definition": json.dumps(
                        {
                            "nodes": [
                                {
                                    "type": "voice.call",
                                    "configuration": {"flowId": str(retained), "flowVersion": 3},
                                }
                            ]
                        }
                    ),
                }
                for statement in [
                    "INSERT INTO tenants(id,name,slug) VALUES(:tenant,'Binding fixture',:slug)",
                    "INSERT INTO agents.agent_profiles(id,tenant_id,name) "
                    "VALUES(:profile,:tenant,'Fixture')",
                    "INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,"
                    "version,system_prompt,channel_capabilities,validation_status,published_at) "
                    "VALUES(:agent,:tenant,:profile,1,'Version one',ARRAY['voice'],'valid',now())",
                    "INSERT INTO automation.flow_definitions(id,tenant_id,name) "
                    "VALUES(:flow,:tenant,'Binding fixture')",
                    "INSERT INTO automation.flow_versions(tenant_id,flow_definition_id,version,"
                    "schema_version,definition,validation_status,published_at,agent_profile_version_id)"
                    " VALUES(:tenant,:flow,1,'1.0',CAST(:definition AS jsonb),"
                    "'valid',now(),:agent)",
                ]:
                    await connection.execute(text(statement), params)
                runtime = object.__new__(PostgresVoiceRuntime)
                runtime._sessionmaker = async_sessionmaker(
                    bind=connection,
                    class_=AsyncSession,
                    expire_on_commit=False,
                    join_transaction_mode="create_savepoint",
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                found = await runtime.get_voice_configuration(retained, tenant_id=tenant)
                assert found["agentVersionId"] == str(agent)
                assert found["flowVersion"] == 3
                with pytest.raises(ValueError, match="unavailable"):
                    await runtime.get_voice_configuration(
                        retained, tenant_id=tenant, agent_version_id=agent, flow_version=4
                    )
                with pytest.raises(ValueError, match="unavailable"):
                    await runtime.get_voice_configuration(
                        retained, tenant_id=uuid4(), agent_version_id=agent, flow_version=3
                    )
                await connection.execute(text("RESET ROLE"))
                successor = uuid4()
                params["successor"] = successor
                await connection.execute(
                    text(
                        "INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,"
                        "version,system_prompt,channel_capabilities,validation_status,"
                        "published_at) VALUES(:successor,:tenant,:profile,2,'Version two',"
                        "ARRAY['voice'],'valid',now())"
                    ),
                    params,
                )
                await connection.execute(
                    text(
                        "INSERT INTO automation.flow_versions(tenant_id,flow_definition_id,version,"
                        "schema_version,definition,validation_status,published_at,agent_profile_version_id)"
                        " VALUES(:tenant,:flow,2,'1.0',CAST(:definition AS jsonb),"
                        "'valid',now(),:successor)"
                    ),
                    params,
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                current = await runtime.get_voice_configuration(retained, tenant_id=tenant)
                assert current["agentVersionId"] == str(successor)
                pinned = await runtime.get_voice_configuration(
                    retained, tenant_id=tenant, agent_version_id=agent, flow_version=3
                )
                assert pinned["agentVersionId"] == str(agent)
                await connection.execute(text("RESET ROLE"))
                params["flow"] = uuid4()
                await connection.execute(
                    text(
                        "INSERT INTO automation.flow_definitions(id,tenant_id,name) "
                        "VALUES(:flow,:tenant,'Conflicting binding fixture')"
                    ),
                    params,
                )
                await connection.execute(
                    text(
                        "INSERT INTO automation.flow_versions(tenant_id,flow_definition_id,version,"
                        "schema_version,definition,validation_status,published_at,agent_profile_version_id)"
                        " VALUES(:tenant,:flow,1,'1.0',CAST(:definition AS jsonb),"
                        "'valid',now(),:agent)"
                    ),
                    params,
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                with pytest.raises(ValueError, match="ambiguous"):
                    await runtime.get_voice_configuration(retained, tenant_id=tenant)
                await connection.execute(text("RESET ROLE"))
                await connection.execute(
                    text("UPDATE tenants SET status='suspended' WHERE id=:tenant"), params
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                with pytest.raises(ValueError, match="unavailable"):
                    await runtime.get_voice_configuration(
                        retained, tenant_id=tenant, agent_version_id=agent, flow_version=3
                    )
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()


async def test_durable_admission_replay_concurrency_and_quality_summary(isolated_postgres_url):
    from db.tests.postgres.conftest import run_alembic

    await run_alembic(isolated_postgres_url, "upgrade", "head")
    engine = create_async_engine(_async_database_url(isolated_postgres_url))
    runtime = object.__new__(PostgresVoiceRuntime)
    runtime._sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    runtime._cipher = LocalFieldCipher(bytes(range(32)))
    runtime._blind_index_key = bytes(range(32, 64))
    tenant = uuid4()
    context = CallContext(
        call_id="fictional-admission",
        direction=Direction.OUTBOUND,
        tenant_id=tenant,
        flow_id=uuid4(),
        to_number="+12025550123",
        caller_gender="male",
    )
    try:
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO tenants(id,name,slug) VALUES(:tenant,'Concurrency fixture',:slug)"
                ),
                {"tenant": tenant, "slug": f"admission-{tenant}"},
            )
        # Two independent transactions, real PostgreSQL locks: exactly one
        # admission may return True (the condition for external dispatch).
        results = await asyncio.gather(
            runtime.begin(context, room="fictional-room", idempotency_key="fixture-key"),
            runtime.begin(context, room="fictional-room", idempotency_key="fixture-key"),
        )
        assert sorted(results) == [False, True]
        for changed in [
            {"to_number": "+12025550124"},
            {"flow_version": 2},
            {"caller_gender": "female"},
            {"conversation_context": "Changed caller claim"},
        ]:
            with pytest.raises(IdempotencyConflict):
                await runtime.begin(
                    context.model_copy(update=changed),
                    room="fictional-room",
                    idempotency_key="fixture-key",
                )
        summary = {
            "schemaVersion": "1.0",
            "exactPlaybackConfirmed": False,
            "counts": {"acceptedUtterances": 1},
        }
        await asyncio.gather(
            runtime.record_voice_quality(context, summary, agent_version_id=None),
            runtime.record_voice_quality(context, summary, agent_version_id=None),
        )
        async with engine.connect() as connection:
            events = (
                (
                    await connection.execute(
                        text(
                            "SELECT event_type,payload FROM session_events "
                            "WHERE session_id=:session"
                        ),
                        {"session": context.session_id},
                    )
                )
                .mappings()
                .all()
            )
        assert len([e for e in events if e["event_type"] == "voice.quality.summary.v1"]) == 1
        admission = next(e for e in events if e["event_type"] == "voice.call.admission.v1")
        assert len(admission["payload"]["fingerprint"]) == 64
        assert "+12025550123" not in json.dumps(admission["payload"])
    finally:
        await engine.dispose()
