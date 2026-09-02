from __future__ import annotations

from uuid import UUID, uuid4

import asyncpg
import pytest

from db.tests.postgres.test_authentication import _identity

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def _context(pg: asyncpg.Connection, tenant: UUID | None, user: UUID | None) -> None:
    await pg.execute(
        "SELECT set_config('app.current_tenant', $1, true), "
        "set_config('app.current_user', $2, true)",
        str(tenant) if tenant else "",
        str(user) if user else "",
    )


async def test_team_directory_is_scoped_and_identity_tables_stay_private(
    pg: asyncpg.Connection,
) -> None:
    actor, tenant_a = await _identity(pg)
    foreign_user, tenant_b = await _identity(pg)
    teammate = uuid4()
    await pg.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)", teammate, f"{teammate}@example.test"
    )
    await pg.execute(
        "INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'editor')",
        teammate,
        tenant_a,
    )
    await pg.execute("SET LOCAL ROLE platform_web")
    for table in ("public.users", "public.memberships"):
        assert not await pg.fetchval(
            "SELECT has_table_privilege(current_user, $1, 'SELECT')", table
        )
    assert await pg.fetchval(
        "SELECT has_function_privilege(current_user, 'platform.current_tenant_team()', 'EXECUTE')"
    )
    for tenant, user in ((None, None), (tenant_a, None), (None, actor), (tenant_b, actor)):
        await _context(pg, tenant, user)
        assert not await pg.fetch("SELECT * FROM platform.current_tenant_team()")
    await _context(pg, tenant_a, actor)
    rows = await pg.fetch("SELECT * FROM platform.current_tenant_team()")
    assert {row["user_id"] for row in rows} == {actor, teammate}
    assert next(row["role"] for row in rows if row["user_id"] == teammate) == "admin"
    await _context(pg, tenant_b, foreign_user)
    assert {
        row["user_id"] for row in await pg.fetch("SELECT * FROM platform.current_tenant_team()")
    } == {foreign_user}


async def test_team_directory_revocation_and_disabled_accounts_fail_closed(
    pg: asyncpg.Connection,
) -> None:
    owner, tenant = await _identity(pg)
    member = uuid4()
    await pg.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)", member, f"{member}@example.test"
    )
    await pg.execute(
        "INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'agent')",
        member,
        tenant,
    )
    await _context(pg, tenant, member)
    await pg.execute("SET LOCAL ROLE platform_web")
    assert len(await pg.fetch("SELECT * FROM platform.current_tenant_team()")) == 2
    await pg.execute("RESET ROLE")
    await pg.execute(
        "DELETE FROM memberships WHERE user_id = $1 AND tenant_id = $2", member, tenant
    )
    await pg.execute("SET LOCAL ROLE platform_web")
    assert not await pg.fetch("SELECT * FROM platform.current_tenant_team()")
    await pg.execute("RESET ROLE")
    await pg.execute("UPDATE users SET status = 'disabled' WHERE id = $1", owner)
    await _context(pg, tenant, owner)
    await pg.execute("SET LOCAL ROLE platform_web")
    assert not await pg.fetch("SELECT * FROM platform.current_tenant_team()")


async def test_team_directory_function_privileges_and_search_path(pg: asyncpg.Connection) -> None:
    row = await pg.fetchrow(
        "SELECT prosecdef, proconfig, proacl FROM pg_proc "
        "WHERE oid = 'platform.current_tenant_team()'::regprocedure"
    )
    assert row is not None and row["prosecdef"]
    assert row["proconfig"] == ["search_path=pg_catalog"]
    assert not await pg.fetchval(
        "SELECT EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) acl "
        "WHERE p.oid = 'platform.current_tenant_team()'::regprocedure AND acl.grantee = 0)"
    )
    for role in ("platform_messaging", "platform_voice", "platform_readonly"):
        assert not await pg.fetchval(
            "SELECT has_function_privilege($1, 'platform.current_tenant_team()', 'EXECUTE')",
            role,
        )
