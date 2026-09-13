from __future__ import annotations

from uuid import UUID, uuid4

import asyncpg
import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def _tenant(pg: asyncpg.Connection, name: str) -> UUID:
    tenant_id = uuid4()
    await pg.execute(
        "INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)",
        tenant_id,
        name,
        f"phase2b-{tenant_id}",
    )
    return tenant_id


async def test_missing_context_fails_closed_and_cross_tenant_crud_is_blocked(
    pg: asyncpg.Connection,
) -> None:
    tenant_a = await _tenant(pg, "Phase 2B tenant A")
    tenant_b = await _tenant(pg, "Phase 2B tenant B")
    contact_a = await pg.fetchval(
        "INSERT INTO crm.contacts (tenant_id, name) VALUES ($1, 'Tenant A contact') RETURNING id",
        tenant_a,
    )
    contact_b = await pg.fetchval(
        "INSERT INTO crm.contacts (tenant_id, name) VALUES ($1, 'Tenant B contact') RETURNING id",
        tenant_b,
    )

    await pg.execute("SET LOCAL ROLE platform_web")
    assert await pg.fetchval("SELECT count(*) FROM crm.contacts") == 0
    await pg.execute("SELECT set_config('app.current_tenant', $1, true)", str(tenant_a))
    assert await pg.fetchval("SELECT count(*) FROM crm.contacts") == 1
    assert await pg.fetchval("SELECT id FROM crm.contacts") == contact_a
    assert (
        await pg.execute("UPDATE crm.contacts SET name = 'blocked' WHERE id = $1", contact_b)
        == "UPDATE 0"
    )
    assert await pg.execute("DELETE FROM crm.contacts WHERE id = $1", contact_b) == "DELETE 0"
    with pytest.raises(asyncpg.PostgresError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO crm.contacts (tenant_id, name) VALUES ($1, 'cross-tenant')",
                tenant_b,
            )


async def test_membership_scoped_preference_rejects_wrong_tenant(pg: asyncpg.Connection) -> None:
    tenant_a = await _tenant(pg, "Membership A")
    tenant_b = await _tenant(pg, "Membership B")
    user_id = uuid4()
    await pg.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)", user_id, f"{user_id}@example.test"
    )
    await pg.execute(
        "INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'member')",
        user_id,
        tenant_a,
    )

    await pg.execute(
        "INSERT INTO live.user_preferences (tenant_id, user_id, key, value) "
        "VALUES ($1, $2, 'liveModel', '\"fixture\"'::jsonb)",
        tenant_a,
        user_id,
    )
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO live.user_preferences (tenant_id, user_id, key, value) "
                "VALUES ($1, $2, 'liveModel', '\"blocked\"'::jsonb)",
                tenant_b,
                user_id,
            )


async def test_transaction_local_context_does_not_survive_commit(postgres_url: str) -> None:
    connection = await asyncpg.connect(postgres_url)
    try:
        transaction = connection.transaction()
        await transaction.start()
        await connection.execute("SELECT set_config('app.current_tenant', $1, true)", str(uuid4()))
        assert await connection.fetchval("SELECT current_setting('app.current_tenant', true)")
        await transaction.commit()
        assert not await connection.fetchval("SELECT current_setting('app.current_tenant', true)")
    finally:
        await connection.close()


async def test_runtime_domain_separation_ddl_denial_and_audit_immutability(
    pg: asyncpg.Connection,
) -> None:
    voice_can_read_messages = await pg.fetchval(
        "SELECT has_table_privilege('platform_voice', 'messaging.messages', 'SELECT')"
    )
    messaging_session_privileges = await pg.fetchrow(
        """
        SELECT has_table_privilege('platform_messaging', 'public.sessions', 'SELECT') AS can_read,
               has_table_privilege('platform_messaging', 'public.sessions', 'INSERT') AS can_insert,
               has_table_privilege('platform_messaging', 'public.sessions', 'UPDATE') AS can_update,
               has_table_privilege('platform_messaging', 'public.sessions', 'DELETE') AS can_delete
        """
    )
    assert not voice_can_read_messages
    assert messaging_session_privileges is not None
    # Cross-channel investigation needs tenant-RLS-scoped voice history, but
    # the messaging worker remains unable to write the voice session domain.
    assert messaging_session_privileges["can_read"]
    assert not messaging_session_privileges["can_insert"]
    assert not messaging_session_privileges["can_update"]
    assert not messaging_session_privileges["can_delete"]

    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute("SET LOCAL ROLE platform_web")
            await pg.execute("CREATE TABLE public.phase2b_forbidden (id integer)")

    tenant_id = await _tenant(pg, "Audit tenant")
    audit_id = await pg.fetchval(
        "INSERT INTO audit.records (tenant_id, actor_service, action, target_type) "
        "VALUES ($1, 'phase2b-test', 'test.action', 'fixture') RETURNING id",
        tenant_id,
    )
    await pg.execute("SET LOCAL ROLE platform_web")
    await pg.execute("SELECT set_config('app.current_tenant', $1, true)", str(tenant_id))
    assert await pg.fetchval("SELECT id FROM audit.records WHERE id = $1", audit_id) == audit_id
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute("UPDATE audit.records SET action = 'mutated' WHERE id = $1", audit_id)
