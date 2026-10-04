import importlib.util
from pathlib import Path
from uuid import uuid4

import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration]


async def test_equal_receipt_times_have_order_and_exhaustion_is_visible_per_tenant(pg, monkeypatch):
    # The fixture rolls back this DDL along with all synthetic records. This
    # verifies the pending migration even before the owned baseline is upgraded.
    if not await pg.fetchval(
        "SELECT EXISTS(SELECT 1 FROM information_schema.columns "
        "WHERE table_schema='ops' AND table_name='inbound_events' "
        "AND column_name='receipt_sequence')"
    ):
        path = Path(__file__).parents[2] / "alembic/versions/d1e7a304269b_inbound_receipt_order.py"
        spec = importlib.util.spec_from_file_location("receipt_migration", path)
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        statements = []
        monkeypatch.setattr(migration.op, "execute", statements.append)
        migration.upgrade()
        for statement in statements:
            await pg.execute(statement)
    tenant, other = uuid4(), uuid4()
    for value in (tenant, other):
        await pg.execute(
            "INSERT INTO public.tenants(id,name,slug) VALUES($1,'Fictional receipt tenant',$2)",
            value,
            str(value),
        )
    ids = [uuid4(), uuid4(), uuid4()]
    for index, event in enumerate(ids):
        await pg.execute(
            """INSERT INTO ops.inbound_events(
          id,tenant_id,provider,provider_account_id,provider_event_id,
          event_type,payload,received_at,status,attempts,max_attempts)
          VALUES($1,$2,'meta','fictional-account',$3,'whatsapp.message.text','{}','2026-01-01T00:00:00Z','failed',3,3)""",
            event,
            tenant if index < 2 else other,
            str(event),
        )
    rows = await pg.fetch(
        "SELECT id,receipt_sequence,received_at FROM ops.inbound_events "
        "WHERE id=ANY($1::uuid[]) ORDER BY receipt_sequence",
        ids,
    )
    assert [row["id"] for row in rows] == ids
    assert rows[0]["received_at"] == rows[1]["received_at"]
    await pg.execute("SET LOCAL ROLE platform_messaging")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    assert await pg.fetchval("SELECT ops.surface_exhausted_inbound()") == 2
    assert await pg.fetchval("SELECT ops.surface_exhausted_inbound()") == 0
    visible = await pg.fetch("SELECT event_id FROM ops.inbound_failure_alerts")
    assert {row["event_id"] for row in visible} == set(ids[:2])
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(other))
    assert await pg.fetchval("SELECT count(*) FROM ops.inbound_failure_alerts") == 0
    assert await pg.fetchval("SELECT ops.surface_exhausted_inbound()") == 1
    assert await pg.fetchval("SELECT count(*) FROM ops.inbound_failure_alerts") == 1


async def test_equal_time_claims_use_receipt_sequence_across_two_tenants(pg, monkeypatch):
    path = Path(__file__).parents[2] / "alembic/versions/d1e7a304269b_inbound_receipt_order.py"
    spec = importlib.util.spec_from_file_location("receipt_claim_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    statements = []
    monkeypatch.setattr(migration.op, "execute", statements.append)
    if not await pg.fetchval(
        "SELECT EXISTS(SELECT 1 FROM information_schema.columns "
        "WHERE table_schema='ops' AND table_name='inbound_events' "
        "AND column_name='receipt_sequence')"
    ):
        migration.upgrade()
    else:
        migration._claim(True)
    for statement in statements:
        await pg.execute(statement)
    tenants = [uuid4(), uuid4()]
    for tenant in tenants:
        await pg.execute(
            "INSERT INTO public.tenants(id,name,slug) VALUES($1,'Fictional FIFO tenant',$2)",
            tenant,
            str(tenant),
        )
    ids = [uuid4() for _ in range(4)]
    for index, event in enumerate(ids):
        await pg.execute(
            """INSERT INTO ops.inbound_events(
          id,tenant_id,provider,provider_account_id,provider_event_id,
          event_type,payload,received_at,available_at)
          VALUES($1,$2,'meta','fictional-fifo',$3,'whatsapp.message.text','{}','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z')""",
            event,
            tenants[index % 2],
            str(event),
        )
    actual = []
    for _ in ids:
        actual.append(
            await pg.fetchval(
                "SELECT id FROM ops.claim_inbound_events('fictional-fifo-worker',1,60)"
            )
        )
    assert actual == ids
