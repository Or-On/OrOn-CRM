from __future__ import annotations

import asyncio
import subprocess
from collections.abc import AsyncIterator
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4

import asyncpg
import pytest
import pytest_asyncio

from db.tests.postgres.conftest import run_alembic
from db.tests.postgres.test_authentication import _identity

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


@pytest_asyncio.fixture(scope="module")
async def billing_database(postgres_url: str) -> AsyncIterator[str]:
    # Never mutate a caller database when checking a newly revised migration.
    name = f"oron_billing_test_{uuid4().hex}"
    parsed = urlsplit(postgres_url)
    target = urlunsplit((parsed.scheme, parsed.netloc, f"/{name}", parsed.query, ""))
    admin = await asyncpg.connect(postgres_url)
    try:
        await admin.execute(f'CREATE DATABASE "{name}"')  # noqa: S608
        await run_alembic(target, "upgrade", "head")
        yield target
    finally:
        await admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')  # noqa: S608
        await admin.close()


@pytest_asyncio.fixture
async def pg(billing_database: str) -> AsyncIterator[asyncpg.Connection]:
    connection = await asyncpg.connect(billing_database)
    try:
        async with connection.transaction():
            yield connection
            # Tests use unique fictional identities; whole DB is dropped after module.
    finally:
        await connection.close()


async def _topup(pg: asyncpg.Connection) -> tuple[UUID, UUID]:
    user, tenant = await _identity(pg)
    await pg.execute("INSERT INTO billing.wallets(tenant_id,currency) VALUES($1,'USD')", tenant)
    topup = await pg.fetchval(
        "INSERT INTO billing.topups(tenant_id,requested_by_user_id,amount_minor,currency,"
        "provider,idempotency_key,expected_customer_id,provider_session_id) "
        "VALUES($1,$2,1000,'USD','stripe',$3,'cus_fictional',$4) RETURNING id",
        tenant,
        user,
        str(uuid4()),
        f"cs_{tenant.hex}",
    )
    return tenant, topup


async def _complete(
    pg: asyncpg.Connection, tenant: UUID, topup: UUID, /, **changes: object
) -> bool:
    params: dict[str, object] = {
        "tenant": tenant,
        "topup": topup,
        "session": f"cs_{tenant.hex}",
        "customer": "cus_fictional",
        "amount": 1000,
        "currency": "USD",
    }
    params.update(changes)
    return await pg.fetchval(
        "SELECT billing.complete_stripe_topup($1,$2,$3,$4,$5,$6)", *params.values()
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"tenant": uuid4()},
        {"topup": uuid4()},
        {"session": "cs_other"},
        {"customer": "cus_other"},
        {"amount": 2000},
        {"currency": "EUR"},
    ],
)
async def test_only_exact_topup_tuple_can_credit(pg: asyncpg.Connection, changes: dict) -> None:
    tenant, topup = await _topup(pg)
    await pg.execute("SET LOCAL ROLE platform_web")
    assert not await _complete(pg, tenant, topup, **changes)
    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval("SELECT available_minor FROM billing.wallets WHERE tenant_id=$1", tenant)
        == 0
    )


async def test_matching_replayed_checkout_credits_once(pg: asyncpg.Connection) -> None:
    tenant, topup = await _topup(pg)
    await pg.execute("SET LOCAL ROLE platform_web")
    assert await _complete(pg, tenant, topup)
    assert await _complete(pg, tenant, topup)
    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval("SELECT available_minor FROM billing.wallets WHERE tenant_id=$1", tenant)
        == 1000
    )
    assert (
        await pg.fetchval("SELECT count(*) FROM billing.ledger_entries WHERE tenant_id=$1", tenant)
        == 1
    )


async def test_runtime_cannot_forge_money_or_use_legacy_unbound_functions(pg: asyncpg.Connection):
    for table, column in [
        ("wallets", "available_minor"),
        ("topups", "amount_minor"),
        ("topups", "status"),
        ("ledger_entries", "amount_minor"),
    ]:
        assert not await pg.fetchval(
            "SELECT has_column_privilege('platform_web',$1,$2,'UPDATE')",
            f"billing.{table}",
            column,
        )
    for signature in [
        "billing.complete_stripe_topup(uuid,text,bigint,text)",
        "billing.record_stripe_payment_source(uuid,text,text,text,text,integer,integer)",
    ]:
        assert not await pg.fetchval(
            "SELECT has_function_privilege('platform_web',$1,'EXECUTE')", signature
        )


