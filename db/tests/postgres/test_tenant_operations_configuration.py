from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID, uuid4

import asyncpg
import pytest

from db.tests.postgres.conftest import run_alembic

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


@dataclass(frozen=True)
class Tenant:
    id: UUID
    user: UUID


async def _tenant(pg: asyncpg.Connection, label: str, *, field_service: bool = False) -> Tenant:
    tenant, user = uuid4(), uuid4()
    await pg.execute(
        "INSERT INTO tenants(id,name,slug) VALUES($1,$2,$3)",
        tenant,
        label,
        f"tenant-config-{tenant}",
    )
    await pg.execute(
        "INSERT INTO users(id,email,status) VALUES($1,$2,'active')", user, f"{user}@example.test"
    )
    await pg.execute(
        "INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'owner')", user, tenant
    )
    # Start the fixture from the Blank template shape. Production's low-level
    # default remains broad only for backward compatibility; onboarding applies
    # an explicit template in the tenant-creation transaction.
    await pg.execute(
        "UPDATE platform.tenant_feature_entitlements SET enabled=(feature_key='contacts') "
        "WHERE tenant_id=$1",
        tenant,
    )
    if field_service:
        await pg.execute(
            "INSERT INTO platform.tenant_feature_entitlements"
            "(tenant_id,feature_key,available,enabled,granted_by_user_id,granted_at,source) "
            "VALUES($1,'field_service',true,false,$2,CURRENT_TIMESTAMP,'provisioning')",
            tenant,
            user,
        )
    return Tenant(tenant, user)


async def _scope(pg: asyncpg.Connection, tenant: Tenant) -> None:
    await pg.execute("RESET ROLE")
    await pg.execute("SET LOCAL ROLE platform_web")
    await pg.execute(
        "SELECT set_config('app.current_tenant',$1,true),"
        "set_config('app.current_user',$2,true),set_config('app.current_role','owner',true)",
        str(tenant.id),
        str(tenant.user),
    )


async def _set(pg: asyncpg.Connection, key: str, enabled: bool) -> None:
    revision = await pg.fetchval(
        "SELECT revision FROM platform.tenant_feature_entitlements WHERE feature_key=$1", key
    )
    assert revision is not None
    await pg.fetchval(
        "SELECT platform.set_current_tenant_feature($1,$2,'{}'::jsonb,1,$3,'operator',$4)",
        key,
        enabled,
        revision,
        f"test-{uuid4()}",
    )


async def _enable(pg: asyncpg.Connection, keys: tuple[str, ...]) -> None:
    for key in keys:
        await _set(pg, key, True)


async def _enabled(pg: asyncpg.Connection) -> set[str]:
    rows = await pg.fetch(
        "SELECT feature_key FROM platform.tenant_feature_entitlements "
        "WHERE platform.current_tenant_feature_enabled(feature_key) ORDER BY feature_key"
    )
    return {row["feature_key"] for row in rows}


async def test_four_tenants_can_hold_materially_different_module_sets(
    pg: asyncpg.Connection,
) -> None:
    field = await _tenant(pg, "Fictional Field Service", field_service=True)
    lead = await _tenant(pg, "Fictional Lead Generation")
    support = await _tenant(pg, "Fictional Support")
    minimal = await _tenant(pg, "Fictional Minimal")

    await _scope(pg, field)
    await _enable(
        pg,
        (
            "agents",
            "whatsapp",
            "voice",
            "documents",
            "field_service",
            "technicians",
            "ocr",
            "reports",
        ),
    )
    assert {"field_service", "technicians", "ocr"} <= await _enabled(pg)
    assert not {"leads", "tickets"} & await _enabled(pg)

    await _scope(pg, lead)
    await _enable(pg, ("agents", "whatsapp", "voice", "leads", "pipeline"))
    assert {"leads", "pipeline"} <= await _enabled(pg)
    assert not {"field_service", "tickets", "ocr"} & await _enabled(pg)

    await _scope(pg, support)
    await _enable(pg, ("agents", "whatsapp", "voice", "tickets"))
    assert "tickets" in await _enabled(pg)
    assert not {"leads", "field_service", "technicians"} & await _enabled(pg)

    await _scope(pg, minimal)
    assert await _enabled(pg) == {"contacts"}


