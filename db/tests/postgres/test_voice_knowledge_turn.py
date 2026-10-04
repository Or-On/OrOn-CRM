"""Actual voice-role eligibility changes invalidate the per-turn fact snapshot."""

# ruff: noqa: E501, F811 -- Static SQL fixture and imported pytest fixture.
import asyncio
import json
from uuid import UUID, uuid4

import pytest
from oron_agent.knowledge_turn import TurnKnowledgeReader
from sqlalchemy import text

from db.tests.postgres.lead_capture_support import execute
from db.tests.postgres.test_voice_service_intake_runtime import service_runtime  # noqa: F401

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


@pytest.mark.parametrize(
    "change",
    [
        "revoked",
        "expired",
        "mutated",
        "archived",
        "foreign",
        "source_unpublished",
        "voice_disabled",
    ],
)
async def test_actual_authority_changes_reject_cached_knowledge(service_runtime, change):
    runtime, context, connection, _policy = service_runtime
    await connection.execute(text("RESET ROLE"))
    agent = (
        await execute(
            connection,
            "SELECT (payload->>'agent_version_id')::uuid FROM session_events "
            "WHERE session_id=:session AND event_type='voice.agent.binding.v1'",
            session=context.session_id,
        )
    ).scalar_one()
    source, document = uuid4(), uuid4()
    await execute(
        connection,
        "INSERT INTO agents.knowledge_sources(id,tenant_id,name,source_type,status) "
        "VALUES(:source,:tenant,'Synthetic facts','approved_manual','published')",
        source=source,
        tenant=context.tenant_id,
    )
    await execute(
        connection,
        "INSERT INTO agents.knowledge_documents(id,tenant_id,source_id,title,content_checksum,"
        "metadata,published_at,valid_from,valid_until) VALUES(:document,:tenant,:source,'Synthetic','fixture',"
        "CAST(:metadata AS jsonb),clock_timestamp(),clock_timestamp()-interval '1 minute',"
        "CASE WHEN :expiry THEN clock_timestamp()+interval '0.7 seconds' ELSE NULL END)",
        expiry=change == "expired",
        document=document,
        tenant=context.tenant_id,
        source=source,
        metadata=json.dumps(
            {"schemaVersion": "1.0", "facts": [{"factKey": "hours", "value": "Nine"}]}
        ),
    )
    agent = (
        await execute(
            connection,
            "INSERT INTO agents.agent_profile_versions(tenant_id,agent_profile_id,version,"
            "system_prompt,locale,channel_capabilities,knowledge_configuration,validation_status,published_at) "
            "SELECT tenant_id,agent_profile_id,version+1,system_prompt,locale,channel_capabilities,"
            "CAST(:config AS jsonb),'valid',clock_timestamp() FROM agents.agent_profile_versions "
            "WHERE id=:agent RETURNING id",
            agent=agent,
            config=json.dumps({"schemaVersion": "1.0", "sourceIds": [str(source)]}),
        )
    ).scalar_one()
    await connection.execute(text("SET LOCAL ROLE platform_voice"))

    async def load():
        return await runtime.get_voice_knowledge(agent, tenant_id=context.tenant_id)

    authority_tenant = context.tenant_id

    async def revisions():
        return await runtime.get_voice_knowledge_revisions(agent, tenant_id=authority_tenant)

    reader = TurnKnowledgeReader(load, revisions)
    initial = await reader.begin_turn()
    assert initial[0]["facts"][0]["value"] == "Nine"
    assert await reader.for_speech() == initial
    assert await runtime.get_voice_knowledge(agent, tenant_id=uuid4()) == []
    await connection.execute(text("RESET ROLE"))
    if change == "revoked":
        await execute(
            connection,
            "UPDATE agents.knowledge_documents SET revoked_at=clock_timestamp() WHERE id=:document",
            document=document,
        )
    elif change == "expired":
        await asyncio.sleep(0.8)
    elif change == "mutated":
        await execute(
            connection,
            "INSERT INTO agents.knowledge_documents(tenant_id,source_id,title,content_checksum,"
            "metadata,published_at,valid_from) VALUES(:tenant,:source,'Replacement','new',"
            "CAST(:metadata AS jsonb),clock_timestamp(),clock_timestamp()-interval '1 minute')",
            tenant=context.tenant_id,
            source=source,
            metadata=json.dumps(
                {"schemaVersion": "1.0", "facts": [{"factKey": "hours", "value": "Ten"}]}
            ),
        )
    elif change == "archived":
        await execute(
            connection,
            "UPDATE agents.agent_profiles SET archived_at=clock_timestamp() "
            "WHERE id=(SELECT agent_profile_id FROM agents.agent_profile_versions WHERE id=:agent)",
            agent=agent,
        )
    elif change == "source_unpublished":
        await execute(
            connection,
            "UPDATE agents.knowledge_sources SET status='draft' WHERE id=:source",
            source=source,
        )
    elif change == "voice_disabled":
        await execute(
            connection,
            "INSERT INTO platform.tenant_feature_entitlements"
            "(tenant_id,feature_key,available,enabled,granted_at) "
            "VALUES(:tenant,'voice',true,false,clock_timestamp()) "
            "ON CONFLICT(tenant_id,feature_key) DO UPDATE SET enabled=false",
            tenant=context.tenant_id,
        )
    else:
        authority_tenant = UUID(int=1)
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    assert await reader.for_speech() == []
