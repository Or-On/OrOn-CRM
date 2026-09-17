"""`public.phone_numbers` deliberately carries no RLS policy: the dispatcher
resolves an inbound DID before any tenant is known, so the row must be readable
without a tenant GUC. Everything tenant-facing that reads the table therefore
has to scope itself, and nothing in the database will catch it if one stops.
"""

from uuid import uuid4

import asyncpg
import pytest
from control_api.auth import ServicePrincipal
from control_api.voice import PostgresVoiceRepository

from db.tests.postgres.conftest import run_alembic

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def _tenant_with_number(connection: asyncpg.Connection, e164: str) -> tuple:
    tenant_id = uuid4()
    flow_id = uuid4()
    await connection.execute(
        "INSERT INTO tenants(id,name,slug) VALUES($1,$2,$3)",
        tenant_id,
        "Fictional DID Tenant",
        f"did-isolation-{tenant_id}",
    )
    await connection.execute(
        "INSERT INTO public.phone_numbers(id,tenant_id,e164,flow_id,dispatch_rule_id) "
        "VALUES($1,$2,$3,$4,$5)",
        uuid4(),
        tenant_id,
        e164,
        flow_id,
        f"simulator:{uuid4()}",
    )
    return tenant_id, e164


async def test_phone_numbers_has_no_policy_so_the_listing_must_scope_itself(
    pg: asyncpg.Connection,
) -> None:
    """Pin the premise. If someone later enables RLS here, inbound DID
    resolution breaks instead of silently narrowing this listing."""

    row = await pg.fetchrow(
        "SELECT relrowsecurity FROM pg_class WHERE oid='public.phone_numbers'::regclass"
    )
    assert row["relrowsecurity"] is False
    assert (
        await pg.fetchval("SELECT count(*) FROM pg_policies WHERE tablename='phone_numbers'") == 0
    )


async def test_an_operator_never_sees_another_tenants_numbers(
    isolated_postgres_url: str,
) -> None:
    await run_alembic(isolated_postgres_url, "upgrade", "head")
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        mine, my_number = await _tenant_with_number(connection, "+97235550111")
        _, their_number = await _tenant_with_number(connection, "+97235550222")
    finally:
        await connection.close()

    repository = PostgresVoiceRepository(isolated_postgres_url)
    principal = ServicePrincipal(
        user_id=uuid4(),
        tenant_id=mine,
        role="admin",
        session_id=uuid4(),
        capability="voice:read",
    )
    try:
        listed = await repository.list_phone_numbers(principal)
        reconciled = await repository.reconcile_phone_numbers(principal)
    finally:
        await repository.close()

    assert [number.e164 for number in listed] == [my_number]
    assert all(their_number not in finding for finding in reconciled.findings)
