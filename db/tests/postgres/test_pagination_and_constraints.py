from __future__ import annotations

from datetime import UTC, datetime, timedelta
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


async def _conversation(pg: asyncpg.Connection, tenant_id: UUID) -> UUID:
    contact_id = await pg.fetchval(
        "INSERT INTO crm.contacts (tenant_id, name) VALUES ($1, 'Cursor contact') RETURNING id",
        tenant_id,
    )
    channel_id = await pg.fetchval(
        "INSERT INTO messaging.channels (tenant_id, kind, provider, provider_account_id) "
        "VALUES ($1, 'whatsapp', 'phase2b', $2) RETURNING id",
        tenant_id,
        f"cursor-{tenant_id}",
    )
    conversation_id = await pg.fetchval(
        "INSERT INTO messaging.conversations (tenant_id, channel_id, contact_id) "
        "VALUES ($1, $2, $3) RETURNING id",
        tenant_id,
        channel_id,
        contact_id,
    )
    assert conversation_id is not None
    return conversation_id


async def _inbound_media(pg: asyncpg.Connection, tenant_id: UUID) -> tuple[UUID, UUID]:
    conversation_id = await _conversation(pg, tenant_id)
    message_id = uuid4()
    object_id = await pg.fetchval(
        "INSERT INTO objects.object_metadata "
        "(tenant_id, owner_type, owner_id, category, content_type, byte_size, checksum, "
        "storage_backend, storage_key, status) "
        "VALUES ($1, 'message', $2, 'whatsapp_customer_image', 'image/jpeg', 4, "
        "'fixture-checksum', 'local', $3, 'available') RETURNING id",
        tenant_id,
        message_id,
        f"messaging/{tenant_id}/{message_id}",
    )
    await pg.execute(
        "INSERT INTO messaging.messages "
        "(id, tenant_id, conversation_id, direction, sender_type, content_type, "
        "provider, provider_message_id, status, structured_content, object_id) "
        "VALUES ($1, $2, $3, 'inbound', 'contact', 'image', 'meta', $4, 'received', "
        '\'{"retrievalStatus":"available","fileName":"fixture.jpg"}\'::jsonb, $5)',
        message_id,
        tenant_id,
        conversation_id,
        f"media-{message_id}",
        object_id,
    )
    assert object_id is not None
    return message_id, object_id


