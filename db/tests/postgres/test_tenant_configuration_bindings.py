"""Reviewed routing admits exact versions while running conversations stay pinned."""

import json
from uuid import uuid4

import asyncpg
import pytest

from db.tests.postgres.test_tenant_configuration_approval import package, review, scope, setup

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def versions(pg, tenant, *, permissions=None, lead_schema_id=None):
    await pg.execute("RESET ROLE")
    profile, flow = uuid4(), uuid4()
    await pg.execute(
        "INSERT INTO agents.agent_profiles(id,tenant_id,name) VALUES($1,$2,'Reviewed fixture')",
        profile,
        tenant,
    )
    await pg.execute(
        "INSERT INTO automation.flow_definitions(id,tenant_id,name,channel_capabilities) "
        "VALUES($1,$2,'Reviewed flow',ARRAY['whatsapp','voice'])",
        flow,
        tenant,
    )
    result = []
    for version in (1, 2):
        agent, flow_version = uuid4(), uuid4()
        await pg.execute(
            "INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,"
            "system_prompt,channel_capabilities,tool_permissions,channel_configuration,"
            "validation_status,published_at) "
            "VALUES($1,$2,$3,$4,'Fictional support agent',ARRAY['whatsapp','voice'],$5::jsonb,"
            "$6::jsonb,'valid',CURRENT_TIMESTAMP)",
            agent,
            tenant,
            profile,
            version,
            json.dumps(["ticket.open"] if permissions is None else permissions),
            json.dumps({"leadFieldSchemaId": str(lead_schema_id)} if lead_schema_id else {}),
        )
        await pg.execute(
            "INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,"
            "schema_version,definition,agent_profile_version_id,validation_status,published_at) "
            "VALUES($1,$2,$3,$4,'1.0',$5::jsonb,$6,'valid',CURRENT_TIMESTAMP)",
            flow_version,
            tenant,
            flow,
            version,
            json.dumps(
                {
                    "nodes": [
                        {
                            "id": "reply",
                            "type": "ai.reply",
                            "configuration": {"agentVersionId": str(agent)},
                        }
                    ]
                }
            ),
            agent,
        )
        result.append((agent, flow_version))
    return result


def configuration(binding, *, service=False):
    agent, flow_version = binding
    features = ["contacts", "agents", "whatsapp", "voice", "tickets"]
    if service:
        features.append("field_service")
    return package(
        features,
        [
            {
                "name": "WhatsApp intake",
                "purpose": "Fictional reviewed support",
                "enabled": True,
                "trigger": "whatsapp.new_conversation",
                "channel": "whatsapp",
                "businessObject": "service_case" if service else "ticket",
                "agentProfileVersionId": str(agent),
                "flowVersionId": str(flow_version),
                "priority": 100,
            },
            {
                "name": "Telephone intake",
                "purpose": "Fictional reviewed support",
                "enabled": True,
                "trigger": "voice.inbound",
                "channel": "voice",
                "businessObject": "service_case" if service else "ticket",
                "agentProfileVersionId": str(agent),
                "flowVersionId": str(flow_version),
                "priority": 100,
            },
        ],
    )


async def approve(pg, payload, expected):
    await pg.execute(
        "SELECT platform.save_tenant_configuration_draft($1::jsonb,$2,'binding-test')",
        json.dumps(payload),
        expected,
    )
    revision = expected + 1 if expected is not None else 1
    await review(pg, "submit", revision)
    await review(pg, "approve", revision + 1)


