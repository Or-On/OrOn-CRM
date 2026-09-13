from __future__ import annotations

from datetime import UTC, datetime, timedelta
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


async def _member(pg: asyncpg.Connection, tenant: UUID, role: str) -> UUID:
    user = uuid4()
    await pg.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)",
        user,
        f"{user}@example.test",
    )
    await pg.execute(
        "INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)",
        user,
        tenant,
        role,
    )
    return user


async def test_superadmin_can_create_tenant_with_generated_identifier(
    pg: asyncpg.Connection,
) -> None:
    superadmin = uuid4()
    await pg.execute(
        "INSERT INTO users (id, email, is_superuser) VALUES ($1, $2, true)",
        superadmin,
        f"{superadmin}@example.test",
    )
    await _context(pg, None, superadmin)
    await pg.execute("SET LOCAL ROLE platform_web")

    slug = f"tenant-{uuid4()}"
    tenant = await pg.fetchval(
        "SELECT platform.create_tenant_with_defaults($1,$2,'USD','en','UTC',NULL)",
        "Generated identifier tenant",
        slug,
    )

    await pg.execute("RESET ROLE")
    assert tenant is not None
    assert await pg.fetchval("SELECT slug FROM tenants WHERE id = $1", tenant) == slug
    assert (
        await pg.fetchval(
            "SELECT default_currency FROM crm.tenant_settings WHERE tenant_id = $1",
            tenant,
        )
        == "USD"
    )
    assert (
        await pg.fetchval("SELECT count(*) FROM billing.wallets WHERE tenant_id = $1", tenant) == 1
    )


async def test_superadmin_can_guardedly_delete_an_inactive_context_tenant(
    pg: asyncpg.Connection,
) -> None:
    superadmin = uuid4()
    await pg.execute(
        "INSERT INTO users (id, email, is_superuser) VALUES ($1, $2, true)",
        superadmin,
        f"{superadmin}@example.test",
    )
    _current_owner, current_tenant = await _identity(pg)
    _target_owner, target_tenant = await _identity(pg)
    await pg.execute(
        "INSERT INTO messaging.channels(tenant_id,kind,provider,status) "
        "VALUES ($1,'whatsapp','simulator','active')",
        target_tenant,
    )
    job = await pg.fetchval(
        "INSERT INTO ops.jobs(tenant_id,queue,job_type,payload) "
        "VALUES ($1,'messaging','fixture','{}') RETURNING id",
        target_tenant,
    )

    await _context(pg, current_tenant, superadmin)
    await pg.execute("SET LOCAL ROLE platform_web")
    deleted = await pg.fetchval(
        "SELECT platform.delete_tenant_for_administrator($1,$2)",
        target_tenant,
        "delete-tenant-regression",
    )
    visible = await pg.fetch("SELECT id FROM platform.list_tenants_for_administrator()")

    await pg.execute("RESET ROLE")
    assert deleted is True
    assert target_tenant not in {row["id"] for row in visible}
    assert await pg.fetchval("SELECT status FROM tenants WHERE id = $1", target_tenant) == "deleted"
    assert await pg.fetchval("SELECT status FROM ops.jobs WHERE id = $1", job) == "cancelled"
    assert (
        await pg.fetchval(
            "SELECT status FROM messaging.channels WHERE tenant_id = $1", target_tenant
        )
        == "revoked"
    )
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM audit.records WHERE tenant_id = $1 AND action = 'tenant.deleted'",
            target_tenant,
        )
        == 1
    )


async def test_tenant_deletion_requires_superadmin_and_a_different_active_context(
    pg: asyncpg.Connection,
) -> None:
    owner, tenant = await _identity(pg)
    _other_owner, other_tenant = await _identity(pg)

    await _context(pg, tenant, owner)
    await pg.execute("SET LOCAL ROLE platform_web")
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval(
                "SELECT platform.delete_tenant_for_administrator($1,$2)",
                other_tenant,
                "ordinary-admin-delete-denied",
            )

    await pg.execute("RESET ROLE")
    await pg.execute("UPDATE users SET is_superuser = true WHERE id = $1", owner)
    await pg.execute("SET LOCAL ROLE platform_web")
    with pytest.raises(asyncpg.InvalidParameterValueError):
        async with pg.transaction():
            await pg.fetchval(
                "SELECT platform.delete_tenant_for_administrator($1,$2)",
                tenant,
                "current-tenant-delete-denied",
            )
    await pg.execute("RESET ROLE")


