from __future__ import annotations

from uuid import UUID, uuid4

import asyncpg
import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration]


async def _tenant(pg: asyncpg.Connection, label: str) -> UUID:
    tenant_id = uuid4()
    await pg.execute(
        "INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)",
        tenant_id,
        label,
        f"phase2b-{tenant_id}",
    )
    return tenant_id


async def test_e164_validation_and_tenant_scoped_uniqueness(pg: asyncpg.Connection) -> None:
    tenant_id = await _tenant(pg, "Phone tenant")
    first = await pg.fetchval(
        "INSERT INTO crm.contacts (tenant_id, name) VALUES ($1, 'First') RETURNING id", tenant_id
    )
    second = await pg.fetchval(
        "INSERT INTO crm.contacts (tenant_id, name) VALUES ($1, 'Second') RETURNING id", tenant_id
    )
    await pg.execute(
        "INSERT INTO crm.contact_channel_identities "
        "(tenant_id, contact_id, channel, normalized_value) VALUES ($1, $2, 'phone', $3)",
        tenant_id,
        first,
        "+15550102030",
    )
    with pytest.raises(asyncpg.UniqueViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO crm.contact_channel_identities "
                "(tenant_id, contact_id, channel, normalized_value) "
                "VALUES ($1, $2, 'phone', $3)",
                tenant_id,
                second,
                "+15550102030",
            )
    with pytest.raises(asyncpg.CheckViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO crm.contact_channel_identities "
                "(tenant_id, contact_id, channel, normalized_value) "
                "VALUES ($1, $2, 'whatsapp', 'not-e164')",
                tenant_id,
                second,
            )


async def test_provider_events_and_messages_are_idempotent(pg: asyncpg.Connection) -> None:
    tenant_id = await _tenant(pg, "Messaging tenant")
    contact_id = await pg.fetchval(
        "INSERT INTO crm.contacts (tenant_id, name) VALUES ($1, 'Recipient') RETURNING id",
        tenant_id,
    )
    channel_id = await pg.fetchval(
        "INSERT INTO messaging.channels (tenant_id, kind, provider, provider_account_id) "
        "VALUES ($1, 'whatsapp', 'meta', $2) RETURNING id",
        tenant_id,
        f"fixture-account-{tenant_id}",
    )
    conversation_id = await pg.fetchval(
        "INSERT INTO messaging.conversations (tenant_id, channel_id, contact_id) "
        "VALUES ($1, $2, $3) RETURNING id",
        tenant_id,
        channel_id,
        contact_id,
    )
    await pg.execute(
        "INSERT INTO messaging.messages "
        "(tenant_id, conversation_id, direction, sender_type, content_type, provider, "
        "provider_message_id) VALUES ($1, $2, 'inbound', 'contact', 'text', 'meta', $3)",
        tenant_id,
        conversation_id,
        "fixture-message-1",
    )
    with pytest.raises(asyncpg.UniqueViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO messaging.messages "
                "(tenant_id, conversation_id, direction, sender_type, content_type, provider, "
                "provider_message_id) "
                "VALUES ($1, $2, 'inbound', 'contact', 'text', 'meta', $3)",
                tenant_id,
                conversation_id,
                "fixture-message-1",
            )

    await pg.execute(
        "INSERT INTO ops.inbound_events "
        "(tenant_id, provider, provider_account_id, provider_event_id, event_type, payload) "
        "VALUES ($1, 'meta', 'fixture-account', 'fixture-event', 'message', '{}'::jsonb)",
        tenant_id,
    )
    with pytest.raises(asyncpg.UniqueViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO ops.inbound_events "
                "(tenant_id, provider, provider_account_id, provider_event_id, "
                "event_type, payload) "
                "VALUES ($1, 'meta', 'fixture-account', 'fixture-event', 'message', '{}'::jsonb)",
                tenant_id,
            )

    with pytest.raises(asyncpg.RestrictViolationError):
        async with pg.transaction():
            await pg.execute("DELETE FROM crm.contacts WHERE id = $1", contact_id)
    await pg.execute("DELETE FROM messaging.conversations WHERE id = $1", conversation_id)
    assert not await pg.fetchval(
        "SELECT EXISTS (SELECT 1 FROM messaging.messages WHERE conversation_id = $1)",
        conversation_id,
    )


async def test_domain_mutation_and_outbox_share_transaction(pg: asyncpg.Connection) -> None:
    tenant_id = await _tenant(pg, "Outbox tenant")
    contact_id = uuid4()
    outbox_id = uuid4()

    with pytest.raises(RuntimeError, match="rollback fixture"):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO crm.contacts (id, tenant_id, name) VALUES ($1, $2, 'Rolled back')",
                contact_id,
                tenant_id,
            )
            await pg.execute(
                "INSERT INTO ops.outbox_events "
                "(id, tenant_id, event_type, aggregate_type, aggregate_id, payload) "
                "VALUES ($1, $2, 'crm.contact.created', 'contact', $3, '{}'::jsonb)",
                outbox_id,
                tenant_id,
                contact_id,
            )
            raise RuntimeError("rollback fixture")

    assert not await pg.fetchval(
        "SELECT EXISTS (SELECT 1 FROM crm.contacts WHERE id = $1)", contact_id
    )
    assert not await pg.fetchval(
        "SELECT EXISTS (SELECT 1 FROM ops.outbox_events WHERE id = $1)", outbox_id
    )


async def test_published_flow_version_is_immutable(pg: asyncpg.Connection) -> None:
    tenant_id = await _tenant(pg, "Flow tenant")
    flow_id = await pg.fetchval(
        "INSERT INTO automation.flow_definitions (tenant_id, name) VALUES ($1, $2) RETURNING id",
        tenant_id,
        f"Fixture flow {tenant_id}",
    )
    version_id = await pg.fetchval(
        "INSERT INTO automation.flow_versions "
        "(tenant_id, flow_definition_id, version, schema_version, definition, "
        "validation_status, published_at) "
        "VALUES ($1, $2, 1, '1', '{}'::jsonb, 'valid', CURRENT_TIMESTAMP) RETURNING id",
        tenant_id,
        flow_id,
    )

    with pytest.raises(asyncpg.PostgresError, match="published flow versions are immutable"):
        async with pg.transaction():
            await pg.execute(
                "UPDATE automation.flow_versions SET definition = '{\"changed\":true}'::jsonb "
                "WHERE id = $1",
                version_id,
            )


async def test_postgresql_full_text_search_works_without_vector(pg: asyncpg.Connection) -> None:
    tenant_id = await _tenant(pg, "Knowledge tenant")
    source_id = await pg.fetchval(
        "INSERT INTO agents.knowledge_sources (tenant_id, name, source_type) "
        "VALUES ($1, 'Fixture source', 'manual') RETURNING id",
        tenant_id,
    )
    document_id = await pg.fetchval(
        "INSERT INTO agents.knowledge_documents "
        "(tenant_id, source_id, title, content_checksum) "
        "VALUES ($1, $2, 'Fixture document', 'fixture-checksum') RETURNING id",
        tenant_id,
        source_id,
    )
    await pg.execute(
        "INSERT INTO agents.knowledge_chunks "
        "(tenant_id, document_id, ordinal, content) "
        "VALUES ($1, $2, 0, 'A fictional searchable phrase')",
        tenant_id,
        document_id,
    )

    assert (
        await pg.fetchval(
            "SELECT count(*) FROM agents.knowledge_chunks "
            "WHERE tenant_id = $1 AND search_vector @@ plainto_tsquery('simple', 'searchable')",
            tenant_id,
        )
        == 1
    )