async def test_approval_activates_only_the_exact_reviewed_agent_and_flow_versions(pg):
    tenant, admin, _ = await setup(pg)
    first, successor = await versions(pg, tenant)
    await scope(pg, tenant, admin)
    assert not await pg.fetchval("SELECT platform.approved_agent_for_channel($1,'voice')", first[0])
    await approve(pg, configuration(first), 1)
    bindings = await pg.fetch(
        "SELECT channel,agent_profile_version_id,flow_version_id FROM automation.tenant_processes "
        "WHERE enabled ORDER BY channel"
    )
    assert [row["channel"] for row in bindings] == ["voice", "whatsapp"]
    assert all(row["agent_profile_version_id"] == first[0] for row in bindings)
    assert all(row["flow_version_id"] == first[1] for row in bindings)
    for channel in ("voice", "whatsapp"):
        assert await pg.fetchval(
            "SELECT platform.approved_agent_for_channel($1,$2)", first[0], channel
        )
        assert not await pg.fetchval(
            "SELECT platform.approved_agent_for_channel($1,$2)", successor[0], channel
        )


async def test_direct_process_change_cannot_activate_an_unreviewed_published_version(pg):
    tenant, admin, _ = await setup(pg)
    first, successor = await versions(pg, tenant)
    await scope(pg, tenant, admin)
    await approve(pg, configuration(first), 1)
    with pytest.raises(asyncpg.PostgresError, match="approv"):
        async with pg.transaction():
            await pg.execute(
                "UPDATE automation.tenant_processes SET agent_profile_version_id=$1,"
                "flow_version_id=$2 WHERE channel='voice'",
                *successor,
            )
    assert not await pg.fetchval(
        "SELECT platform.approved_agent_for_channel($1,'voice')", successor[0]
    )


@pytest.mark.parametrize(
    ("trigger", "approved_channel"),
    [
        ("voice.inbound", "voice"),
        ("whatsapp.new_conversation", "whatsapp"),
        ("manual.contact_action", None),
    ],
)
async def test_null_process_channel_does_not_approve_unreviewed_channels(
    pg, trigger, approved_channel
):
    tenant, admin, _ = await setup(pg)
    first, _ = await versions(pg, tenant)
    await scope(pg, tenant, admin)
    payload = configuration(first)
    process = payload["processes"][0]
    process["trigger"] = trigger
    process["channel"] = None
    payload["processes"] = [process]
    await approve(pg, payload, 1)
    for channel in ("voice", "whatsapp"):
        assert await pg.fetchval(
            "SELECT platform.approved_agent_for_channel($1,$2)", first[0], channel
        ) == (channel == approved_channel)


async def test_newer_flow_for_approved_agent_does_not_activate_without_review(pg):
    tenant, admin, _ = await setup(pg)
    first, _ = await versions(pg, tenant)
    await pg.execute("RESET ROLE")
    newer_flow = uuid4()
    await pg.execute(
        "INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,"
        "schema_version,definition,agent_profile_version_id,validation_status,published_at) "
        "SELECT $1,tenant_id,flow_definition_id,3,schema_version,definition,"
        "agent_profile_version_id,'valid',CURRENT_TIMESTAMP "
        "FROM automation.flow_versions WHERE id=$2",
        newer_flow,
        first[1],
    )
    await scope(pg, tenant, admin)
    await approve(pg, configuration(first), 1)
    for channel in ("voice", "whatsapp"):
        assert await pg.fetchval(
            "SELECT platform.approved_flow_for_channel($1,$2,$3)", first[1], first[0], channel
        )
        assert not await pg.fetchval(
            "SELECT platform.approved_flow_for_channel($1,$2,$3)", newer_flow, first[0], channel
        )
    assert await pg.fetchval("SELECT platform.current_tenant_requires_approved_routing()")


