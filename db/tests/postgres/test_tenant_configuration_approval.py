"""Real permission, version and atomic-publication boundaries for tenant setups."""

import json
from uuid import uuid4

import asyncpg
import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


def package(features=None, processes=None):
    return {
        "schemaVersion": 1,
        "templateKey": "leads_only",
        "features": features or ["contacts", "leads"],
        "featureConfiguration": {},
        "processes": processes or [],
    }


async def scope(pg, tenant, user):
    await pg.execute("RESET ROLE")
    await pg.execute("SET LOCAL ROLE platform_web")
    await pg.execute(
        "SELECT set_config('app.current_tenant',$1,true),"
        "set_config('app.current_user',$2,true),set_config('app.current_role','owner',true)",
        str(tenant),
        str(user),
    )


async def setup(pg):
    tenant, admin, owner = uuid4(), uuid4(), uuid4()
    await pg.execute(
        "INSERT INTO tenants(id,name,slug) VALUES($1,'Fictional reviewed workspace',$2)",
        tenant,
        f"review-{tenant}",
    )
    for user, superuser in ((admin, True), (owner, False)):
        await pg.execute(
            "INSERT INTO users(id,email,status,is_superuser) VALUES($1,$2,'active',$3)",
            user,
            f"{user}@example.test",
            superuser,
        )
        await pg.execute(
            "INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'owner')", user, tenant
        )
    await scope(pg, tenant, admin)
    await pg.execute(
        "SELECT platform.initialize_tenant_configuration($1,$2::jsonb,'initialize')",
        tenant,
        json.dumps(package()),
    )
    return tenant, admin, owner


async def enabled(pg):
    return {
        row["feature_key"]
        for row in await pg.fetch(
            "SELECT feature_key FROM platform.tenant_feature_entitlements WHERE enabled"
        )
    }


async def review(pg, action, revision):
    return await pg.fetchval(
        "SELECT platform.review_tenant_configuration($1,$2,'Test review','test')", action, revision
    )


async def test_new_tenant_stays_contacts_only_until_review_and_platform_approval(pg):
    tenant, admin, owner = await setup(pg)
    assert await enabled(pg) == {"contacts"}
    await scope(pg, tenant, owner)
    await review(pg, "submit", 1)
    assert await enabled(pg) == {"contacts"}
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await review(pg, "approve", 2)
    await scope(pg, tenant, admin)
    await review(pg, "approve", 2)
    assert await enabled(pg) == {"contacts", "leads"}
    row = await pg.fetchrow("SELECT * FROM platform.tenant_configuration_releases WHERE version=2")
    assert row["status"] == "published" and row["approved_by_user_id"] == admin
    assert row["approved_at"] is not None


async def test_stale_draft_and_stale_approval_cannot_overwrite_new_changes(pg):
    await setup(pg)
    await pg.execute(
        "SELECT platform.save_tenant_configuration_draft($1::jsonb,1,'edit')",
        json.dumps(package(["contacts", "tickets"])),
    )
    with pytest.raises(asyncpg.SerializationError):
        async with pg.transaction():
            await review(pg, "submit", 1)
    await review(pg, "submit", 2)
    with pytest.raises(asyncpg.SerializationError):
        async with pg.transaction():
            await review(pg, "approve", 2)
    assert await enabled(pg) == {"contacts"}
    await review(pg, "approve", 3)
    assert await enabled(pg) == {"contacts", "tickets"}


async def test_draft_rejection_preserves_active_package_and_approval_history(pg):
    await setup(pg)
    await review(pg, "submit", 1)
    await review(pg, "approve", 2)
    await pg.execute(
        "SELECT platform.save_tenant_configuration_draft($1::jsonb,NULL,'edit')",
        json.dumps(package(["contacts", "tickets"])),
    )
    await review(pg, "submit", 1)
    await review(pg, "reject", 2)
    assert await enabled(pg) == {"contacts", "leads"}
    assert await pg.fetchval("SELECT count(*) FROM platform.tenant_configuration_releases") == 3
    assert (
        await pg.fetchval(
            "SELECT status FROM platform.tenant_configuration_releases WHERE version=3"
        )
        == "rejected"
    )


