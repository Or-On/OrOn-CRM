from __future__ import annotations

import asyncio
import base64
import json
from typing import Any
from uuid import UUID, uuid4

import asyncpg
import pytest

from db.alembic.oron_migration_compat import LocalFieldCipher, blind_index
from db.tests.postgres.conftest import run_alembic

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.migration]

DEFAULT_TENANT_ID = UUID("00000000-0000-0000-0000-000000000001")
FIELD_CIPHER_TEST_KEY = bytes(range(32))
BLIND_INDEX_TEST_KEY = bytes(range(1, 33))


async def test_historical_nonempty_phone_backfill_preserves_oron_semantics(
    isolated_postgres_url: str,
) -> None:
    await run_alembic(isolated_postgres_url, "upgrade", "0003")
    cipher = LocalFieldCipher(FIELD_CIPHER_TEST_KEY)
    plaintext_id = uuid4()
    untouched_id = uuid4()
    encrypted_id = uuid4()
    encrypted_from = cipher.encrypt(DEFAULT_TENANT_ID, "+14155550200")
    encrypted_to = cipher.encrypt(DEFAULT_TENANT_ID, "+14155559998")

    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        await connection.executemany(
            "INSERT INTO sessions "
            "(session_id, tenant_id, provider, direction, room, status, from_number, "
            "to_number, created_at, updated_at) "
            "VALUES ($1, $2, 'livekit', 'inbound', $3, 'started', $4, $5, now(), now())",
            [
                (
                    plaintext_id,
                    DEFAULT_TENANT_ID,
                    "phase2b-plaintext",
                    "+1 (415) 555-0100",
                    "+14155559999",
                ),
                (untouched_id, DEFAULT_TENANT_ID, "phase2b-empty", None, ""),
                (
                    encrypted_id,
                    DEFAULT_TENANT_ID,
                    "phase2b-encrypted",
                    encrypted_from,
                    encrypted_to,
                ),
            ],
        )
    finally:
        await connection.close()

    await run_alembic(
        isolated_postgres_url,
        "upgrade",
        "0004",
        extra_env={
            "FIELD_CIPHER_BACKEND": "local",
            "FIELD_CIPHER_LOCAL_KEY": base64.b64encode(FIELD_CIPHER_TEST_KEY).decode("ascii"),
            "BLIND_INDEX_KEY": base64.b64encode(BLIND_INDEX_TEST_KEY).decode("ascii"),
        },
    )

    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        plaintext = await connection.fetchrow(
            "SELECT from_number, to_number, from_number_bidx FROM sessions WHERE session_id = $1",
            plaintext_id,
        )
        untouched = await connection.fetchrow(
            "SELECT from_number, to_number, from_number_bidx FROM sessions WHERE session_id = $1",
            untouched_id,
        )
        encrypted = await connection.fetchrow(
            "SELECT from_number, to_number, from_number_bidx FROM sessions WHERE session_id = $1",
            encrypted_id,
        )
    finally:
        await connection.close()

    assert plaintext is not None
    assert cipher.decrypt(DEFAULT_TENANT_ID, plaintext["from_number"]) == "+1 (415) 555-0100"
    assert cipher.decrypt(DEFAULT_TENANT_ID, plaintext["to_number"]) == "+14155559999"
    assert plaintext["from_number_bidx"] == blind_index("+1 (415) 555-0100", BLIND_INDEX_TEST_KEY)
    assert untouched is not None
    assert tuple(untouched.values()) == (None, "", None)
    assert encrypted is not None
    assert encrypted["from_number"] == encrypted_from
    assert encrypted["to_number"] == encrypted_to
    assert encrypted["from_number_bidx"] is None


