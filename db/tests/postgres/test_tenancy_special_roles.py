"""Canonical technician memberships remain readable without generic role elevation."""

from uuid import uuid4

import pytest
from dispatcher_runtime.persistence import _async_database_url
from oron_tenancy.models import Membership, Role
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def test_technician_membership_roundtrips_without_generic_authority(postgres_url):
    engine = create_async_engine(_async_database_url(postgres_url))
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                tenant, user = uuid4(), uuid4()
                await connection.execute(
                    text(
                        "INSERT INTO public.tenants(id,name,slug) "
                        "VALUES(:tenant,'Fictional role',:slug)"
                    ),
                    {"tenant": tenant, "slug": f"role-{tenant}"},
                )
                await connection.execute(
                    text("INSERT INTO public.users(id,email,status) VALUES(:user,:email,'active')"),
                    {"user": user, "email": f"role-{user}@example.invalid"},
                )
                await connection.execute(
                    text(
                        "INSERT INTO public.memberships(user_id,tenant_id,role) "
                        "VALUES(:user,:tenant,'technician')"
                    ),
                    {"user": user, "tenant": tenant},
                )
                async with AsyncSession(
                    bind=connection, join_transaction_mode="create_savepoint"
                ) as session:
                    membership = (
                        await session.execute(
                            select(Membership).where(
                                Membership.user_id == user, Membership.tenant_id == tenant
                            )
                        )
                    ).scalar_one()
                    assert membership.role.value == "technician"
                    for generic in (Role.VIEWER, Role.AGENT, Role.ADMIN, Role.OWNER):
                        assert not membership.role.at_least(generic)
                        assert not generic.at_least(membership.role)
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()
