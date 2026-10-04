from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import asyncpg
import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def test_login_failure_does_not_extend_an_active_lock(pg: asyncpg.Connection) -> None:
    user_id, _ = await _identity(pg)
    deadline = datetime.now(UTC) + timedelta(minutes=5)
    await pg.execute(
        "INSERT INTO platform.auth_credentials "
        "(user_id,password_hash,failed_attempts,locked_until) "
        "VALUES ($1,'synthetic-test-hash',5,$2)",
        user_id,
        deadline,
    )
    await pg.execute("SELECT platform.auth_record_login_failure($1)", user_id)
    record = await pg.fetchrow(
        "SELECT failed_attempts,locked_until FROM platform.auth_credentials WHERE user_id=$1",
        user_id,
    )
    assert record["locked_until"] == deadline
    assert record["failed_attempts"] == 5


async def test_concurrent_failures_cannot_renew_the_threshold_lock(postgres_url: str) -> None:
    user_id = uuid4()
    admin = await asyncpg.connect(postgres_url)
    try:
        await admin.execute(
            "INSERT INTO users(id,email) VALUES($1,$2)",
            user_id,
            f"{user_id}@example.test",
        )
        await admin.execute(
            "INSERT INTO platform.auth_credentials(user_id,password_hash,failed_attempts) "
            "VALUES($1,'synthetic-test-hash',4)",
            user_id,
        )

        async def fail():
            conn = await asyncpg.connect(postgres_url)
            try:
                await conn.execute("SELECT platform.auth_record_login_failure($1)", user_id)
            finally:
                await conn.close()

        await asyncio.gather(*(fail() for _ in range(8)))
        first = await admin.fetchrow(
            "SELECT failed_attempts,locked_until FROM platform.auth_credentials WHERE user_id=$1",
            user_id,
        )
        assert first["failed_attempts"] == 5
        assert first["locked_until"] is not None
        await asyncio.gather(*(fail() for _ in range(8)))
        second = await admin.fetchrow(
            "SELECT failed_attempts,locked_until FROM platform.auth_credentials WHERE user_id=$1",
            user_id,
        )
        assert second == first
    finally:
        await admin.execute("DELETE FROM users WHERE id=$1", user_id)
        await admin.close()


async def _identity(pg: asyncpg.Connection, role: str = "owner") -> tuple[UUID, UUID]:
    tenant_id = uuid4()
    user_id = uuid4()
    await pg.execute(
        "INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)",
        tenant_id,
        "Phase 3 tenant",
        f"phase3-{tenant_id}",
    )
    await pg.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)",
        user_id,
        f"{user_id}@example.test",
    )
    await pg.execute(
        "INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)",
        user_id,
        tenant_id,
        role,
    )
    return user_id, tenant_id


async def test_auth_tables_are_private_and_function_surface_is_available(
    pg: asyncpg.Connection,
) -> None:
    for table in ("auth_credentials", "auth_sessions", "auth_one_time_tokens"):
        assert not await pg.fetchval(
            "SELECT has_table_privilege('platform_web', $1, 'SELECT')",
            f"platform.{table}",
        )
    assert await pg.fetchval(
        "SELECT has_function_privilege('platform_web', "
        "'platform.auth_resolve_session(bytea)', 'EXECUTE')"
    )


async def test_session_lifecycle_rotates_tenant_and_revokes(pg: asyncpg.Connection) -> None:
    user_id, tenant_a = await _identity(pg)
    tenant_b = uuid4()
    await pg.execute(
        "INSERT INTO tenants (id, name, slug) VALUES ($1, 'Phase 3 second', $2)",
        tenant_b,
        f"phase3-{tenant_b}",
    )
    await pg.execute(
        "INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'viewer')",
        user_id,
        tenant_b,
    )
    token_a = b"a" * 32
    csrf_a = b"c" * 32
    now = datetime.now(UTC)
    session_id = await pg.fetchval(
        "SELECT platform.auth_create_session($1,$2,$3,$4,43200,$5,$6,NULL,NULL,'phase3-test')",
        user_id,
        tenant_a,
        token_a,
        csrf_a,
        now + timedelta(hours=12),
        now + timedelta(days=7),
    )
    resolved = await pg.fetchrow("SELECT * FROM platform.auth_resolve_session($1)", token_a)
    assert resolved is not None
    assert resolved["session_id"] == session_id
    assert resolved["tenant_id"] == tenant_a
    assert resolved["role"] == "owner"

    token_b = b"b" * 32
    csrf_b = b"d" * 32
    assert await pg.fetchval(
        "SELECT platform.auth_switch_session_tenant($1,$2,$3,$4,'phase3-switch')",
        token_a,
        tenant_b,
        token_b,
        csrf_b,
    )
    assert await pg.fetchrow("SELECT * FROM platform.auth_resolve_session($1)", token_a) is None
    switched = await pg.fetchrow("SELECT * FROM platform.auth_resolve_session($1)", token_b)
    assert switched is not None
    assert switched["tenant_id"] == tenant_b
    assert switched["rotation_count"] == 1

    assert await pg.fetchval(
        "SELECT platform.auth_revoke_session($1,'user_logout','phase3-logout')", token_b
    )
    assert await pg.fetchrow("SELECT * FROM platform.auth_resolve_session($1)", token_b) is None
    actions = {
        row["action"]
        for row in await pg.fetch(
            "SELECT action FROM audit.records WHERE target_id = $1 ORDER BY occurred_at", session_id
        )
    }
    assert actions == {
        "auth.login.succeeded",
        "auth.session.revoked",
        "auth.tenant.switched",
    }


async def test_session_creation_rejects_non_members_and_expired_tokens(
    pg: asyncpg.Connection,
) -> None:
    user_id, tenant_id = await _identity(pg)
    foreign_tenant = uuid4()
    await pg.execute(
        "INSERT INTO tenants (id, name, slug) VALUES ($1, 'Foreign', $2)",
        foreign_tenant,
        f"phase3-{foreign_tenant}",
    )
    now = datetime.now(UTC)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval(
                "SELECT platform.auth_create_session($1,$2,$3,$4,43200,$5,$6,NULL,NULL,'blocked')",
                user_id,
                foreign_tenant,
                b"x" * 32,
                b"y" * 32,
                now + timedelta(hours=12),
                now + timedelta(days=7),
            )

    await pg.execute("UPDATE users SET status = 'disabled' WHERE id = $1", user_id)
    assert await pg.fetchrow(
        "SELECT * FROM platform.auth_login_record($1)", f"{user_id}@example.test"
    )
    assert tenant_id != foreign_tenant


async def test_last_owner_cannot_be_demoted_or_deleted(pg: asyncpg.Connection) -> None:
    user_id, tenant_id = await _identity(pg)
    with pytest.raises(asyncpg.CheckViolationError):
        async with pg.transaction():
            await pg.execute(
                "UPDATE memberships SET role = 'admin' WHERE user_id = $1 AND tenant_id = $2",
                user_id,
                tenant_id,
            )
    with pytest.raises(asyncpg.CheckViolationError):
        async with pg.transaction():
            await pg.execute(
                "DELETE FROM memberships WHERE user_id = $1 AND tenant_id = $2",
                user_id,
                tenant_id,
            )

    second_owner = uuid4()
    await pg.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)",
        second_owner,
        f"{second_owner}@example.test",
    )
    await pg.execute(
        "INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')",
        second_owner,
        tenant_id,
    )
    assert (
        await pg.execute(
            "UPDATE memberships SET role = 'admin' WHERE user_id = $1 AND tenant_id = $2",
            user_id,
            tenant_id,
        )
        == "UPDATE 1"
    )