async def test_supported_target_successor_downgrade_and_reupgrade(
    isolated_postgres_url: str,
    schema_manifest: dict[str, Any],
) -> None:
    await run_alembic(isolated_postgres_url, "upgrade", "head")
    await run_alembic(isolated_postgres_url, "downgrade", "a41d2f6c2925")

    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        assert not await connection.fetchval(
            "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'crm')"
        )
        assert (
            await connection.fetchval("SELECT version_num FROM alembic_version") == "a41d2f6c2925"
        )
    finally:
        await connection.close()

    await run_alembic(isolated_postgres_url, "upgrade", "head")
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        assert (
            await connection.fetchval("SELECT version_num FROM alembic_version")
            == schema_manifest["alembic_head"]
        )
        assert await connection.fetchval(
            "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'live')"
        )
    finally:
        await connection.close()


async def test_ai_handoff_tasks_are_backfilled_to_their_contact(
    isolated_postgres_url: str,
) -> None:
    await run_alembic(isolated_postgres_url, "upgrade", "e1c47b9a2f60")
    connection = await asyncpg.connect(isolated_postgres_url)
    tenant_id = uuid4()
    contact_id = uuid4()
    handoff_id = uuid4()
    task_id = uuid4()
    try:
        await connection.execute(
            "INSERT INTO tenants(id,name,slug,status) VALUES($1,'Fictional backfill',$2,'active')",
            tenant_id,
            f"handoff-backfill-{tenant_id}",
        )
        await connection.execute(
            "INSERT INTO crm.contacts(id,tenant_id,name) VALUES($1,$2,'Fictional contact')",
            contact_id,
            tenant_id,
        )
        await connection.execute(
            "INSERT INTO automation.handoffs"
            "(id,tenant_id,contact_id,source_channel,reason_safe,status,idempotency_key) "
            "VALUES($1,$2,$3,'whatsapp','Fictional unresolved issue','pending',$4)",
            handoff_id,
            tenant_id,
            contact_id,
            f"fixture-{handoff_id}",
        )
        await connection.execute(
            "INSERT INTO crm.tasks(id,tenant_id,title,status,priority) "
            "VALUES($1,$2,'Fictional handoff task','todo','high')",
            task_id,
            tenant_id,
        )
        await connection.execute(
            "INSERT INTO audit.records"
            "(tenant_id,actor_service,action,target_type,target_id,metadata) "
            "VALUES($1,'fixture','conversation.ai_handoff_ticket','handoff',$2,$3::jsonb)",
            tenant_id,
            handoff_id,
            json.dumps({"taskId": str(task_id)}),
        )
    finally:
        await connection.close()

    await run_alembic(isolated_postgres_url, "upgrade", "head")
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        assert (
            await connection.fetchval("SELECT contact_id FROM crm.tasks WHERE id=$1", task_id)
            == contact_id
        )
    finally:
        await connection.close()

    await run_alembic(isolated_postgres_url, "downgrade", "e1c47b9a2f60")
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        assert not await connection.fetchval(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
            "WHERE table_schema='crm' AND table_name='tasks' AND column_name='contact_id')"
        )
    finally:
        await connection.close()


