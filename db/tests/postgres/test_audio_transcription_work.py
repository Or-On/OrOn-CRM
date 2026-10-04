import json
from uuid import uuid4

import asyncpg
import pytest

from db.tests.postgres.test_pagination_and_constraints import _conversation, _tenant

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def seed(pg):
    tenant = await _tenant(pg, "Fictional audio tenant")
    conversation = await _conversation(pg, tenant)
    message, operation, token = uuid4(), uuid4(), uuid4()
    sha = "a" * 64
    obj = await pg.fetchval(
        "INSERT INTO objects.object_metadata(tenant_id,owner_type,owner_id,category,"
        "content_type,byte_size,checksum,storage_backend,storage_key,status) "
        "VALUES($1,'message',$2,'whatsapp_customer_audio','audio/ogg',4,$3,'local',$4,"
        "'available') RETURNING id",
        tenant,
        message,
        sha,
        f"audio/{message}",
    )
    await pg.execute(
        "INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,"
        "content_type,provider,provider_message_id,status,object_id) "
        "VALUES($1,$2,$3,'inbound','contact','audio','meta',$4,'received',$5)",
        message,
        tenant,
        conversation,
        f"fictional-{message}",
        obj,
    )
    job = await pg.fetchval(
        "INSERT INTO ops.jobs(tenant_id,queue,job_type,payload,status,claim_token,"
        "locked_by,locked_at,lease_expires_at) VALUES($1,'messaging',"
        "'whatsapp.audio.transcribe',$2::jsonb,"
        "'running',$3,'fictional-audio-worker',clock_timestamp(),"
        "clock_timestamp()+interval '60 seconds') RETURNING id",
        tenant,
        json.dumps({"messageId": str(message)}),
        token,
    )
    await pg.execute("SET LOCAL ROLE platform_messaging")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    return [operation, message, obj, sha, job, token]


async def begin(pg, args):
    return await pg.fetchrow(
        "SELECT * FROM messaging.begin_audio_transcription($1,$2,$3,$4,$5,$6)", *args
    )


async def advance(pg, args, version, patch):
    return await pg.fetchrow(
        "SELECT * FROM messaging.advance_audio_transcription($1,$2,$3,$4,$5::jsonb)",
        args[0],
        args[4],
        args[5],
        version,
        json.dumps(patch),
    )


async def test_audio_checkpoint_cas_and_no_runtime_dml(pg):
    args = await seed(pg)
    first = await begin(pg, args)
    assert first["version"] == 0
    assert (await begin(pg, args))["operation_id"] == args[0]
    updated = await advance(pg, args, 0, {"phase": "upload_inflight", "attempts": 1})
    assert updated["version"] == 1
    with pytest.raises(asyncpg.SerializationError):
        async with pg.transaction():
            await advance(pg, args, 0, {"phase": "failed"})
    for statement in (
        "UPDATE messaging.audio_transcription_work SET attempts=9",
        "DELETE FROM messaging.audio_transcription_work",
    ):
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            async with pg.transaction():
                await pg.execute(statement)
    assert not await pg.fetchval(
        "SELECT has_function_privilege(current_user,"
        "'messaging.assert_audio_work_claim(uuid,uuid,uuid)','EXECUTE')"
    )
    assert not await pg.fetchval(
        "SELECT has_table_privilege('platform_web','messaging.audio_transcription_work','SELECT')"
    )


@pytest.mark.parametrize("field", [0, 1, 2, 3, 5])
async def test_audio_rejects_mismatched_identity_or_claim(pg, field):
    args = await seed(pg)
    await begin(pg, args)
    changed = list(args)
    changed[field] = "b" * 64 if field == 3 else uuid4()
    with pytest.raises(asyncpg.PostgresError):
        async with pg.transaction():
            await begin(pg, changed)


async def test_audio_foreign_tenant_expired_lease_and_retention(pg):
    args = await seed(pg)
    await begin(pg, args)
    await pg.execute("RESET ROLE")
    foreign = await _tenant(pg, "Fictional foreign audio tenant")
    await pg.execute("SET LOCAL ROLE platform_messaging")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(foreign))
    assert await pg.fetchval("SELECT count(*) FROM messaging.audio_transcription_work") == 0
    with pytest.raises(asyncpg.PostgresError):
        async with pg.transaction():
            await begin(pg, args)
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE ops.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        args[4],
    )
    tenant = await pg.fetchval("SELECT tenant_id FROM ops.jobs WHERE id=$1", args[4])
    await pg.execute("SET LOCAL ROLE platform_messaging")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    with pytest.raises(asyncpg.PostgresError):
        async with pg.transaction():
            await advance(pg, args, 0, {"phase": "failed"})
    await pg.execute("RESET ROLE")
    with pytest.raises(asyncpg.RestrictViolationError):
        async with pg.transaction():
            await pg.execute("DELETE FROM messaging.messages WHERE id=$1", args[1])


async def test_audio_preserves_provider_identity_and_terminal_state(pg):
    args = await seed(pg)
    await begin(pg, args)
    await advance(pg, args, 0, {"phase": "upload_inflight"})
    file_id, provider_id = str(uuid4()), str(uuid4())
    await advance(pg, args, 1, {"phase": "uploaded", "fileId": file_id})
    with pytest.raises(asyncpg.PostgresError):
        async with pg.transaction():
            await advance(pg, args, 2, {"fileId": str(uuid4())})
    await advance(pg, args, 2, {"phase": "submit_inflight"})
    await advance(pg, args, 3, {"phase": "submitted", "providerJobId": provider_id})
    done = await advance(pg, args, 4, {"phase": "completed", "transcript": "Fictional text"})
    assert done["transcript"] == "Fictional text"
    for patch in ({"phase": "new"}, {"transcript": "overwritten"}, {"tenantId": str(uuid4())}):
        with pytest.raises(asyncpg.PostgresError):
            async with pg.transaction():
                await advance(pg, args, 5, patch)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute("UPDATE messaging.audio_transcription_work SET transcript='forged'")
