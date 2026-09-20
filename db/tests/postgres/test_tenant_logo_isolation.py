from __future__ import annotations

from uuid import UUID, uuid4

import asyncpg
import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def _scope(pg: asyncpg.Connection, tenant: UUID, user: UUID) -> None:
    await pg.execute("RESET ROLE")
    await pg.execute("SET LOCAL ROLE platform_web")
    await pg.execute(
        "SELECT set_config('app.current_tenant',$1,true),"
        "set_config('app.current_user',$2,true),set_config('app.current_role','owner',true)",
        str(tenant),
        str(user),
    )


async def test_workspace_logos_remain_isolated_when_same_admin_switches_tenants(
    pg: asyncpg.Connection,
) -> None:
    """A workspace logo belongs to the selected tenant, not the signed-in user."""
    user, first, second = uuid4(), uuid4(), uuid4()
    await pg.execute(
        "INSERT INTO users(id,email,status,is_superuser) VALUES($1,$2,'active',true)",
        user,
        f"{user}@example.test",
    )
    for tenant in (first, second):
        await pg.execute(
            "INSERT INTO tenants(id,name,slug) VALUES($1,'Fictional logo workspace',$2)",
            tenant,
            f"logo-isolation-{tenant}",
        )
        await pg.execute(
            "INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'owner')", user, tenant
        )

    first_logo, second_logo, replacement, avatar = (
        b"fictional-workspace-a",
        b"fictional-workspace-b",
        b"fictional-workspace-a-revised",
        b"fictional-personal-avatar",
    )
    await _scope(pg, first, user)
    await pg.execute(
        "SELECT platform.set_current_user_avatar($1,'image/png','logo-test-avatar')", avatar
    )
    await pg.execute(
        "SELECT platform.set_current_tenant_logo($1,'image/png','logo-test-a')", first_logo
    )
    await _scope(pg, second, user)
    assert await pg.fetchval("SELECT data FROM platform.current_tenant_logo()") is None
    await pg.execute(
        "SELECT platform.set_current_tenant_logo($1,'image/png','logo-test-b')", second_logo
    )

    await _scope(pg, first, user)
    assert await pg.fetchval("SELECT data FROM platform.current_tenant_logo()") == first_logo
    await pg.execute(
        "SELECT platform.set_current_tenant_logo($1,'image/webp','logo-test-a-revised')",
        replacement,
    )
    await _scope(pg, second, user)
    assert await pg.fetchval("SELECT data FROM platform.current_tenant_logo()") == second_logo
    assert await pg.fetchval("SELECT data FROM platform.current_user_avatar()") == avatar

    await _scope(pg, first, user)
    assert await pg.fetchval("SELECT data FROM platform.current_tenant_logo()") == replacement
    await pg.execute("SELECT platform.set_current_tenant_logo(NULL,NULL,'logo-test-a-remove')")
    assert await pg.fetchval("SELECT data FROM platform.current_tenant_logo()") is None
    await _scope(pg, second, user)
    assert await pg.fetchval("SELECT data FROM platform.current_tenant_logo()") == second_logo
    assert await pg.fetchval("SELECT data FROM platform.current_user_avatar()") == avatar

    # Even a platform administrator's read returns only the active workspace.
    assert await pg.fetchval("SELECT count(*) FROM platform.current_tenant_logo()") == 1
