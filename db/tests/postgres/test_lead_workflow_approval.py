"""Lead-labeled workflow approval requires executable, tenant-bound capture."""

import json
from uuid import uuid4

import asyncpg
import pytest

from db.tests.postgres.test_tenant_configuration_approval import (
    enabled,
    package,
    review,
    scope,
    setup,
)
from db.tests.postgres.test_tenant_configuration_bindings import approve, versions

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def lead_schema(pg, tenant, *, published=True, fields=None):
    await pg.execute("RESET ROLE")
    schema = uuid4()
    await pg.execute(
        "INSERT INTO crm.lead_field_schemas(id,tenant_id,name,version,definition,published_at) "
        "VALUES($1,$2,'Fictional reviewed enquiry',1,$3::jsonb,"
        "CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE NULL END)",
        schema,
        tenant,
        json.dumps(
            [{"key": "interest", "label": "Customer interest", "type": "text", "required": True}]
            if fields is None
            else fields
        ),
        published,
    )
    return schema


def lead_package(binding, *, channel="whatsapp", active=True):
    agent, flow = binding
    return package(
        ["contacts", "agents", "leads", "whatsapp", "voice", "tickets"],
        [
            {
                "name": "Customer enquiries",
                "trigger": "voice.inbound" if channel == "voice" else "whatsapp.new_conversation",
                "channel": channel,
                "enabled": active,
                "businessObject": "lead",
                "agentProfileVersionId": str(agent),
                "flowVersionId": str(flow),
            }
        ],
    )


@pytest.mark.parametrize("permissions", [[], ["ticket.open"], ["lead.read"], ["lead.finalize"]])
async def test_lead_workflow_cannot_be_submitted_without_write_capability(pg, permissions):
    tenant, admin, _ = await setup(pg)
    schema = await lead_schema(pg, tenant)
    first, _ = await versions(pg, tenant, permissions=permissions, lead_schema_id=schema)
    await scope(pg, tenant, admin)
    await pg.execute(
        "SELECT platform.save_tenant_configuration_draft($1::jsonb,1,'test')",
        json.dumps(lead_package(first)),
    )
    with pytest.raises(
        asyncpg.PostgresError, match="lead workflows require an agent with lead.write"
    ):
        async with pg.transaction():
            await review(pg, "submit", 2)
    assert await enabled(pg) == {"contacts"}
    assert await pg.fetchval("SELECT count(*) FROM automation.tenant_processes") == 0


@pytest.mark.parametrize("schema_state", ["missing", "malformed_id", "draft", "foreign", "empty"])
async def test_lead_workflow_requires_the_pinned_published_same_tenant_schema(pg, schema_state):
    tenant, admin, _ = await setup(pg)
    if schema_state == "foreign":
        foreign = uuid4()
        await pg.execute("RESET ROLE")
        await pg.execute(
            "INSERT INTO tenants(id,name,slug) VALUES($1,'Unrelated fictional tenant',$2)",
            foreign,
            f"unrelated-{foreign}",
        )
        schema = await lead_schema(pg, foreign)
    elif schema_state == "missing":
        schema = None
    elif schema_state == "malformed_id":
        schema = "not-a-schema-id"
    else:
        schema = await lead_schema(
            pg,
            tenant,
            published=schema_state != "draft",
            fields=[] if schema_state == "empty" else None,
        )
    first, _ = await versions(pg, tenant, permissions=["lead.write"], lead_schema_id=schema)
    await scope(pg, tenant, admin)
    await pg.execute(
        "SELECT platform.save_tenant_configuration_draft($1::jsonb,1,'test')",
        json.dumps(lead_package(first)),
    )
    with pytest.raises(asyncpg.PostgresError, match="pinned published lead field schema"):
        async with pg.transaction():
            await review(pg, "submit", 2)
    assert await enabled(pg) == {"contacts"}


@pytest.mark.parametrize("channel", ["voice", "whatsapp"])
async def test_reviewed_write_capable_lead_workflow_activates_on_either_channel(pg, channel):
    tenant, admin, _ = await setup(pg)
    schema = await lead_schema(pg, tenant)
    first, _ = await versions(pg, tenant, permissions=["lead.write"], lead_schema_id=schema)
    await scope(pg, tenant, admin)
    await approve(pg, lead_package(first, channel=channel), 1)
    assert await pg.fetchval("SELECT platform.approved_agent_for_channel($1,$2)", first[0], channel)
    assert (
        await pg.fetchval("SELECT business_object_type FROM automation.tenant_processes") == "lead"
    )


async def test_approval_rechecks_a_lead_package_submitted_before_the_guard_was_deployed(pg):
    tenant, admin, _ = await setup(pg)
    first, _ = await versions(pg, tenant, permissions=["ticket.open"])
    await scope(pg, tenant, admin)
    await pg.execute(
        "SELECT platform.save_tenant_configuration_draft($1::jsonb,1,'test')",
        json.dumps(lead_package(first)),
    )
    # Model an already-submitted pre-upgrade package; never relax application
    # role permissions just to bypass the submit guard in this fixture.
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE platform.tenant_configuration_releases SET status='submitted',revision=3 "
        "WHERE tenant_id=$1 AND status='draft'",
        tenant,
    )
    await scope(pg, tenant, admin)
    with pytest.raises(
        asyncpg.PostgresError, match="lead workflows require an agent with lead.write"
    ):
        async with pg.transaction():
            await review(pg, "approve", 3)
    assert await enabled(pg) == {"contacts"}


async def test_disabled_incomplete_lead_process_and_module_only_packages_remain_reviewable(pg):
    tenant, admin, _ = await setup(pg)
    await review(pg, "submit", 1)
    await review(pg, "approve", 2)
    assert await enabled(pg) == {"contacts", "leads"}
    await scope(pg, tenant, admin)
    payload = lead_package((uuid4(), uuid4()), active=False)
    payload["processes"][0].update(agentProfileVersionId=None, flowVersionId=None)
    await approve(pg, payload, None)
    assert await pg.fetchval("SELECT count(*) FROM automation.tenant_processes WHERE enabled") == 0