async def test_existing_baseline_preserves_only_already_published_flows(pg):
    tenant, admin, _ = await setup(pg)
    first, _ = await versions(pg, tenant)
    await pg.execute("RESET ROLE")
    await pg.execute(
        "DELETE FROM platform.tenant_configuration_releases WHERE tenant_id=$1", tenant
    )
    await pg.execute(
        "INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,"
        "configuration,approved_at) VALUES($1,1,'published',$2::jsonb,CURRENT_TIMESTAMP)",
        tenant,
        json.dumps(package()),
    )
    newer_flow = uuid4()
    await pg.execute(
        "INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,"
        "schema_version,definition,agent_profile_version_id,validation_status,published_at) "
        "SELECT $1,tenant_id,flow_definition_id,3,schema_version,definition,"
        "agent_profile_version_id,'valid',CURRENT_TIMESTAMP+INTERVAL '1 second' "
        "FROM automation.flow_versions WHERE id=$2",
        newer_flow,
        first[1],
    )
    await scope(pg, tenant, admin)
    assert not await pg.fetchval("SELECT platform.current_tenant_requires_approved_routing()")
    assert await pg.fetchval(
        "SELECT platform.approved_flow_for_channel($1,$2,'voice')", first[1], first[0]
    )
    assert not await pg.fetchval(
        "SELECT platform.approved_flow_for_channel($1,$2,'voice')", newer_flow, first[0]
    )


async def test_conversation_switch_requires_approval_and_existing_binding_survives_publication(pg):
    tenant, admin, _ = await setup(pg)
    first, successor = await versions(pg, tenant)
    await scope(pg, tenant, admin)
    await approve(pg, configuration(first), 1)
    contact, channel, conversation = uuid4(), uuid4(), uuid4()
    await pg.execute(
        "INSERT INTO crm.contacts(id,tenant_id,name) VALUES($1,$2,'Fictional conversation caller')",
        contact,
        tenant,
    )
    await pg.execute(
        "INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,status) "
        "VALUES($1,$2,'whatsapp','simulator',$3,'active')",
        channel,
        tenant,
        str(channel),
    )
    await pg.execute(
        "INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,ownership_mode,"
        "ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) "
        "VALUES($1,$2,$3,$4,'ai',$5,$6,CURRENT_TIMESTAMP)",
        conversation,
        tenant,
        channel,
        contact,
        first[0],
        admin,
    )
    with pytest.raises(asyncpg.PostgresError, match="Approve"):
        async with pg.transaction():
            await pg.execute(
                "UPDATE messaging.conversations SET ai_agent_profile_version_id=$1 WHERE id=$2",
                successor[0],
                conversation,
            )
    await approve(pg, configuration(successor), None)
    assert not await pg.fetchval(
        "SELECT platform.approved_agent_for_channel($1,'whatsapp')", first[0]
    )
    assert await pg.fetchval(
        "SELECT platform.approved_agent_for_channel($1,'whatsapp')", successor[0]
    )
    # New routing changed; the existing conversation still owns its pinned version.
    await pg.execute(
        "UPDATE messaging.conversations SET last_message_preview='A later customer turn' "
        "WHERE id=$1",
        conversation,
    )
    assert (
        await pg.fetchval(
            "SELECT ai_agent_profile_version_id FROM messaging.conversations WHERE id=$1",
            conversation,
        )
        == first[0]
    )


@pytest.mark.parametrize("explicit_legacy_policy", [False, True])
async def test_voice_service_configuration_cannot_require_plaintext_national_id(
    pg, explicit_legacy_policy
):
    tenant, admin, _ = await setup(pg)
    first, _ = await versions(pg, tenant, permissions=["service.intake"])
    await scope(pg, tenant, admin)
    payload = configuration(first, service=True)
    if explicit_legacy_policy:
        payload["featureConfiguration"] = {
            "field_service": {
                "workflow": {
                    "version": 1,
                    "requiredIntakeFields": [
                        "customerName",
                        "customerPhone",
                        "faultDescription",
                        "nationalId",
                    ],
                    "photoPolicy": "optional",
                    "selfAssignmentEnabled": False,
                    "requiredReportFields": ["diagnosis", "workPerformed"],
                }
            }
        }
    await pg.execute(
        "SELECT platform.save_tenant_configuration_draft($1::jsonb,1,'test')", json.dumps(payload)
    )
    with pytest.raises(asyncpg.PostgresError, match="national|identity"):
        async with pg.transaction():
            await review(pg, "submit", 2)