async def test_direct_module_edit_cannot_bypass_the_review_package(pg):
    await setup(pg)
    revision = await pg.fetchval(
        "SELECT revision FROM platform.tenant_feature_entitlements WHERE feature_key='tickets'"
    )
    with pytest.raises(asyncpg.PostgresError, match="approval"):
        async with pg.transaction():
            await pg.execute(
                "SELECT platform.set_current_tenant_feature("
                "'tickets',true,'{}',1,$1,'operator','bypass')",
                revision,
            )
    assert await enabled(pg) == {"contacts"}
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute(
                "UPDATE platform.tenant_configuration_releases "
                "SET status='published' WHERE status='draft'"
            )


async def test_active_process_requires_published_same_tenant_versions(pg):
    await setup(pg)
    configuration = package(
        ["contacts", "agents", "voice", "tickets"],
        [
            {
                "name": "Support",
                "trigger": "voice.inbound",
                "channel": "voice",
                "enabled": True,
                "agentProfileVersionId": str(uuid4()),
                "flowVersionId": str(uuid4()),
                "priority": 100,
            }
        ],
    )
    await pg.execute(
        "SELECT platform.save_tenant_configuration_draft($1::jsonb,1,'edit')",
        json.dumps(configuration),
    )
    with pytest.raises(asyncpg.PostgresError, match="published"):
        async with pg.transaction():
            await review(pg, "submit", 2)
    assert await enabled(pg) == {"contacts"}


async def test_release_history_is_tenant_isolated(pg):
    tenant, admin, _owner = await setup(pg)
    other = uuid4()
    await pg.execute("RESET ROLE")
    await pg.execute(
        "INSERT INTO tenants(id,name,slug) VALUES($1,'Other fictional tenant',$2)",
        other,
        f"other-{other}",
    )
    await scope(pg, other, admin)
    assert await pg.fetchval("SELECT count(*) FROM platform.tenant_configuration_releases") == 0
    await scope(pg, tenant, admin)
    assert await pg.fetchval("SELECT count(*) FROM platform.tenant_configuration_releases") == 2


async def test_legacy_service_settings_cannot_bypass_reviewed_activation(pg):
    tenant, admin, _ = await setup(pg)
    await pg.execute(
        "SELECT platform.set_tenant_feature_entitlement($1,true,'fixture-entitlement')", tenant
    )
    with pytest.raises(asyncpg.PostgresError, match="approved workspace"):
        async with pg.transaction():
            await pg.execute(
                "SELECT service.configure_current_tenant("
                "true,false,false,false,false,true,'none',NULL,'legacy-bypass')"
            )
    # The integration settings endpoint remains usable without changing activation.
    await pg.execute(
        "SELECT service.configure_current_tenant("
        "false,false,false,false,false,true,'none',NULL,'integration-settings')"
    )
    assert not await pg.fetchval("SELECT platform.current_tenant_feature_enabled('field_service')")
    await scope(pg, tenant, admin)
    await pg.execute(
        "SELECT platform.save_tenant_configuration_draft($1::jsonb,1,'service-package')",
        json.dumps(package(["contacts", "tickets", "field_service"])),
    )
    await review(pg, "submit", 2)
    await review(pg, "approve", 3)
    assert await pg.fetchval("SELECT platform.current_tenant_feature_enabled('field_service')")
    await pg.execute(
        "SELECT service.configure_current_tenant("
        "true,false,false,false,false,true,'none',NULL,'integration-settings')"
    )
    with pytest.raises(asyncpg.PostgresError, match="approved workspace"):
        async with pg.transaction():
            await pg.execute(
                "SELECT service.configure_current_tenant("
                "false,false,false,false,false,true,'none',NULL,'legacy-disable')"
            )
    await pg.execute(
        "SELECT platform.set_tenant_feature_entitlement($1,true,'repeat-grant')", tenant
    )
    assert await pg.fetchval("SELECT platform.current_tenant_feature_enabled('field_service')")
    await pg.execute(
        "SELECT platform.set_tenant_feature_entitlement($1,false,'emergency-revoke')", tenant
    )
    assert not await pg.fetchval("SELECT platform.current_tenant_feature_enabled('field_service')")
    with pytest.raises(asyncpg.PostgresError):
        async with pg.transaction():
            await pg.execute(
                "SELECT service.configure_current_tenant("
                "true,false,false,false,false,true,'none',NULL,'revoked-enable')"
            )
    await pg.execute(
        "SELECT platform.set_tenant_feature_entitlement($1,true,'restore-entitlement')", tenant
    )
    # Regrant is not itself activation: the operator must restore the approved setup.
    assert not await pg.fetchval("SELECT platform.current_tenant_feature_enabled('field_service')")
