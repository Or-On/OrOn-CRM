from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import asyncpg
import pytest

from db.tests.postgres.test_authentication import _identity
from db.tests.postgres.test_platform_administration import _context

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


@pytest.mark.parametrize("status", ["suspended", "deleted"])
async def test_inactive_tenant_revokes_keys_without_erasing_history(
    pg: asyncpg.Connection, status: str
) -> None:
    user, tenant = await _identity(pg)
    key = uuid4()
    digest = f"readiness-{key}"
    await pg.execute(
        "INSERT INTO public.api_keys(id,hashed_key,tenant_id,kind,status,created_by_user_id) "
        "VALUES ($1,$2,$3,'tenant','active',$4)",
        key,
        digest,
        tenant,
        user,
    )
    await pg.execute("SET LOCAL ROLE platform_web")
    assert await pg.fetchrow("SELECT * FROM platform.resolve_api_key($1)", digest)
    await pg.execute("RESET ROLE")
    await pg.execute("UPDATE tenants SET status=$2 WHERE id=$1", tenant, status)
    assert await pg.fetchval("SELECT status FROM api_keys WHERE id=$1", key) == "revoked"
    await pg.execute("SET LOCAL ROLE platform_web")
    assert await pg.fetchrow("SELECT * FROM platform.resolve_api_key($1)", digest) is None
    await pg.execute("RESET ROLE")
    assert await pg.fetchval("SELECT count(*) FROM api_keys WHERE id=$1", key) == 1
    await pg.execute("UPDATE tenants SET status='active' WHERE id=$1", tenant)
    assert await pg.fetchrow("SELECT * FROM platform.resolve_api_key($1)", digest) is None


async def test_oauth_state_is_principal_scoped_and_single_use(pg: asyncpg.Connection) -> None:
    user, tenant = await _identity(pg)
    other_user, other_tenant = await _identity(pg)
    now = datetime.now(UTC)
    session = await pg.fetchval(
        "SELECT platform.auth_create_session($1,$2,$3,$4,43200,$5,$6,NULL,NULL,'oauth-test')",
        user,
        tenant,
        b"o" * 32,
        b"p" * 32,
        now + timedelta(hours=12),
        now + timedelta(days=7),
    )
    await _context(pg, tenant, user)
    await pg.execute("SET LOCAL ROLE platform_web")
    await pg.execute(
        "INSERT INTO platform.oauth_authorizations "
        "(state_hash,tenant_id,user_id,session_id,provider,redirect_uri) "
        "VALUES ($1,$2,$3,$4,'google','https://example.invalid/callback')",
        "a" * 64,
        tenant,
        user,
        session,
    )
    await _context(pg, other_tenant, other_user)
    assert await pg.fetchval("SELECT count(*) FROM platform.oauth_authorizations") == 0
    assert (
        await pg.execute("UPDATE platform.oauth_authorizations SET consumed_at=CURRENT_TIMESTAMP")
        == "UPDATE 0"
    )
    await _context(pg, tenant, user)
    claim = (
        "UPDATE platform.oauth_authorizations SET consumed_at=CURRENT_TIMESTAMP "
        "WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP "
        "RETURNING state_hash"
    )
    assert await pg.fetchval(claim, "a" * 64) == "a" * 64
    assert await pg.fetchval(claim, "a" * 64) is None
    await _context(pg, None, None)
    assert await pg.fetchval("SELECT count(*) FROM platform.oauth_authorizations") == 0
