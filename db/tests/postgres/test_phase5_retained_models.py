from __future__ import annotations

import datetime as dt
from uuid import UUID, uuid4

import asyncpg
import pytest
from control_api.auth import ServicePrincipal
from control_api.voice import (
    FlowDocumentRequest,
    PostgresVoiceRepository,
    RegisterPhoneNumberRequest,
    SimulatedCallConflict,
    SimulatedCallRequest,
    VoiceCampaignCreate,
)
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

from db.tests.postgres.conftest import run_alembic

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


async def test_voice_did_flow_campaign_and_detail_use_canonical_postgres(
    isolated_postgres_url: str,
) -> None:
    await run_alembic(isolated_postgres_url, "upgrade", "head")
    tenant_id, user_id, contact_id, other_contact_id, flow_id = (
        uuid4(),
        uuid4(),
        uuid4(),
        uuid4(),
        uuid4(),
    )
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        await connection.execute(
            "INSERT INTO tenants (id, name, slug) VALUES ($1, 'Voice tenant', $2)",
            tenant_id,
            f"voice-{tenant_id}",
        )
        await connection.execute(
            "INSERT INTO users (id, email) VALUES ($1, $2)",
            user_id,
            f"{user_id}@example.test",
        )
        await connection.execute(
            "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')",
            tenant_id,
            user_id,
        )
        await connection.execute(
            "INSERT INTO crm.contacts (id, tenant_id, name, voice_consent) "
            "VALUES ($1, $2, 'Fictional opted-in contact', 'granted')",
            contact_id,
            tenant_id,
        )
        await connection.execute(
            "INSERT INTO crm.contacts (id, tenant_id, name) "
            "VALUES ($1, $2, 'Other fictional simulator contact')",
            other_contact_id,
            tenant_id,
        )
        await connection.execute(
            "INSERT INTO crm.contact_channel_identities "
            "(tenant_id, contact_id, channel, normalized_value, validation_status, is_primary) "
            "VALUES ($1, $2, 'phone', '+15550101010', 'valid', true)",
            tenant_id,
            contact_id,
        )
    finally:
        await connection.close()

    repository = PostgresVoiceRepository(isolated_postgres_url)
    principal = ServicePrincipal(
        user_id=user_id,
        tenant_id=tenant_id,
        role="admin",
        session_id=uuid4(),
        capability="voice:write",
    )
    source = {
        "flow": {"id": str(flow_id), "version": 1, "language": "he", "name": "Test flow"},
        "steps": [{"id": "done", "use": "announce", "then": "להתראות"}],
    }
    try:
        validation = await repository.validate_flow(FlowDocumentRequest(source=source))
        assert validation.valid
        published = await repository.publish_flow(principal, FlowDocumentRequest(source=source))
        replay = await repository.publish_flow(principal, FlowDocumentRequest(source=source))
        number = await repository.register_phone_number(
            principal,
            RegisterPhoneNumberRequest(
                e164="+14155550111",
                flow_id=flow_id,
                allowed_addresses=["203.0.113.0/24"],
            ),
        )
        with pytest.raises(ValueError, match="restricted"):
            await repository.register_phone_number(
                principal,
                RegisterPhoneNumberRequest(
                    e164="+14155550112",
                    flow_id=flow_id,
                    allowed_addresses=["0.0.0.0/0"],
                ),
            )
        now = dt.datetime.now(dt.UTC)
        campaign = await repository.create_campaign(
            principal,
            VoiceCampaignCreate(
                name="Fictional voice campaign",
                flow_id=flow_id,
                timezone="UTC",
                weekday_hours={now.weekday(): [0, 24]},
            ),
        )
        result = await repository.run_campaign(principal, campaign.id)
        repeated = await repository.run_campaign(principal, campaign.id)
        detail = await repository.get_session(
            principal,
            next(item.session_id for item in await repository.list_sessions(principal)),
        )
    finally:
        await repository.close()

    assert published.created is True
    assert replay.created is False
    assert number.admission == "simulated"
    assert result.created_calls == 1
    assert repeated.created_calls == 0
    assert repeated.skipped_contacts == 1
    assert detail is not None
    assert detail.transcript_object_id is not None
    assert [event.sequence for event in detail.events] == list(range(7))
    assert any(event.event_type == "voice.call.usage.recorded.v1" for event in detail.events)

    repository = PostgresVoiceRepository(isolated_postgres_url)
    principal = ServicePrincipal(
        user_id=user_id,
        tenant_id=tenant_id,
        role="agent",
        session_id=uuid4(),
        capability="voice:write",
    )
    command = SimulatedCallRequest(
        contact_id=contact_id,
        idempotency_key="phase5-live-simulator",
    )
    try:
        first = await repository.simulate_call(principal, command)
        second = await repository.simulate_call(principal, command)
        with pytest.raises(SimulatedCallConflict):
            await repository.simulate_call(
                principal,
                SimulatedCallRequest(
                    contact_id=other_contact_id,
                    idempotency_key=command.idempotency_key,
                ),
            )
    finally:
        await repository.close()

    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        assert first.created is True
        assert second.created is False
        assert first.session.session_id == second.session.session_id
        assert first.session.provider == "simulator"
        assert first.session.status.value == "ended"
        assert len(first.event_types) == 7
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM sessions WHERE tenant_id = $1 AND provider = 'simulator'",
                tenant_id,
            )
            == 2
        )
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM session_events WHERE session_id = $1",
                first.session.session_id,
            )
            == 7
        )
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM ops.outbox_events WHERE aggregate_id = $1",
                first.session.session_id,
            )
            == 7
        )
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM audit.records "
                "WHERE target_id = $1 AND action = 'voice.simulated_call.completed'",
                first.session.session_id,
            )
            == 1
        )
    finally:
        await connection.close()
