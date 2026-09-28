"""Service-manager presentation follows reviewed activation and tenant isolation."""

import json

import asyncpg
import pytest

from db.tests.postgres.test_tenant_configuration_approval import enabled, review, scope, setup

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


def service_package(experience="service_manager", *, tickets=True):
    features = ["contacts", "agents", "voice", "whatsapp", "field_service"]
    if tickets:
        features.append("tickets")
    return {
        "schemaVersion": 1,
        "templateKey": "field_service",
        "features": features,
        "featureConfiguration": {"field_service": {"experience": experience}},
        "processes": [],
    }


async def test_presentation_activates_only_after_review_without_disabling_channels(pg):
    tenant, admin, owner = await setup(pg)
    await pg.execute("RESET ROLE")
    await pg.execute(
        "INSERT INTO platform.tenant_feature_entitlements"
        "(tenant_id,feature_key,available,enabled,granted_by_user_id,granted_at,source) "
        "VALUES($1,'field_service',true,false,$2,CURRENT_TIMESTAMP,'provisioning') "
        "ON CONFLICT(tenant_id,feature_key) DO UPDATE SET available=true",
        tenant,
        admin,
    )
    await scope(pg, tenant, owner)
    await pg.execute(
        "SELECT platform.save_tenant_configuration_draft($1::jsonb,1,'simple-service')",
        json.dumps(service_package()),
    )
    assert "field_service" not in await enabled(pg)
    await review(pg, "submit", 2)
    assert "voice" not in await enabled(pg)
    await scope(pg, tenant, admin)
    await review(pg, "approve", 3)
    assert {"tickets", "field_service", "voice", "whatsapp", "agents"} <= await enabled(pg)
    assert (
        await pg.fetchval(
            "SELECT configuration->>'experience' FROM platform.tenant_feature_entitlements "
            "WHERE feature_key='field_service'"
        )
        == "service_manager"
    )
    # A second tenant keeps its own package and sees no presentation change.
    await pg.execute("RESET ROLE")
    other_tenant, other_admin, _ = await setup(pg)
    await scope(pg, other_tenant, other_admin)
    assert await enabled(pg) == {"contacts"}
    assert not await pg.fetchval(
        "SELECT EXISTS(SELECT 1 FROM platform.tenant_feature_entitlements "
        "WHERE configuration->>'experience'='service_manager')"
    )
    await scope(pg, tenant, admin)
    # Returning to the standard presentation retains all active capabilities.
    await pg.execute(
        "SELECT platform.save_tenant_configuration_draft($1::jsonb,NULL,'standard-service')",
        json.dumps(service_package("standard")),
    )
    await review(pg, "submit", 1)
    await review(pg, "approve", 2)
    assert {"voice", "whatsapp", "agents", "field_service"} <= await enabled(pg)


@pytest.mark.parametrize(
    "configuration",
    [service_package("unsupported"), service_package(None), service_package(tickets=False)],
)
async def test_database_rejects_invalid_or_incomplete_presentation_configuration(pg, configuration):
    tenant, admin, _ = await setup(pg)
    await scope(pg, tenant, admin)
    with pytest.raises(asyncpg.PostgresError):
        async with pg.transaction():
            await pg.execute(
                "SELECT platform.save_tenant_configuration_draft($1::jsonb,1,'invalid-service')",
                json.dumps(configuration),
            )
    assert await enabled(pg) == {"contacts"}
