from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import asyncpg
import pytest
import pytest_asyncio

from db.tests.postgres.conftest import run_alembic
from db.tests.postgres.test_authentication import _identity
from db.tests.postgres.test_billing_event_binding import billing_database  # noqa: F401

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


@pytest_asyncio.fixture(name="pg")
async def authorization_connection(
    billing_database: str,  # noqa: F811 — pytest resolves the imported fixture by name
) -> AsyncIterator[asyncpg.Connection]:
    connection = await asyncpg.connect(billing_database)
    try:
        async with connection.transaction():
            yield connection
    finally:
        await connection.close()


async def _session(pg: asyncpg.Connection, role: str = "admin") -> tuple[UUID, UUID, UUID]:
    user, tenant = await _identity(pg, role)
    now = datetime.now(UTC)
    session = await pg.fetchval(
        "SELECT platform.auth_create_session($1,$2,$3,$4,43200,$5,$6,NULL,NULL,'lock-test')",
        user,
        tenant,
        uuid4().bytes + uuid4().bytes,
        uuid4().bytes + uuid4().bytes,
        now + timedelta(hours=12),
        now + timedelta(days=7),
    )
    return user, tenant, session


async def _lock(
    pg: asyncpg.Connection,
    user: UUID,
    tenant: UUID,
    session: UUID,
    expected_role: str = "admin",
) -> bool:
    await pg.execute(
        "SELECT set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true)",
        str(tenant),
        str(user),
    )
    await pg.execute("SET LOCAL ROLE platform_web")
    return await pg.fetchval(
        "SELECT platform.lock_current_authorization($1,$2,false,0)",
        session,
        expected_role,
    )


@pytest.mark.parametrize("change", ["role", "tenant", "user", "revoked", "rotation", "expired"])
async def test_fresh_authorization_rejects_changed_identity(pg: asyncpg.Connection, change: str):
    user, tenant, session = await _session(pg)
    if change == "role":
        await pg.execute("UPDATE memberships SET role='viewer' WHERE user_id=$1", user)
    elif change == "tenant":
        await pg.execute("UPDATE tenants SET status='suspended' WHERE id=$1", tenant)
    elif change == "user":
        await pg.execute("UPDATE users SET status='suspended' WHERE id=$1", user)
    elif change == "revoked":
        await pg.execute(
            "UPDATE platform.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", session
        )
    elif change == "rotation":
        await pg.execute("UPDATE platform.auth_sessions SET rotation_count=1 WHERE id=$1", session)
    else:
        await pg.execute(
            "UPDATE platform.auth_sessions "
            "SET idle_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            session,
        )
    assert not await _lock(pg, user, tenant, session)


async def test_valid_identity_and_privilege_surface(pg: asyncpg.Connection):
    user, tenant, session = await _session(pg)
    assert await _lock(pg, user, tenant, session)
    assert not await pg.fetchval(
        "SELECT platform.lock_current_authorization($1,'owner',true,0)", session
    )
    assert not await pg.fetchval(
        "SELECT has_function_privilege('platform_messaging',"
        "'platform.lock_current_authorization(uuid,text,boolean,integer)','EXECUTE')"
    )


async def test_fresh_authorization_accepts_canonical_technician(
    pg: asyncpg.Connection,
) -> None:
    user, tenant, session = await _session(pg, "technician")
    assert await _lock(pg, user, tenant, session, "technician")


@pytest.mark.parametrize("change", ["role", "tenant", "revoked"])
async def test_revocation_waits_for_protected_transaction_and_next_write_is_denied(
    isolated_postgres_url: str,
    change: str,
):
    await run_alembic(isolated_postgres_url, "upgrade", "head")
    admin = await asyncpg.connect(isolated_postgres_url)
    work = await asyncpg.connect(isolated_postgres_url)
    revoker = await asyncpg.connect(isolated_postgres_url)
    try:
        user, tenant, session = await _session(admin)
        transaction = work.transaction()
        await transaction.start()
        assert await _lock(work, user, tenant, session)

        async def revoke():
            if change == "role":
                await revoker.execute("UPDATE memberships SET role='viewer' WHERE user_id=$1", user)
            elif change == "tenant":
                await revoker.execute("UPDATE tenants SET status='suspended' WHERE id=$1", tenant)
            else:
                await revoker.execute(
                    "UPDATE platform.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1",
                    session,
                )

        pending = asyncio.create_task(revoke())
        # Actual pg_stat_activity wait proves PostgreSQL lock contention, not a mock.
        for _ in range(100):
            waiting = await admin.fetchval(
                "SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=$1",
                revoker.get_server_pid(),
            )
            if waiting:
                break
            await asyncio.sleep(0.01)
        assert waiting and not pending.done()
        await transaction.commit()
        await asyncio.wait_for(pending, timeout=5)
        async with work.transaction():
            assert not await _lock(work, user, tenant, session)
    finally:
        await work.close()
        await revoker.close()
        await admin.close()
