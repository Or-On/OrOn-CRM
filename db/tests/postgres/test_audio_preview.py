"""Real role/RLS preview authorization using fictional records and rollback only."""

import json
from uuid import uuid4

import pytest
from control_api.agent_evaluation import PostgresAgentEvaluationRepository
from control_api.audio_preview import PostgresAudioPreviewRepository
from control_api.auth import ServicePrincipal
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def test_preview_published_binding_current_manager_audit_and_readonly_grants(postgres_url):
    engine = create_async_engine(postgres_url.replace("postgresql://", "postgresql+asyncpg://", 1))
    tenant, other, user, profile, version, draft, legacy_profile, legacy_version = (
        uuid4() for _ in range(8)
    )
    source, document = uuid4(), uuid4()
    params = {
        "tenant": tenant,
        "other": other,
        "user": user,
        "profile": profile,
        "version": version,
        "draft": draft,
        "legacy_profile": legacy_profile,
        "legacy_version": legacy_version,
        "source": source,
        "document": document,
        "selection": json.dumps({"schemaVersion": "1.0", "sourceIds": [str(source)]}),
    }
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                for identifier in (tenant, other):
                    await connection.execute(
                        text(
                            "INSERT INTO tenants(id,name,slug) VALUES (:id,'Preview fixture',:slug)"
                        ),
                        {"id": identifier, "slug": f"preview-{identifier}"},
                    )
                await connection.execute(
                    text(
                        "INSERT INTO users(id,email,display_name) "
                        "VALUES (:user,:email,'Preview fixture')"
                    ),
                    {**params, "email": f"preview-{user}@example.invalid"},
                )
                await connection.execute(
                    text(
                        "INSERT INTO memberships(tenant_id,user_id,role) "
                        "VALUES (:tenant,:user,'admin')"
                    ),
                    params,
                )
                await connection.execute(
                    text(
                        "INSERT INTO agents.agent_profiles(id,tenant_id,name) VALUES "
                        "(:profile,:tenant,'Preview fixture'),"
                        "(:legacy_profile,:tenant,'Legacy preview fixture')"
                    ),
                    params,
                )
                await connection.execute(
                    text("""
                    INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,
                        system_prompt,locale,channel_capabilities,validation_status,published_at,
                        channel_configuration,knowledge_configuration)
                    VALUES (:legacy_version,:tenant,:legacy_profile,1,'Legacy fixture','he-IL',
                        ARRAY['voice'],'valid',CURRENT_TIMESTAMP,'{}'::jsonb,'{}'::jsonb)
                """),
                    params,
                )
                await connection.execute(
                    text("""
                    INSERT INTO agents.knowledge_sources(id,tenant_id,name,source_type,status)
                    VALUES (:source,:tenant,'Evaluation fixture','approved_manual','published')
                    """),
                    params,
                )
                await connection.execute(
                    text("""
                    INSERT INTO agents.knowledge_documents(id,tenant_id,source_id,title,
                      content_checksum,version,published_at,metadata)
                    VALUES (:document,:tenant,:source,'Opening hours','fixture',1,
                      CURRENT_TIMESTAMP,CAST(:facts AS jsonb))
                    """),
                    {
                        **params,
                        "facts": json.dumps(
                            {
                                "schemaVersion": "1.0",
                                "facts": [{"factKey": "opening.hours", "value": "Open at nine."}],
                            }
                        ),
                    },
                )
                await connection.execute(
                    text("""
                    INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,
                        system_prompt,channel_capabilities,validation_status,published_at,
                        channel_configuration,knowledge_configuration)
                    VALUES (:version,:tenant,:profile,1,'Fixture',ARRAY['voice'],'valid',
                        CURRENT_TIMESTAMP,CAST(:quality AS jsonb),CAST(:selection AS jsonb)),
                        (:draft,:tenant,:profile,2,'Draft',ARRAY['voice'],'pending',NULL,
                        CAST(:quality AS jsonb),CAST(:selection AS jsonb))
                """),
                    {
                        **params,
                        "quality": json.dumps(
                            {"quality": {"schemaVersion": "1.0", "language": "he"}}
                        ),
                    },
                )
                factory = async_sessionmaker(
                    bind=connection,
                    class_=AsyncSession,
                    expire_on_commit=False,
                    join_transaction_mode="create_savepoint",
                )
                repository = PostgresAudioPreviewRepository(factory)
                evaluator = PostgresAgentEvaluationRepository(factory)
                actor = ServicePrincipal(
                    user_id=user,
                    tenant_id=tenant,
                    session_id=uuid4(),
                    role="admin",
                    capability="orchestration:write",
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                assert await repository.load_audio_preview_quality(actor, profile, version) == {
                    "schemaVersion": "1.0",
                    "language": "he",
                }
                assert await repository.load_audio_preview_quality(
                    actor, legacy_profile, legacy_version
                ) == {"schemaVersion": "1.0", "language": "he"}
                legacy_context = await evaluator.load_evaluation_context(
                    actor, legacy_profile, legacy_version
                )
                assert legacy_context is not None
                assert legacy_context["quality"] == {"schemaVersion": "1.0", "language": "he"}
                assert legacy_context["knowledge"] == []
                assert await repository.load_audio_preview_quality(actor, profile, draft) is None
                context = await evaluator.load_evaluation_context(actor, profile, version)
                assert context["knowledge"][0]["documentId"] == str(document)
                assert context["knowledge"][0]["facts"][0]["value"] == "Open at nine."
                assert await evaluator.load_evaluation_context(actor, profile, draft) is None
                assert (
                    await evaluator.load_evaluation_context(
                        actor.model_copy(update={"tenant_id": other}), profile, version
                    )
                    is None
                )
                assert await repository.load_audio_preview_quality(actor, uuid4(), version) is None
                assert (
                    await repository.load_audio_preview_quality(
                        actor.model_copy(update={"tenant_id": other}), profile, version
                    )
                    is None
                )
                request_id = uuid4()
                await repository.audit_audio_preview(actor, version, request_id, "started")
                await connection.execute(text("RESET ROLE"))
                records = (
                    (
                        await connection.execute(
                            text("SELECT metadata FROM audit.records WHERE target_id=:version"),
                            params,
                        )
                    )
                    .scalars()
                    .all()
                )
                assert records == [{"requestId": str(request_id), "status": "started"}]
                # The latest published version suppresses older content, even
                # when legacy metadata is malformed or its validity is expired.
                for number, metadata in [(2, "[]"), (3, '{"schemaVersion":"1.0","facts":[]}')]:
                    await connection.execute(
                        text("""
                        INSERT INTO agents.knowledge_documents(tenant_id,source_id,title,
                          content_checksum,version,published_at,metadata,valid_from,valid_until)
                        VALUES (:tenant,:source,'Legacy shape',:checksum,:number,CURRENT_TIMESTAMP,
                          CAST(:metadata AS jsonb),CURRENT_TIMESTAMP-interval '2 days',
                          CASE WHEN :number=3 THEN CURRENT_TIMESTAMP-interval '1 day' ELSE NULL END)
                    """),
                        {
                            **params,
                            "number": number,
                            "metadata": metadata,
                            "checksum": f"fixture-version-{number}",
                        },
                    )
                    await connection.execute(text("SET LOCAL ROLE platform_voice"))
                    latest = await evaluator.load_evaluation_context(actor, profile, version)
                    assert all(not doc["facts"] for doc in latest["knowledge"])
                    await connection.execute(text("RESET ROLE"))
                await connection.execute(
                    text("UPDATE agents.knowledge_sources SET status='revoked' WHERE id=:source"),
                    params,
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                assert (await evaluator.load_evaluation_context(actor, profile, version))[
                    "knowledge"
                ] == []
                await connection.execute(text("RESET ROLE"))
                await connection.execute(
                    text(
                        "UPDATE memberships SET role='viewer' "
                        "WHERE tenant_id=:tenant AND user_id=:user"
                    ),
                    params,
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                assert await repository.load_audio_preview_quality(actor, profile, version) is None
                assert await evaluator.load_evaluation_context(actor, profile, version) is None
                assert (
                    await connection.scalar(
                        text("SELECT has_table_privilege('platform_voice','public.users','SELECT')")
                    )
                    is False
                )
                assert (
                    await connection.scalar(
                        text(
                            "SELECT has_table_privilege('platform_voice',"
                            "'agents.agent_profile_versions','UPDATE')"
                        )
                    )
                    is False
                )
                await connection.execute(text("RESET ROLE"))
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()