async def test_non_superuser_session_resolves_membership_role(
    pg: asyncpg.Connection,
) -> None:
    user, tenant = await _identity(pg, role="admin")
    token = uuid4().bytes + uuid4().bytes
    now = datetime.now(UTC)
    session = await pg.fetchval(
        "SELECT platform.auth_create_session($1,$2,$3,$4,43200,$5,$6,NULL,NULL,$7)",
        user,
        tenant,
        token,
        b"c" * 32,
        now + timedelta(hours=12),
        now + timedelta(days=7),
        "admin-session-regression",
    )

    await pg.execute("SET LOCAL ROLE platform_web")
    resolved = await pg.fetchrow("SELECT * FROM platform.auth_resolve_session($1)", token)

    assert resolved is not None
    assert resolved["session_id"] == session
    assert resolved["tenant_id"] == tenant
    assert resolved["role"] == "admin"
    assert resolved["is_superuser"] is False


async def test_superadmin_can_resolve_sessions_and_inspect_each_active_tenant(
    pg: asyncpg.Connection,
) -> None:
    superadmin = uuid4()
    await pg.execute(
        "INSERT INTO users (id, email, is_superuser) VALUES ($1, $2, true)",
        superadmin,
        f"{superadmin}@example.test",
    )
    _, tenant_a = await _identity(pg)
    _, tenant_b = await _identity(pg)
    tenant_a_member = await _member(pg, tenant_a, "agent")

    await pg.execute("SET LOCAL ROLE platform_web")
    memberships = await pg.fetch("SELECT * FROM platform.auth_memberships_for_user($1)", superadmin)
    visible = {row["tenant_id"]: row["role"] for row in memberships}
    assert visible[tenant_a] == "owner"
    assert visible[tenant_b] == "owner"

    now = datetime.now(UTC)
    token = uuid4().bytes + uuid4().bytes
    session = await pg.fetchval(
        "SELECT platform.auth_create_session($1,$2,$3,$4,43200,$5,$6,NULL,NULL,$7)",
        superadmin,
        tenant_a,
        token,
        b"s" * 32,
        now + timedelta(hours=12),
        now + timedelta(days=7),
        "superadmin-session",
    )
    resolved = await pg.fetchrow("SELECT * FROM platform.auth_resolve_session($1)", token)
    assert resolved is not None
    assert resolved["session_id"] == session
    assert resolved["tenant_id"] == tenant_a
    assert resolved["role"] == "owner"
    assert resolved["is_superuser"] is True

    await _context(pg, tenant_a, superadmin)
    team = await pg.fetch("SELECT * FROM platform.current_tenant_team()")
    assert tenant_a_member in {row["user_id"] for row in team}


async def test_tenant_admin_management_is_scoped_and_cannot_manage_owner(
    pg: asyncpg.Connection,
) -> None:
    admin, tenant = await _identity(pg, role="admin")
    member = await _member(pg, tenant, "agent")
    owner = await _member(pg, tenant, "owner")
    foreign_member, _foreign_tenant = await _identity(pg, role="agent")

    await _context(pg, tenant, admin)
    await pg.execute("SET LOCAL ROLE platform_web")
    await pg.execute(
        "SELECT platform.manage_current_tenant_member($1,'viewer',false,$2)",
        member,
        "admin-manage-own-tenant",
    )

    with pytest.raises(asyncpg.NoDataFoundError):
        async with pg.transaction():
            await pg.execute(
                "SELECT platform.manage_current_tenant_member($1,'viewer',false,$2)",
                foreign_member,
                "admin-manage-foreign-tenant",
            )

    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute(
                "SELECT platform.manage_current_tenant_member($1,'agent',false,$2)",
                owner,
                "admin-demote-owner",
            )

    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval(
            "SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2",
            tenant,
            member,
        )
        == "viewer"
    )
    assert (
        await pg.fetchval(
            "SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2",
            tenant,
            owner,
        )
        == "owner"
    )


@pytest.mark.parametrize("role", ["agent", "viewer"])
async def test_non_admin_roles_cannot_manage_tenant_or_members(
    pg: asyncpg.Connection,
    role: str,
) -> None:
    actor, tenant = await _identity(pg, role=role)
    target = await _member(pg, tenant, "viewer")
    original_name = await pg.fetchval("SELECT name FROM tenants WHERE id = $1", tenant)

    await _context(pg, tenant, actor)
    await pg.execute("SET LOCAL ROLE platform_web")

    protected_calls = (
        (
            "SELECT platform.update_current_tenant_name($1,$2)",
            "Unauthorized tenant name",
            f"{role}-rename-denied",
        ),
        (
            "SELECT platform.create_current_tenant_invitation($1,'viewer',$2,$3,$4)",
            f"{uuid4()}@example.test",
            f"{role}-invitation-{uuid4()}",
            datetime.now(UTC) + timedelta(days=1),
            f"{role}-invite-denied",
        ),
        (
            "SELECT platform.manage_current_tenant_member($1,'agent',false,$2)",
            target,
            f"{role}-member-denied",
        ),
    )
    for statement, *parameters in protected_calls:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            async with pg.transaction():
                await pg.fetchval(statement, *parameters)

    await pg.execute("RESET ROLE")
    assert await pg.fetchval("SELECT name FROM tenants WHERE id = $1", tenant) == original_name
    assert (
        await pg.fetchval(
            "SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2",
            tenant,
            target,
        )
        == "viewer"
    )