async def test_whatsapp_binding_upgrade_and_downgrade_quarantine_pending_work(
    isolated_postgres_url: str,
) -> None:
    await run_alembic(isolated_postgres_url, "upgrade", "6f1c8a2d4e90")
    tenant_id = uuid4()
    user_id = uuid4()
    contact_id = uuid4()
    identity_id = uuid4()
    channel_id = uuid4()
    conversation_id = uuid4()
    trigger_id = uuid4()
    legacy_message_id = uuid4()
    terminal_message_id = uuid4()
    legacy_request_id = uuid4()
    terminal_request_id = uuid4()
    legacy_outbound_job_id = uuid4()
    legacy_callback_job_id = uuid4()
    legacy_cancelled_callback_job_id = uuid4()

    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        await connection.execute(
            "INSERT INTO tenants(id,name,slug,status) "
            "VALUES($1,'Fictional binding migration',$2,'active')",
            tenant_id,
            f"binding-migration-{tenant_id}",
        )
        await connection.execute(
            "INSERT INTO users(id,email,status) VALUES($1,$2,'active')",
            user_id,
            f"binding-{user_id}@example.invalid",
        )
        await connection.execute(
            "INSERT INTO crm.contacts(id,tenant_id,name) VALUES($1,$2,'Fictional contact')",
            contact_id,
            tenant_id,
        )
        await connection.execute(
            "INSERT INTO crm.contact_channel_identities"
            "(id,tenant_id,contact_id,channel,normalized_value,display_value,"
            "validation_status,is_primary) "
            "VALUES($1,$2,$3,'whatsapp','+12025550198','+12025550198','valid',true)",
            identity_id,
            tenant_id,
            contact_id,
        )
        await connection.execute(
            "INSERT INTO messaging.channels"
            "(id,tenant_id,kind,provider,provider_account_id,status,configuration) "
            "VALUES($1,$2,'whatsapp','meta',$3,'active','{}'::jsonb)",
            channel_id,
            tenant_id,
            f"fixture-{channel_id}",
        )
        await connection.execute(
            "INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status) "
            "VALUES($1,$2,$3,$4,'open')",
            conversation_id,
            tenant_id,
            channel_id,
            contact_id,
        )
        await connection.executemany(
            "INSERT INTO messaging.messages"
            "(id,tenant_id,conversation_id,direction,sender_type,sender_user_id,"
            "sender_contact_id,content_type,content_text,provider,status) "
            "VALUES($1,$2,$3,$4,$5,$6,$7,'text',$8,'meta',$9)",
            [
                (
                    trigger_id,
                    tenant_id,
                    conversation_id,
                    "inbound",
                    "contact",
                    None,
                    contact_id,
                    "Please call me.",
                    "received",
                ),
                (
                    legacy_message_id,
                    tenant_id,
                    conversation_id,
                    "outbound",
                    "user",
                    user_id,
                    None,
                    "Legacy queued reply",
                    "queued",
                ),
                (
                    terminal_message_id,
                    tenant_id,
                    conversation_id,
                    "outbound",
                    "user",
                    user_id,
                    None,
                    "Legacy sent reply",
                    "sent",
                ),
            ],
        )
        await connection.executemany(
            "INSERT INTO messaging.outbound_requests"
            "(id,tenant_id,conversation_id,message_id,channel_id,recipient_identity_id,"
            "requested_by_user_id,provider,message_kind,explicitly_confirmed,status,"
            "idempotency_key) "
            "VALUES($1,$2,$3,$4,$5,$6,$7,'meta','text',true,$8,$9)",
            [
                (
                    legacy_request_id,
                    tenant_id,
                    conversation_id,
                    legacy_message_id,
                    channel_id,
                    identity_id,
                    user_id,
                    "queued",
                    f"legacy-request-{legacy_request_id}",
                ),
                (
                    terminal_request_id,
                    tenant_id,
                    conversation_id,
                    terminal_message_id,
                    channel_id,
                    identity_id,
                    user_id,
                    "sent",
                    f"terminal-request-{terminal_request_id}",
                ),
            ],
        )
        await connection.execute(
            "INSERT INTO ops.jobs"
            "(id,tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key) "
            "VALUES($1,$2,'messaging','whatsapp.outbound.send','outbound_request',$3,$4::jsonb,$5)",
            legacy_outbound_job_id,
            tenant_id,
            legacy_request_id,
            json.dumps({"requestId": str(legacy_request_id)}),
            f"legacy-outbound-{legacy_outbound_job_id}",
        )
        await connection.execute(
            "INSERT INTO ops.jobs"
            "(id,tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key) "
            "VALUES($1,$2,'messaging','whatsapp.ai.call','conversation',$3,$4::jsonb,$5)",
            legacy_callback_job_id,
            tenant_id,
            conversation_id,
            json.dumps({"triggerMessageId": str(trigger_id)}),
            f"legacy-callback-{legacy_callback_job_id}",
        )
        await connection.execute(
            "INSERT INTO ops.jobs"
            "(id,tenant_id,queue,job_type,reference_type,reference_id,payload,"
            "idempotency_key,status) "
            "VALUES($1,$2,'messaging','whatsapp.ai.call','conversation',$3,$4::jsonb,$5,"
            "'cancelled')",
            legacy_cancelled_callback_job_id,
            tenant_id,
            conversation_id,
            json.dumps({"triggerMessageId": str(trigger_id)}),
            f"legacy-cancelled-callback-{legacy_cancelled_callback_job_id}",
        )
    finally:
        await connection.close()

    await run_alembic(isolated_postgres_url, "upgrade", "head")
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        assert await connection.fetchval(
            "SELECT has_table_privilege("
            "'platform_web','messaging.inbound_message_origins','SELECT')"
        )
        quarantined = await connection.fetchrow(
            "SELECT status,recipient_address,last_error_code "
            "FROM messaging.outbound_requests WHERE id=$1",
            legacy_request_id,
        )
        assert quarantined is not None
        assert tuple(quarantined.values()) == (
            "failed",
            None,
            "legacy_recipient_binding_unavailable",
        )
        assert (
            await connection.fetchval(
                "SELECT recipient_address FROM messaging.outbound_requests WHERE id=$1",
                terminal_request_id,
            )
            == "+12025550198"
        )
        assert (
            await connection.fetchval(
                "SELECT status FROM messaging.messages WHERE id=$1", legacy_message_id
            )
            == "failed"
        )
        assert (
            await connection.fetchval(
                "SELECT status FROM ops.jobs WHERE id=$1", legacy_outbound_job_id
            )
            == "dead"
        )
        assert (
            await connection.fetchval(
                "SELECT status FROM ops.jobs WHERE id=$1", legacy_callback_job_id
            )
            == "dead"
        )
        cancelled_callback = await connection.fetchrow(
            "SELECT status,callback_trigger_message_id,callback_sender_identity_id,"
            "callback_destination FROM ops.jobs WHERE id=$1",
            legacy_cancelled_callback_job_id,
        )
        assert cancelled_callback is not None
        assert tuple(cancelled_callback.values()) == ("cancelled", None, None, None)
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM audit.records WHERE tenant_id=$1 AND action IN "
                "('whatsapp.outbound.legacy_quarantined','conversation.callback.legacy_quarantined')",
                tenant_id,
            )
            == 2
        )

        new_trigger_id = uuid4()
        new_message_id = uuid4()
        new_request_id = uuid4()
        new_outbound_job_id = uuid4()
        new_callback_job_id = uuid4()
        await connection.execute(
            "INSERT INTO messaging.messages"
            "(id,tenant_id,conversation_id,direction,sender_type,sender_contact_id,"
            "content_type,content_text,provider,status) "
            "VALUES($1,$2,$3,'inbound','contact',$4,'text','Please call me.','meta','received')",
            new_trigger_id,
            tenant_id,
            conversation_id,
            contact_id,
        )
        await connection.execute(
            "INSERT INTO messaging.inbound_message_origins"
            "(tenant_id,message_id,contact_identity_id,sender_address) "
            "VALUES($1,$2,$3,'+12025550198')",
            tenant_id,
            new_trigger_id,
            identity_id,
        )
        await connection.execute(
            "INSERT INTO messaging.messages"
            "(id,tenant_id,conversation_id,direction,sender_type,sender_user_id,"
            "content_type,content_text,provider,status) "
            "VALUES($1,$2,$3,'outbound','user',$4,'text','Protected queued reply','meta','queued')",
            new_message_id,
            tenant_id,
            conversation_id,
            user_id,
        )
        await connection.execute(
            "INSERT INTO messaging.outbound_requests"
            "(id,tenant_id,conversation_id,message_id,channel_id,recipient_identity_id,"
            "recipient_address,requested_by_user_id,provider,message_kind,"
            "explicitly_confirmed,status,idempotency_key) "
            "VALUES($1,$2,$3,$4,$5,$6,'+12025550198',$7,'meta','text',true,'queued',$8)",
            new_request_id,
            tenant_id,
            conversation_id,
            new_message_id,
            channel_id,
            identity_id,
            user_id,
            f"protected-request-{new_request_id}",
        )
        await connection.execute(
            "INSERT INTO ops.jobs"
            "(id,tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key) "
            "VALUES($1,$2,'messaging','whatsapp.outbound.send','outbound_request',$3,$4::jsonb,$5)",
            new_outbound_job_id,
            tenant_id,
            new_request_id,
            json.dumps({"requestId": str(new_request_id)}),
            f"protected-outbound-{new_outbound_job_id}",
        )
        await connection.execute(
            "INSERT INTO ops.jobs"
            "(id,tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,"
            "callback_trigger_message_id,callback_sender_identity_id,callback_destination) "
            "VALUES($1,$2,'messaging','whatsapp.ai.call','conversation',$3,$4::jsonb,$5,$6,$7,'+12025550198')",
            new_callback_job_id,
            tenant_id,
            conversation_id,
            json.dumps({"triggerMessageId": str(new_trigger_id)}),
            f"protected-callback-{new_callback_job_id}",
            new_trigger_id,
            identity_id,
        )
        await connection.execute(
            """
            CREATE FUNCTION audit.pause_binding_downgrade_test()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
              PERFORM pg_sleep(2);
              RETURN NEW;
            END
            $$
            """
        )
        await connection.execute(
            "CREATE TRIGGER trg_pause_binding_downgrade_test "
            "BEFORE INSERT ON audit.records FOR EACH ROW "
            "WHEN (NEW.action = 'whatsapp.outbound.downgrade_quarantined') "
            "EXECUTE FUNCTION audit.pause_binding_downgrade_test()"
        )
    finally:
        await connection.close()

    downgrade_task = asyncio.create_task(
        run_alembic(isolated_postgres_url, "downgrade", "6f1c8a2d4e90")
    )
    lock_probe = await asyncpg.connect(isolated_postgres_url)
    expected_locks = {
        "messaging.messages",
        "messaging.inbound_message_origins",
        "messaging.outbound_requests",
        "ops.jobs",
    }
    locked_relations: set[str] = set()
    try:
        for _ in range(200):
            locked_relations = {
                row[0]
                for row in await lock_probe.fetch(
                    "SELECT namespace.nspname || '.' || relation.relname "
                    "FROM pg_locks held_lock "
                    "JOIN pg_class relation ON relation.oid=held_lock.relation "
                    "JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace "
                    "WHERE held_lock.database=(SELECT oid FROM pg_database "
                    "WHERE datname=current_database()) "
                    "AND held_lock.mode='AccessExclusiveLock' AND held_lock.granted"
                )
            }
            if expected_locks <= locked_relations:
                break
            if downgrade_task.done():
                await downgrade_task
                pytest.fail("downgrade completed without holding all quarantine locks")
            await asyncio.sleep(0.025)
        assert expected_locks <= locked_relations
    finally:
        await lock_probe.close()
    await downgrade_task
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        assert (
            await connection.fetchval(
                "SELECT status FROM messaging.outbound_requests WHERE id=$1",
                new_request_id,
            )
            == "failed"
        )
        assert (
            await connection.fetchval(
                "SELECT status FROM messaging.messages WHERE id=$1", new_message_id
            )
            == "failed"
        )
        assert (
            await connection.fetchval(
                "SELECT status FROM ops.jobs WHERE id=$1", new_outbound_job_id
            )
            == "dead"
        )
        assert (
            await connection.fetchval(
                "SELECT status FROM ops.jobs WHERE id=$1", new_callback_job_id
            )
            == "dead"
        )
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM audit.records WHERE tenant_id=$1 AND action IN "
                "('whatsapp.outbound.downgrade_quarantined','conversation.callback.downgrade_quarantined')",
                tenant_id,
            )
            == 2
        )
        assert not await connection.fetchval(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
            "WHERE table_schema='messaging' AND table_name='outbound_requests' "
            "AND column_name='recipient_address')"
        )
    finally:
        await connection.close()
