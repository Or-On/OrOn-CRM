from __future__ import annotations

from uuid import UUID, uuid4

import asyncpg
import pytest
from oron_sessions.campaigns import Campaign, CampaignContact
from oron_sessions.models import Session, SessionEvent
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
    SessionEvent,
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


async def _tenant(pg: asyncpg.Connection, label: str) -> tuple[UUID, UUID]:
    tenant_id = uuid4()
    contact_id = uuid4()
    await pg.execute(
        "INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)",
        tenant_id,
        label,
        f"phase5-{tenant_id}",
    )
    await pg.execute(
        "INSERT INTO crm.contacts (id, tenant_id, name) VALUES ($1, $2, $3)",
        contact_id,
        tenant_id,
        f"{label} contact",
    )
    return tenant_id, contact_id


async def test_session_bridges_are_tenant_consistent_and_idempotent(
    pg: asyncpg.Connection,
) -> None:
    tenant_a, contact_a = await _tenant(pg, "Voice tenant A")
    tenant_b, contact_b = await _tenant(pg, "Voice tenant B")
    session_id = uuid4()
    await pg.execute(
        "INSERT INTO sessions "
        "(session_id, tenant_id, provider, direction, status, room, flow_id, contact_id, "
        "initiated_by_service, provider_call_id, idempotency_key) "
        "VALUES ($1, $2, 'simulator', 'outbound', 'started', 'fixture-room', $3, $4, "
        "'phase5-test', 'provider-call-1', 'request-1')",
        session_id,
        tenant_a,
        uuid4(),
        contact_a,
    )
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO sessions "
                "(session_id, tenant_id, provider, direction, status, room, flow_id, contact_id) "
                "VALUES ($1, $2, 'simulator', 'outbound', 'started', 'wrong-tenant', $3, $4)",
                uuid4(),
                tenant_a,
                uuid4(),
                contact_b,
            )
    with pytest.raises(asyncpg.UniqueViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO sessions "
                "(session_id, tenant_id, provider, direction, status, room, flow_id, "
                "provider_call_id) VALUES ($1, $2, 'simulator', 'outbound', 'started', "
                "'duplicate', $3, 'provider-call-1')",
                uuid4(),
                tenant_a,
                uuid4(),
            )
    await pg.execute(
        "INSERT INTO session_events "
        "(tenant_id, session_id, sequence, event_type, idempotency_key, payload) "
        "VALUES ($1, $2, 0, 'voice.call.started.v1', 'event-1', '{\"safe\": true}'::jsonb)",
        tenant_a,
        session_id,
    )
    with pytest.raises(asyncpg.UniqueViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO session_events "
                "(tenant_id, session_id, sequence, event_type, idempotency_key) "
                "VALUES ($1, $2, 1, 'voice.call.started.v1', 'event-1')",
                tenant_a,
                session_id,
            )
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO session_events (tenant_id, session_id, sequence, event_type) "
                "VALUES ($1, $2, 1, 'voice.call.started.v1')",
                tenant_b,
                session_id,
            )
    await pg.execute("DELETE FROM crm.contacts WHERE id = $1", contact_a)
    retained = await pg.fetchrow(
        "SELECT tenant_id, contact_id FROM sessions WHERE session_id = $1", session_id
    )
    assert retained is not None
    assert retained["tenant_id"] == tenant_a
    assert retained["contact_id"] is None


async def test_voice_campaign_projection_rejects_cross_tenant_links(
    pg: asyncpg.Connection,
) -> None:
    tenant_a, contact_a = await _tenant(pg, "Campaign tenant A")
    tenant_b, contact_b = await _tenant(pg, "Campaign tenant B")
    parent_a = await pg.fetchval(
        "INSERT INTO platform.campaigns (tenant_id, name, channel) "
        "VALUES ($1, 'Canonical voice', 'voice') RETURNING id",
        tenant_a,
    )
    parent_b = await pg.fetchval(
        "INSERT INTO platform.campaigns (tenant_id, name, channel) "
        "VALUES ($1, 'Foreign voice', 'voice') RETURNING id",
        tenant_b,
    )
    voice_campaign = uuid4()
    await pg.execute(
        "INSERT INTO campaigns (id, tenant_id, name, flow_id, platform_campaign_id) "
        "VALUES ($1, $2, 'Voice execution', $3, $4)",
        voice_campaign,
        tenant_a,
        uuid4(),
        parent_a,
    )
    await pg.execute(
        "INSERT INTO campaign_contacts "
        "(id, tenant_id, campaign_id, contact_id, phone_number, phone_bidx) "
        "VALUES ($1, $2, $3, $4, 'ciphertext', $5)",
        uuid4(),
        tenant_a,
        voice_campaign,
        contact_a,
        f"blind-{uuid4()}",
    )
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO campaigns (id, tenant_id, name, flow_id, platform_campaign_id) "
                "VALUES ($1, $2, 'Wrong parent', $3, $4)",
                uuid4(),
                tenant_a,
                uuid4(),
                parent_b,
            )
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO campaign_contacts "
                "(id, tenant_id, campaign_id, contact_id, phone_number, phone_bidx) "
                "VALUES ($1, $2, $3, $4, 'ciphertext', $5)",
                uuid4(),
                tenant_a,
                voice_campaign,
                contact_b,
                f"blind-{uuid4()}",
            )


async def test_platform_voice_session_event_rls_fails_closed(pg: asyncpg.Connection) -> None:
    tenant_a, _ = await _tenant(pg, "Voice RLS A")
    tenant_b, _ = await _tenant(pg, "Voice RLS B")
    session_id = uuid4()
    await pg.execute(
        "INSERT INTO sessions (session_id, tenant_id, provider, direction, status, room, flow_id) "
        "VALUES ($1, $2, 'simulator', 'inbound', 'started', 'rls-room', $3)",
        session_id,
        tenant_a,
        uuid4(),
    )
    await pg.execute(
        "INSERT INTO session_events (tenant_id, session_id, sequence, event_type) "
        "VALUES ($1, $2, 0, 'voice.call.started.v1')",
        tenant_a,
        session_id,
    )
    assert await pg.fetchval(
        "SELECT has_table_privilege('platform_voice', 'ops.outbox_events', 'INSERT')"
    )
    assert await pg.fetchval(
        "SELECT has_table_privilege('platform_voice', 'audit.records', 'INSERT')"
    )
    assert not await pg.fetchval(
        "SELECT has_table_privilege('platform_voice', 'messaging.messages', 'SELECT')"
    )
    await pg.execute("SET LOCAL ROLE platform_voice")
    assert await pg.fetchval("SELECT count(*) FROM session_events") == 0
    await pg.execute("SELECT set_config('app.current_tenant', $1, true)", str(tenant_a))
    assert await pg.fetchval("SELECT count(*) FROM session_events") == 1
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute(
                "UPDATE session_events SET event_type = 'mutated' WHERE session_id = $1",
                session_id,
            )
    await pg.execute("SELECT set_config('app.current_tenant', $1, true)", str(tenant_b))
    assert await pg.fetchval("SELECT count(*) FROM session_events") == 0