async def _setup(pg: asyncpg.Connection) -> tuple[UUID, UUID, UUID]:
    user, tenant = await _identity(pg)
    customer = f"cus_{tenant.hex}"
    await pg.execute(
        "INSERT INTO billing.payment_profiles(tenant_id,stripe_customer_id,status) "
        "VALUES($1,$2,'pending')",
        tenant,
        customer,
    )
    first, second = uuid4(), uuid4()
    for request, offset in [(first, "2 minutes"), (second, "1 minute")]:
        await pg.execute(
            "INSERT INTO billing.payment_setup_requests(id,tenant_id,requested_by_user_id,"
            "expected_customer_id,idempotency_key,provider_session_id,created_at) "
            "VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP-$7::text::interval)",
            request,
            tenant,
            user,
            customer,
            str(request),
            f"cs_{request.hex}",
            offset,
        )
    return tenant, first, second


async def _record(
    pg: asyncpg.Connection, tenant: UUID, request: UUID, /, **changes: object
) -> bool:
    params: dict[str, object] = {
        "tenant": tenant,
        "request": request,
        "session": f"cs_{request.hex}",
        "customer": f"cus_{tenant.hex}",
        "intent": f"seti_{request.hex}",
        "method": f"pm_{request.hex}",
        "brand": "visa",
        "last4": "4242",
        "month": 12,
        "year": 2032,
    }
    params.update(changes)
    return await pg.fetchval(
        "SELECT billing.record_stripe_payment_source($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        *params.values(),
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"tenant": uuid4()},
        {"request": uuid4()},
        {"session": "cs_other"},
        {"customer": "cus_other"},
        {"intent": "invalid"},
        {"last4": "12345"},
        {"month": 0},
        {"year": 0},
        {"brand": None},
    ],
)
async def test_setup_binding_and_safe_metadata(pg: asyncpg.Connection, changes: dict) -> None:
    tenant, first, _second = await _setup(pg)
    await pg.execute("SET LOCAL ROLE platform_web")
    assert not await _record(pg, tenant, first, **changes)


async def test_setup_replay_and_out_of_order_delivery_do_not_replace_latest_card(
    pg: asyncpg.Connection,
):
    tenant, first, second = await _setup(pg)
    await pg.execute("SET LOCAL ROLE platform_web")
    assert await _record(pg, tenant, second)
    assert await _record(pg, tenant, first)
    assert await _record(pg, tenant, second)
    assert not await _record(pg, tenant, second, intent="seti_other")
    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval(
            "SELECT stripe_payment_method_id FROM billing.payment_profiles WHERE tenant_id=$1",
            tenant,
        )
        == f"pm_{second.hex}"
    )
    assert (
        await pg.fetchval("SELECT status FROM billing.payment_setup_requests WHERE id=$1", first)
        == "superseded"
    )


async def test_setup_requests_fail_closed_without_or_with_other_tenant(pg: asyncpg.Connection):
    tenant, first, _second = await _setup(pg)
    await pg.execute("SET LOCAL ROLE platform_web")
    assert (
        await pg.fetchval("SELECT count(*) FROM billing.payment_setup_requests WHERE id=$1", first)
        == 0
    )
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(uuid4()))
    assert (
        await pg.fetchval("SELECT count(*) FROM billing.payment_setup_requests WHERE id=$1", first)
        == 0
    )
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    assert (
        await pg.fetchval("SELECT count(*) FROM billing.payment_setup_requests WHERE id=$1", first)
        == 1
    )


async def test_concurrent_checkout_and_card_events_and_downgrade_guard(isolated_postgres_url: str):
    await run_alembic(isolated_postgres_url, "upgrade", "head")
    admin = await asyncpg.connect(isolated_postgres_url)
    try:
        initial_head = await admin.fetchval("SELECT version_num FROM alembic_version")
        tenant, topup = await _topup(admin)
        card_tenant, first, second = await _setup(admin)

        async def delivery(number: int):
            connection = await asyncpg.connect(isolated_postgres_url)
            try:
                await connection.execute("SET ROLE platform_web")
                if number < 4:
                    return await _complete(connection, tenant, topup)
                return await _record(connection, card_tenant, first if number % 2 else second)
            finally:
                await connection.close()

        assert all(await asyncio.gather(*(delivery(number) for number in range(8))))
        assert (
            await admin.fetchval(
                "SELECT available_minor FROM billing.wallets WHERE tenant_id=$1", tenant
            )
            == 1000
        )
        assert (
            await admin.fetchval(
                "SELECT stripe_payment_method_id FROM billing.payment_profiles WHERE tenant_id=$1",
                card_tenant,
            )
            == f"pm_{second.hex}"
        )
        with pytest.raises(subprocess.CalledProcessError) as failure:
            await run_alembic(isolated_postgres_url, "downgrade", "6d9561f45598")
        assert "Billing binding data exists" in failure.value.stderr
        assert await admin.fetchval("SELECT version_num FROM alembic_version") == initial_head
        assert (
            await admin.fetchval(
                "SELECT count(*) FROM billing.ledger_entries WHERE tenant_id=$1", tenant
            )
            == 1
        )
    finally:
        await admin.close()
