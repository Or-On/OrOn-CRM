"""Actual PostgreSQL tenant-slug admission and concurrent-write regression."""

import asyncio
import os
from urllib.parse import urlsplit
from uuid import uuid4

import asyncpg
import pytest

pytestmark = pytest.mark.postgres


def _fixture_url() -> str:
    value = os.environ.get("TEST_DATABASE_URL")
    if value is None:
        pytest.skip("requires a disposable PostgreSQL test database")
    parsed = urlsplit(value)
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        pytest.skip("tenant slug regression requires an owned loopback fixture")
    if not parsed.path.startswith(("/oron_crm_", "/oron_ui_preview_", "/oron_test")):
        pytest.skip("tenant slug regression requires an explicitly named test fixture")
    return value


async def test_duplicate_slug_rejected_on_insert_and_update() -> None:
    connection = await asyncpg.connect(_fixture_url())
    first, second = uuid4(), uuid4()
    slug = "synthetic-slug-" + uuid4().hex
    try:
        await connection.execute(
            "INSERT INTO public.tenants(id,name,slug) VALUES($1,'Fictional slug A',$2)",
            first,
            slug,
        )
        with pytest.raises(asyncpg.UniqueViolationError, match="Tenant URL slug already exists"):
            await connection.execute(
                "INSERT INTO public.tenants(id,name,slug) VALUES($1,'Fictional slug B',$2)",
                second,
                slug,
            )
        await connection.execute(
            "INSERT INTO public.tenants(id,name,slug) VALUES($1,'Fictional slug B',$2)",
            second,
            slug + "-other",
        )
        with pytest.raises(asyncpg.UniqueViolationError, match="Tenant URL slug already exists"):
            await connection.execute("UPDATE public.tenants SET slug=$1 WHERE id=$2", slug, second)
        await connection.execute(
            "UPDATE public.tenants SET name='Renamed fictional tenant' WHERE id=$1", first
        )
        await connection.execute("UPDATE public.tenants SET slug=slug WHERE id=$1", first)
        assert (
            await connection.fetchval("SELECT count(*) FROM public.tenants WHERE slug=$1", slug)
            == 1
        )
        # A retained/deleted tenant still reserves the same URL identity.
        await connection.execute("UPDATE public.tenants SET status='deleted' WHERE id=$1", first)
        with pytest.raises(asyncpg.UniqueViolationError):
            await connection.execute("UPDATE public.tenants SET slug=$1 WHERE id=$2", slug, second)
    finally:
        await connection.execute(
            "DELETE FROM public.tenants WHERE id=ANY($1::uuid[])", [first, second]
        )
        await connection.close()


@pytest.mark.parametrize("isolation", ["read_committed", "repeatable_read"])
async def test_two_connections_same_slug_have_exactly_one_winner(isolation: str) -> None:
    first_connection = await asyncpg.connect(_fixture_url())
    second_connection = await asyncpg.connect(_fixture_url())
    first, second = uuid4(), uuid4()
    slug = "synthetic-race-" + uuid4().hex
    first_transaction = first_connection.transaction()
    second_transaction = second_connection.transaction(isolation=isolation)
    pending = None
    transaction_open = False
    second_transaction_open = False
    try:
        await first_transaction.start()
        transaction_open = True
        await second_transaction.start()
        second_transaction_open = True
        # Pin RR snapshot before the first writer even inserts.
        assert (
            await second_connection.fetchval(
                "SELECT count(*) FROM public.tenants WHERE slug=$1", slug
            )
            == 0
        )
        await first_connection.execute(
            "INSERT INTO public.tenants(id,name,slug) VALUES($1,'Fictional concurrent A',$2)",
            first,
            slug,
        )
        second_pid = await second_connection.fetchval("SELECT pg_backend_pid()")
        pending = asyncio.create_task(
            second_connection.execute(
                "INSERT INTO public.tenants(id,name,slug) VALUES($1,'Fictional concurrent B',$2)",
                second,
                slug,
            )
        )
        async with asyncio.timeout(5):
            while not await first_connection.fetchval(
                "SELECT cardinality(pg_blocking_pids($1))>0",
                second_pid,
            ):
                if pending.done():
                    pytest.fail("second concurrent insert did not wait on the canonical slug lock")
                await asyncio.sleep(0.01)
        await first_transaction.commit()
        transaction_open = False
        with pytest.raises(asyncpg.UniqueViolationError):
            await pending
        await second_transaction.rollback()
        second_transaction_open = False
        assert (
            await first_connection.fetchval(
                "SELECT count(*) FROM public.tenants WHERE slug=$1", slug
            )
            == 1
        )
    finally:
        if transaction_open:
            await first_transaction.rollback()
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        if second_transaction_open:
            await second_transaction.rollback()
        await first_connection.execute(
            "DELETE FROM public.tenants WHERE id=ANY($1::uuid[])", [first, second]
        )
        await first_connection.close()
        await second_connection.close()


async def test_caller_cannot_disable_new_slug_marker() -> None:
    connection = await asyncpg.connect(_fixture_url())
    tenant = uuid4()
    slug = "synthetic-marker-" + uuid4().hex
    try:
        await connection.execute(
            "INSERT INTO public.tenants(id,name,slug,slug_guarded) "
            "VALUES($1,'Fictional marker attempt',$2,false)",
            tenant,
            slug,
        )
        assert (
            await connection.fetchval(
                "SELECT slug_guarded FROM public.tenants WHERE id=$1",
                tenant,
            )
            is True
        )
        await connection.execute(
            "UPDATE public.tenants SET slug_guarded=false WHERE id=$1",
            tenant,
        )
        assert (
            await connection.fetchval(
                "SELECT slug_guarded FROM public.tenants WHERE id=$1",
                tenant,
            )
            is True
        )
        with pytest.raises(asyncpg.UniqueViolationError):
            await connection.execute(
                "INSERT INTO public.tenants(name,slug,slug_guarded) "
                "VALUES('Fictional marker bypass',$1,false)",
                slug,
            )
    finally:
        await connection.execute("DELETE FROM public.tenants WHERE id=$1", tenant)
        await connection.close()