async def test_dependency_disable_and_reenable_preserve_lead_data(
    pg: asyncpg.Connection,
) -> None:
    tenant = await _tenant(pg, "Fictional transitions")
    await _scope(pg, tenant)
    await _set(pg, "leads", True)
    with pytest.raises(asyncpg.PostgresError, match="required by enabled feature leads"):
        async with pg.transaction():
            await _set(pg, "contacts", False)
    contact = await pg.fetchval(
        "INSERT INTO crm.contacts(tenant_id,name) "
        "VALUES(platform.current_tenant_id(),'Fictional customer') RETURNING id"
    )
    await pg.execute("RESET ROLE")
    lead = await pg.fetchval(
        "INSERT INTO crm.leads(tenant_id,reference,contact_id,source_channel) "
        "VALUES($1,$2,$3,'manual') RETURNING id",
        tenant.id,
        f"LD-{uuid4().hex[:8]}",
        contact,
    )
    await _scope(pg, tenant)
    await _set(pg, "leads", False)
    assert await pg.fetchval("SELECT count(*) FROM crm.leads WHERE id=$1", lead) == 1
    with pytest.raises(asyncpg.PostgresError, match="tenant feature leads is disabled"):
        async with pg.transaction():
            await pg.execute("UPDATE crm.leads SET summary='must not write' WHERE id=$1", lead)
    await _set(pg, "leads", True)
    await pg.execute(
        "UPDATE crm.leads SET summary='preserved and writable again' WHERE id=$1", lead
    )
    assert (
        await pg.fetchval("SELECT summary FROM crm.leads WHERE id=$1", lead)
        == "preserved and writable again"
    )


async def test_feature_and_process_rows_are_rls_isolated_and_precedence_is_explicit(
    pg: asyncpg.Connection,
) -> None:
    first = await _tenant(pg, "Fictional routing one")
    second = await _tenant(pg, "Fictional routing two")
    await _scope(pg, first)
    process_id = await pg.fetchval(
        "INSERT INTO automation.tenant_processes(tenant_id,name,trigger_key,priority) "
        "VALUES(platform.current_tenant_id(),'Manual intake',"
        "'manual.contact_action',20) RETURNING id"
    )
    assert await pg.fetchval("SELECT count(*) FROM automation.tenant_processes") == 1
    await _scope(pg, second)
    assert await pg.fetchval("SELECT count(*) FROM automation.tenant_processes") == 0
    assert await pg.fetchval("SELECT count(*) FROM platform.tenant_feature_entitlements") == 13
    result = await pg.execute(
        "UPDATE automation.tenant_processes SET name='cross tenant' WHERE id=$1", process_id
    )
    assert result == "UPDATE 0"


async def test_configuration_revision_prevents_lost_updates(pg: asyncpg.Connection) -> None:
    tenant = await _tenant(pg, "Fictional concurrency")
    await _scope(pg, tenant)
    revision = await pg.fetchval(
        "SELECT revision FROM platform.tenant_feature_entitlements WHERE feature_key='leads'"
    )
    await pg.fetchval(
        "SELECT platform.set_current_tenant_feature("
        "'leads',true,'{}'::jsonb,1,$1,'operator','first')",
        revision,
    )
    with pytest.raises(asyncpg.SerializationError, match="revision conflict"):
        async with pg.transaction():
            await pg.fetchval(
                "SELECT platform.set_current_tenant_feature("
                "'leads',false,'{}'::jsonb,1,$1,'operator','stale')",
                revision,
            )


async def test_active_process_blocks_disable_and_cross_tenant_versions(
    pg: asyncpg.Connection,
) -> None:
    tenant = await _tenant(pg, "Fictional explicit process")
    await _scope(pg, tenant)
    await _enable(pg, ("agents", "whatsapp", "leads"))

    await pg.execute("RESET ROLE")
    profile = await pg.fetchval(
        "INSERT INTO agents.agent_profiles(tenant_id,name,created_by_user_id) "
        "VALUES($1,'Fictional lead agent',$2) RETURNING id",
        tenant.id,
        tenant.user,
    )
    agent_version = await pg.fetchval(
        "INSERT INTO agents.agent_profile_versions(tenant_id,agent_profile_id,version,"
        "system_prompt,channel_capabilities,tool_permissions,validation_status,published_at) "
        "VALUES($1,$2,1,'Handle fictional leads.',ARRAY['whatsapp'],'[\"lead.write\"]'::jsonb,"
        "'valid',CURRENT_TIMESTAMP) RETURNING id",
        tenant.id,
        profile,
    )
    definition = await pg.fetchval(
        "INSERT INTO automation.flow_definitions("
        "tenant_id,name,channel_capabilities,created_by_user_id) "
        "VALUES($1,'Fictional intake',ARRAY['whatsapp'],$2) RETURNING id",
        tenant.id,
        tenant.user,
    )
    flow_version = await pg.fetchval(
        "INSERT INTO automation.flow_versions(tenant_id,flow_definition_id,version,schema_version,"
        "definition,validation_status,published_at,agent_profile_version_id) "
        "VALUES($1,$2,1,'1.0',$3::jsonb,'valid',CURRENT_TIMESTAMP,$4) RETURNING id",
        tenant.id,
        definition,
        '{"schemaVersion":"1.0","channels":["whatsapp"],"nodes":[],"edges":[]}',
        agent_version,
    )
    await _scope(pg, tenant)
    process = await pg.fetchval(
        "INSERT INTO automation.tenant_processes(tenant_id,name,enabled,trigger_key,channel,"
        "business_object_type,agent_profile_version_id,flow_version_id,required_features,priority,"
        "created_by_user_id,updated_by_user_id) VALUES(platform.current_tenant_id(),"
        "'Fictional lead intake',true,'whatsapp.new_conversation','whatsapp','lead',$1,$2,"
        "ARRAY['contacts','agents','whatsapp','leads'],10,$3,$3) RETURNING id",
        agent_version,
        flow_version,
        tenant.user,
    )
    with pytest.raises(asyncpg.PostgresError, match="active process Fictional lead intake"):
        async with pg.transaction():
            await _set(pg, "leads", False)

    await pg.execute("RESET ROLE")
    other = await _tenant(pg, "Fictional cross-tenant process")
    await _scope(pg, other)
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO automation.tenant_processes(tenant_id,name,trigger_key,"
                "agent_profile_version_id,flow_version_id) VALUES(platform.current_tenant_id(),"
                "'Forbidden binding','manual.contact_action',$1,$2)",
                agent_version,
                flow_version,
            )

    await _scope(pg, tenant)
    await pg.execute(
        "UPDATE automation.tenant_processes SET enabled=false,revision=revision+1 WHERE id=$1",
        process,
    )
    await _set(pg, "leads", False)
    assert await pg.fetchval(
        "SELECT NOT enabled FROM automation.tenant_processes WHERE id=$1", process
    )
    await _set(pg, "leads", True)


