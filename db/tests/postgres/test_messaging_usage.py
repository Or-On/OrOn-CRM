from uuid import uuid4

import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration]


async def test_usage_is_idempotent_scoped_and_cannot_update_foreign_event(pg):
    tenant, foreign, event = uuid4(), uuid4(), uuid4()
    for value in (tenant, foreign):
        await pg.execute(
            "INSERT INTO tenants(id,name,slug) VALUES($1,'Fictional usage tenant',$2)",
            value,
            str(value),
        )
    await pg.execute("SET LOCAL ROLE platform_messaging")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    assert await pg.fetchval("SELECT agents.record_messaging_usage($1,23,7,145)", event)
    assert not await pg.fetchval("SELECT agents.record_messaging_usage($1,999,999,999)", event)
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(foreign))
    assert not await pg.fetchval("SELECT agents.record_messaging_usage($1,666,666,666)", event)
    await pg.execute("RESET ROLE")
    row = await pg.fetchrow(
        "SELECT tenant_id,input_tokens,output_tokens,latency_ms,model_configuration_id "
        "FROM agents.usage_events WHERE id=$1",
        event,
    )
    assert tuple(row.values()) == (tenant, 23, 7, 145, None)


async def test_usage_rejects_invalid_counts_without_inserting(pg):
    tenant = uuid4()
    await pg.execute(
        "INSERT INTO tenants(id,name,slug) VALUES($1,'Fictional usage tenant',$2)",
        tenant,
        str(tenant),
    )
    await pg.execute("SET LOCAL ROLE platform_messaging")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    with pytest.raises(Exception, match="invalid usage event"):
        await pg.fetchval("SELECT agents.record_messaging_usage($1,-1,0,1)", uuid4())