async def test_owner_can_manage_tenant_members_and_admin_cannot_grant_owner(
    pg: asyncpg.Connection,
) -> None:
    owner, tenant = await _identity(pg, role="owner")
    admin = await _member(pg, tenant, "admin")
    target = await _member(pg, tenant, "viewer")

    await _context(pg, tenant, owner)
    await pg.execute("SET LOCAL ROLE platform_web")
    renamed = await pg.fetchval(
        "SELECT platform.update_current_tenant_name($1,$2)",
        "Owner managed tenant",
        "owner-rename-allowed",
    )
    await pg.execute(
        "SELECT platform.manage_current_tenant_member($1,'owner',false,$2)",
        target,
        "owner-grant-owner",
    )
    assert renamed == "Owner managed tenant"

    await _context(pg, tenant, admin)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute(
                "SELECT platform.manage_current_tenant_member($1,'owner',false,$2)",
                admin,
                "admin-grant-owner-denied",
            )

    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval(
            "SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2",
            tenant,
            target,
        )
        == "owner"
    )


async def test_invitation_acceptance_is_one_time_for_existing_account(
    pg: asyncpg.Connection,
) -> None:
    owner, tenant = await _identity(pg)
    invitee = uuid4()
    invitee_email = f"{invitee}@example.test"
    await pg.execute("INSERT INTO users (id, email) VALUES ($1, $2)", invitee, invitee_email)
    token_hash = f"invitation-{uuid4()}"

    await _context(pg, tenant, owner)
    await pg.execute("SET LOCAL ROLE platform_web")
    invitation = await pg.fetchval(
        "SELECT platform.create_current_tenant_invitation($1,'agent',$2,$3,$4)",
        invitee_email,
        token_hash,
        datetime.now(UTC) + timedelta(days=1),
        "invitation-create",
    )
    created_account = await pg.fetchval(
        "SELECT platform.auth_accept_invitation($1,'','Existing account',$2)",
        token_hash,
        "invitation-accept",
    )
    assert created_account is False

    with pytest.raises(asyncpg.InvalidParameterValueError):
        async with pg.transaction():
            await pg.fetchval(
                "SELECT platform.auth_accept_invitation($1,'','Existing account',$2)",
                token_hash,
                "invitation-replay",
            )

    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval(
            "SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2",
            tenant,
            invitee,
        )
        == "agent"
    )
    accepted = await pg.fetchrow(
        "SELECT accepted_at, accepted_by_user_id FROM platform.tenant_invitations WHERE id = $1",
        invitation,
    )
    assert accepted is not None
    assert accepted["accepted_at"] is not None
    assert accepted["accepted_by_user_id"] == invitee


async def test_platform_web_invitation_access_is_function_only(
    pg: asyncpg.Connection,
) -> None:
    owner, tenant = await _identity(pg)
    token_hash = f"invitation-{uuid4()}"
    await _context(pg, tenant, owner)
    await pg.execute("SET LOCAL ROLE platform_web")

    invitation = await pg.fetchval(
        "SELECT platform.create_current_tenant_invitation($1,'viewer',$2,$3,$4)",
        f"{uuid4()}@example.test",
        token_hash,
        datetime.now(UTC) + timedelta(days=1),
        "function-only-invitation",
    )
    visible = await pg.fetch("SELECT * FROM platform.current_tenant_invitations()")
    assert invitation in {row["id"] for row in visible}

    for statement in (
        "SELECT * FROM platform.tenant_invitations",
        "DELETE FROM platform.tenant_invitations WHERE id IS NULL",
        "UPDATE platform.tenant_invitations SET role = role WHERE id IS NULL",
    ):
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            async with pg.transaction():
                await pg.execute(statement)

    for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert not await pg.fetchval(
            "SELECT has_table_privilege('platform_web', 'platform.tenant_invitations', $1)",
            privilege,
        )