async def test_administrator_template_application_is_idempotent(
    pg: asyncpg.Connection,
) -> None:
    tenant = await _tenant(pg, "Fictional template target")
    await pg.execute("UPDATE users SET is_superuser=true WHERE id=$1", tenant.user)
    await _scope(pg, tenant)
    await pg.fetchval(
        "SELECT platform.apply_tenant_template_for_administrator($1,'blank','template-first')",
        tenant.id,
    )
    revisions = dict(
        await pg.fetch("SELECT feature_key,revision FROM platform.tenant_feature_entitlements")
    )
    await pg.fetchval(
        "SELECT platform.apply_tenant_template_for_administrator($1,'blank','template-retry')",
        tenant.id,
    )
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM platform.tenant_template_applications "
            "WHERE template_key='blank' AND template_version=1"
        )
        == 1
    )
    assert (
        dict(
            await pg.fetch("SELECT feature_key,revision FROM platform.tenant_feature_entitlements")
        )
        == revisions
    )
    assert await _enabled(pg) == {"contacts"}


async def test_prechange_tenant_upgrades_with_behavior_and_records_preserved(
    isolated_postgres_url: str,
) -> None:
    await run_alembic(isolated_postgres_url, "upgrade", "e3b9d7f1a2c6")
    connection = await asyncpg.connect(isolated_postgres_url)
    tenant, user, contact = uuid4(), uuid4(), uuid4()
    try:
        await connection.execute(
            "INSERT INTO tenants(id,name,slug) VALUES($1,'Fictional legacy','fictional-legacy')",
            tenant,
        )
        await connection.execute(
            "INSERT INTO users(id,email,status) VALUES($1,$2,'active')",
            user,
            f"{user}@example.test",
        )
        await connection.execute(
            "INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'owner')",
            user,
            tenant,
        )
        await connection.execute(
            "INSERT INTO crm.contacts(id,tenant_id,name) VALUES($1,$2,'Preserved customer')",
            contact,
            tenant,
        )
        await connection.execute(
            "INSERT INTO crm.leads(tenant_id,reference,contact_id,source_channel) "
            "VALUES($1,'LD-PRESERVED',$2,'manual')",
            tenant,
            contact,
        )
        await connection.execute(
            "INSERT INTO platform.tenant_feature_entitlements"
            "(tenant_id,feature_key,available,granted_by_user_id,granted_at) "
            "VALUES($1,'field_service',true,$2,CURRENT_TIMESTAMP)",
            tenant,
            user,
        )
        await connection.execute(
            "INSERT INTO service.tenant_configuration(tenant_id,enabled,ocr_enabled) "
            "VALUES($1,true,true)",
            tenant,
        )
    finally:
        await connection.close()

    await run_alembic(isolated_postgres_url, "upgrade", "head")
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        states = {
            row["feature_key"]: row["enabled"]
            for row in await connection.fetch(
                "SELECT feature_key,enabled "
                "FROM platform.tenant_feature_entitlements WHERE tenant_id=$1",
                tenant,
            )
        }
        assert states["leads"] is True
        assert states["tickets"] is True
        assert states["field_service"] is True
        assert states["technicians"] is True
        assert states["ocr"] is True
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM crm.leads WHERE tenant_id=$1 AND reference='LD-PRESERVED'",
                tenant,
            )
            == 1
        )
    finally:
        await connection.close()

    await run_alembic(isolated_postgres_url, "downgrade", "e3b9d7f1a2c6")
    await run_alembic(isolated_postgres_url, "upgrade", "head")
