from __future__ import annotations

from uuid import uuid4

import asyncpg
import pytest
from oron_sessions.campaigns import Campaign, CampaignContact
from oron_sessions.models import Session
from oron_tenancy.models import (
    ApiKey,
    Flow,
    IdentityBinding,
    Membership,
    PhoneNumber,
    Role,
    Tenant,
    User,
)

pytestmark = [pytest.mark.postgres, pytest.mark.integration]


MODELS = (
    Tenant,
    PhoneNumber,
    Flow,
    ApiKey,
    User,
    IdentityBinding,
    Membership,
    Session,
    Campaign,
    CampaignContact,
)


async def test_retained_models_match_the_live_canonical_columns(
    pg: asyncpg.Connection,
) -> None:
    differences: list[str] = []
    for model in MODELS:
        table = model.__table__
        schema = table.schema or "public"
        rows = await pg.fetch(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            """,
            schema,
            table.name,
        )
        live = {row["column_name"] for row in rows}
        modeled = set(table.columns.keys())
        if live != modeled:
            differences.append(
                f"{schema}.{table.name}: missing={sorted(live - modeled)!r}, "
                f"extra={sorted(modeled - live)!r}"
            )
    assert differences == []


async def test_provider_neutral_identity_binding_is_unique_per_subject(
    pg: asyncpg.Connection,
) -> None:
    user_a, user_b = uuid4(), uuid4()
    await pg.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)",
        user_a,
        f"{user_a}@example.test",
        user_b,
        f"{user_b}@example.test",
    )
    await pg.execute(
        """
        INSERT INTO platform.identity_bindings(user_id, provider, provider_subject)
        VALUES ($1, 'oidc', 'subject-1')
        """,
        user_a,
    )
    with pytest.raises(asyncpg.UniqueViolationError):
        async with pg.transaction():
            await pg.execute(
                """
                INSERT INTO platform.identity_bindings(user_id, provider, provider_subject)
                VALUES ($1, 'oidc', 'subject-1')
                """,
                user_b,
            )


def test_retained_membership_model_uses_canonical_roles() -> None:
    assert [role.value for role in Role] == ["viewer", "agent", "admin", "owner"]