async def test_owner_can_revoke_only_an_open_invitation_in_the_current_tenant(
    pg: asyncpg.Connection,
) -> None:
    owner, tenant = await _identity(pg)
    _foreign_owner, foreign_tenant = await _identity(pg)
    own_token = f"own-invitation-{uuid4()}"
    foreign_token = f"foreign-invitation-{uuid4()}"

    await _context(pg, tenant, owner)
    await pg.execute("SET LOCAL ROLE platform_web")
    own_invitation = await pg.fetchval(
        "SELECT platform.create_current_tenant_invitation($1,'agent',$2,$3,$4)",
        f"{uuid4()}@example.test",
        own_token,
        datetime.now(UTC) + timedelta(days=1),
        "create-own-invitation",
    )
    await pg.execute("RESET ROLE")

    foreign_invitation = uuid4()
    await pg.execute(
        "INSERT INTO platform.tenant_invitations "
        "(id, tenant_id, invited_by_user_id, email, role, token_hash, expires_at) "
        "VALUES ($1,$2,$3,$4,'viewer',$5,$6)",
        foreign_invitation,
        foreign_tenant,
        _foreign_owner,
        f"{uuid4()}@example.test",
        foreign_token,
        datetime.now(UTC) + timedelta(days=1),
    )

    await _context(pg, tenant, owner)
    await pg.execute("SET LOCAL ROLE platform_web")
    assert await pg.fetchval(
        "SELECT platform.revoke_current_tenant_invitation($1,$2)",
        own_invitation,
        "revoke-own-invitation",
    )
    assert not await pg.fetchval(
        "SELECT platform.revoke_current_tenant_invitation($1,$2)",
        foreign_invitation,
        "revoke-foreign-invitation",
    )
    assert not await pg.fetchrow("SELECT * FROM platform.auth_invitation_record($1)", own_token)
    assert await pg.fetchrow("SELECT * FROM platform.auth_invitation_record($1)", foreign_token)

    await pg.execute("RESET ROLE")
    audit = await pg.fetchrow(
        "SELECT action, target_id FROM audit.records WHERE request_id = 'revoke-own-invitation'"
    )
    assert audit is not None
    assert audit["action"] == "tenant.invitation.revoked"
    assert audit["target_id"] == own_invitation


@pytest.mark.parametrize("tenant_state", ["missing", "inactive"])
async def test_tenant_rename_rejects_invalid_tenant_context(
    pg: asyncpg.Connection,
    tenant_state: str,
) -> None:
    owner, tenant = await _identity(pg)
    invalid_tenant = uuid4() if tenant_state == "missing" else tenant
    if tenant_state == "inactive":
        await pg.execute(
            "UPDATE tenants SET status = 'suspended' WHERE id = $1",
            tenant,
        )
    await _context(pg, invalid_tenant, owner)
    await pg.execute("SET LOCAL ROLE platform_web")

    with pytest.raises(asyncpg.NoDataFoundError):
        async with pg.transaction():
            await pg.fetchval(
                "SELECT platform.update_current_tenant_name($1,$2)",
                "Unauthorized rename",
                f"{tenant_state}-tenant-context",
            )

    await pg.execute("RESET ROLE")
    if tenant_state == "inactive":
        assert await pg.fetchval("SELECT name FROM tenants WHERE id = $1", tenant) != (
            "Unauthorized rename"
        )


async def test_administration_functions_fail_closed_without_actor_context(
    pg: asyncpg.Connection,
) -> None:
    owner, tenant = await _identity(pg)
    member = await _member(pg, tenant, "agent")
    await _context(pg, tenant, None)
    await pg.execute("SET LOCAL ROLE platform_web")

    assert not await pg.fetch("SELECT * FROM platform.current_tenant_team()")
    calls = (
        (
            "SELECT platform.manage_current_tenant_member($1,'viewer',false,$2)",
            member,
            "missing-actor-member",
        ),
        (
            "SELECT platform.create_current_tenant_invitation($1,'viewer',$2,$3,$4)",
            f"{uuid4()}@example.test",
            f"missing-actor-{uuid4()}",
            datetime.now(UTC) + timedelta(days=1),
            "missing-actor-invite",
        ),
        (
            "SELECT platform.update_current_tenant_name($1,$2)",
            "Unauthorized rename",
            "missing-actor-tenant",
        ),
    )
    for statement in calls:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            async with pg.transaction():
                await pg.fetchval(statement[0], *statement[1:])

    await pg.execute("RESET ROLE")
    assert await pg.fetchval("SELECT name FROM tenants WHERE id = $1", tenant) != (
        "Unauthorized rename"
    )
    assert (
        await pg.fetchval(
            "SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2",
            tenant,
            member,
        )
        == "agent"
    )
    assert owner != member