async def test_message_and_audit_keyset_pagination_is_stable(pg: asyncpg.Connection) -> None:
    tenant_id = await _tenant(pg, "Cursor tenant")
    conversation_id = await _conversation(pg, tenant_id)
    base = datetime(2026, 1, 1, tzinfo=UTC)
    message_ids = [uuid4() for _ in range(5)]
    timestamps = [base + timedelta(minutes=index // 2) for index in range(5)]
    await pg.executemany(
        "INSERT INTO messaging.messages "
        "(id, tenant_id, conversation_id, direction, sender_type, content_type, "
        "content_text, status, created_at, updated_at) "
        "VALUES ($1, $2, $3, 'inbound', 'contact', 'text', 'fixture', 'received', $4, $4)",
        [
            (message_id, tenant_id, conversation_id, created_at)
            for message_id, created_at in zip(message_ids, timestamps, strict=True)
        ],
    )
    expected_messages = sorted(
        zip(timestamps, message_ids, strict=True), key=lambda item: (item[0], item[1]), reverse=True
    )
    first = await pg.fetch(
        "SELECT id, created_at FROM messaging.messages "
        "WHERE tenant_id = $1 AND conversation_id = $2 "
        "ORDER BY created_at DESC, id DESC LIMIT 2",
        tenant_id,
        conversation_id,
    )
    second = await pg.fetch(
        "SELECT id, created_at FROM messaging.messages "
        "WHERE tenant_id = $1 AND conversation_id = $2 "
        "AND (created_at, id) < ($3, $4) "
        "ORDER BY created_at DESC, id DESC LIMIT 2",
        tenant_id,
        conversation_id,
        first[-1]["created_at"],
        first[-1]["id"],
    )
    assert [(row["created_at"], row["id"]) for row in [*first, *second]] == expected_messages[:4]

    audit_ids = [uuid4() for _ in range(4)]
    await pg.executemany(
        "INSERT INTO audit.records "
        "(id, tenant_id, actor_service, action, target_type, occurred_at) "
        "VALUES ($1, $2, 'phase2b', 'fixture.read', 'fixture', $3)",
        [
            (audit_id, tenant_id, base + timedelta(minutes=index // 2))
            for index, audit_id in enumerate(audit_ids)
        ],
    )
    expected_audit = sorted(
        [
            (base + timedelta(minutes=index // 2), audit_id)
            for index, audit_id in enumerate(audit_ids)
        ],
        reverse=True,
    )
    audit_first = await pg.fetch(
        "SELECT id, occurred_at FROM audit.records WHERE tenant_id = $1 "
        "ORDER BY occurred_at DESC, id DESC LIMIT 2",
        tenant_id,
    )
    audit_second = await pg.fetch(
        "SELECT id, occurred_at FROM audit.records WHERE tenant_id = $1 "
        "AND (occurred_at, id) < ($2, $3) "
        "ORDER BY occurred_at DESC, id DESC LIMIT 2",
        tenant_id,
        audit_first[-1]["occurred_at"],
        audit_first[-1]["id"],
    )
    assert [
        (row["occurred_at"], row["id"]) for row in [*audit_first, *audit_second]
    ] == expected_audit


async def test_constraint_and_delete_action_families_execute(pg: asyncpg.Connection) -> None:
    tenant_id = await _tenant(pg, "Constraint tenant")
    user_id = uuid4()
    await pg.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)", user_id, f"{user_id}@example.test"
    )
    contact_id = await pg.fetchval(
        "INSERT INTO crm.contacts (tenant_id, created_by_user_id, name) "
        "VALUES ($1, $2, 'Delete action contact') RETURNING id",
        tenant_id,
        user_id,
    )
    await pg.execute("DELETE FROM users WHERE id = $1", user_id)
    assert (
        await pg.fetchval("SELECT created_by_user_id FROM crm.contacts WHERE id = $1", contact_id)
        is None
    )

    with pytest.raises(asyncpg.CheckViolationError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO objects.object_metadata "
                "(tenant_id, owner_type, category, content_type, byte_size, checksum, "
                "storage_backend, storage_key) "
                "VALUES ($1, 'fixture', 'fixture', 'text/plain', -1, 'bad', 'local', $2)",
                tenant_id,
                f"bad/{uuid4()}",
            )

    conversation_id = await _conversation(pg, tenant_id)
    object_id = await pg.fetchval(
        "INSERT INTO objects.object_metadata "
        "(tenant_id, owner_type, category, content_type, byte_size, checksum, "
        "storage_backend, storage_key, status) "
        "VALUES ($1, 'message', 'attachment', 'text/plain', 1, 'fixture', 'local', $2, "
        "'available') RETURNING id",
        tenant_id,
        f"fixture/{uuid4()}",
    )
    await pg.execute(
        "INSERT INTO messaging.messages "
        "(tenant_id, conversation_id, direction, sender_type, content_type, object_id, status) "
        "VALUES ($1, $2, 'inbound', 'contact', 'document', $3, 'received')",
        tenant_id,
        conversation_id,
        object_id,
    )
    with pytest.raises(asyncpg.RestrictViolationError):
        async with pg.transaction():
            await pg.execute("DELETE FROM objects.object_metadata WHERE id = $1", object_id)
    await pg.execute("DELETE FROM messaging.conversations WHERE id = $1", conversation_id)
    assert not await pg.fetchval(
        "SELECT EXISTS (SELECT 1 FROM messaging.messages WHERE conversation_id = $1)",
        conversation_id,
    )


@pytest.mark.rls
async def test_inbound_media_function_is_current_tenant_and_role_scoped(
    pg: asyncpg.Connection,
) -> None:
    tenant = await _tenant(pg, "Inbox media tenant")
    other_tenant = await _tenant(pg, "Other inbox media tenant")
    message_id, object_id = await _inbound_media(pg, tenant)
    other_message_id, _ = await _inbound_media(pg, other_tenant)
    actor = uuid4()
    await pg.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)", actor, f"{actor}@example.test"
    )
    await pg.execute(
        "INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'viewer')",
        actor,
        tenant,
    )
    function = "messaging.current_tenant_message_media(uuid)"
    definition = await pg.fetchrow(
        "SELECT prosecdef, proconfig FROM pg_proc WHERE oid = $1::regprocedure", function
    )
    assert definition is not None and definition["prosecdef"]
    assert definition["proconfig"] == ["search_path=pg_catalog"]
    assert not await pg.fetchval(
        "SELECT EXISTS (SELECT 1 FROM pg_proc function, "
        "LATERAL aclexplode(function.proacl) acl "
        "WHERE function.oid = $1::regprocedure AND acl.grantee = 0)",
        function,
    )
    assert await pg.fetchval(
        "SELECT has_function_privilege('platform_web', $1, 'EXECUTE')", function
    )

    await pg.execute("SET LOCAL ROLE platform_web")
    await pg.execute(
        "SELECT set_config('app.current_tenant',$1,true), "
        "set_config('app.current_user',$2,true), set_config('app.current_role','viewer',true)",
        str(tenant),
        str(actor),
    )
    visible = await pg.fetch(
        "SELECT id, message_id, content_type, storage_key "
        "FROM messaging.current_tenant_message_media($1)",
        message_id,
    )
    assert len(visible) == 1
    assert visible[0]["message_id"] == message_id
    assert visible[0]["content_type"] == "image/jpeg"
    assert not await pg.fetch(
        "SELECT * FROM messaging.current_tenant_message_media($1)", other_message_id
    )

    await pg.execute("SELECT set_config('app.current_role','agent',true)")
    assert not await pg.fetch(
        "SELECT * FROM messaging.current_tenant_message_media($1)", message_id
    )
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE memberships SET role='technician' WHERE user_id=$1 AND tenant_id=$2",
        actor,
        tenant,
    )
    await pg.execute("SET LOCAL ROLE platform_web")
    await pg.execute("SELECT set_config('app.current_role','technician',true)")
    assert not await pg.fetch(
        "SELECT * FROM messaging.current_tenant_message_media($1)", message_id
    )

    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE memberships SET role='viewer' WHERE user_id=$1 AND tenant_id=$2",
        actor,
        tenant,
    )
    await pg.execute(
        "UPDATE objects.object_metadata SET status='quarantined' WHERE id=$1", object_id
    )
    await pg.execute("SET LOCAL ROLE platform_web")
    await pg.execute("SELECT set_config('app.current_role','viewer',true)")
    assert not await pg.fetch(
        "SELECT * FROM messaging.current_tenant_message_media($1)", message_id
    )
