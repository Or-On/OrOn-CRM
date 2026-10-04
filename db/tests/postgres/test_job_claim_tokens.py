from uuid import uuid4

import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration]


@pytest.mark.parametrize(
    "signature,statement",
    [
        (
            "ops.claim_jobs(text,text,integer,integer)",
            "SELECT ops.claim_jobs('fixture','messaging',1,120)",
        ),
        (
            "ops.fail_job(uuid,text,text,integer)",
            "SELECT ops.fail_job(gen_random_uuid(),'fixture','fixture',1)",
        ),
    ],
)
async def test_messaging_cannot_call_legacy_unfenced_job_functions(pg, signature, statement):
    import asyncpg

    assert not await pg.fetchval(
        "SELECT has_function_privilege('platform_messaging',$1,'EXECUTE')", signature
    )
    # Preserve the transaction after PostgreSQL aborts the rejected statement.
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute("SET LOCAL ROLE platform_messaging")
            await pg.execute(statement)


async def test_same_worker_reclaim_has_new_token_and_old_claim_cannot_mutate(pg):
    tenant, job = uuid4(), uuid4()
    await pg.execute(
        "INSERT INTO tenants(id,name,slug) VALUES($1,'Fictional claim tenant',$2)",
        tenant,
        str(tenant),
    )
    await pg.execute(
        "INSERT INTO "
        "ops.jobs(id,tenant_id,queue,job_type,priority,max_attempts,payload) "
        "VALUES($1,$2,'messaging','fixture',9999,3,'{}')",
        job,
        tenant,
    )
    await pg.execute("SET LOCAL ROLE platform_messaging")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    first = await pg.fetchrow(
        "SELECT id,claim_token FROM ops.claim_jobs_all_tenants('same-worker','messaging',1,120)"
    )
    assert first["id"] == job
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE ops.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        job,
    )
    await pg.execute("SET LOCAL ROLE platform_messaging")
    second = await pg.fetchrow(
        "SELECT id,claim_token FROM ops.claim_jobs_all_tenants('same-worker','messaging',1,120)"
    )
    assert second["id"] == job and second["claim_token"] != first["claim_token"]
    assert not await pg.fetchval(
        "SELECT ops.renew_messaging_job_claim($1,'same-worker',$2)", job, first["claim_token"]
    )
    assert await pg.fetchval(
        "SELECT ops.renew_messaging_job_claim($1,'same-worker',$2)", job, second["claim_token"]
    )
    assert (
        await pg.fetchval(
            "SELECT (ops.fail_messaging_job_claim($1,'same-worker',$2,'stale',1)).id",
            job,
            first["claim_token"],
        )
        is None
    )
    result = await pg.execute(
        "UPDATE ops.jobs SET status='succeeded' WHERE id=$1 AND claim_token=$2 AND "
        "lease_expires_at>clock_timestamp()",
        job,
        first["claim_token"],
    )
    assert result == "UPDATE 0"
    assert await pg.fetchval("SELECT status FROM ops.jobs WHERE id=$1", job) == "running"
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(uuid4()))
    assert not await pg.fetchval(
        "SELECT ops.renew_messaging_job_claim($1,'same-worker',$2)", job, second["claim_token"]
    )
    assert (
        await pg.fetchval(
            "SELECT (ops.fail_messaging_job_claim($1,'same-worker',$2,'foreign',1)).id",
            job,
            second["claim_token"],
        )
        is None
    )
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE ops.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        job,
    )
    await pg.execute("SET LOCAL ROLE platform_messaging")
    assert not await pg.fetchval(
        "SELECT ops.renew_messaging_job_claim($1,'same-worker',$2)", job, second["claim_token"]
    )
    assert (
        await pg.fetchval(
            "SELECT (ops.fail_messaging_job_claim($1,'same-worker',$2,'expired',1)).id",
            job,
            second["claim_token"],
        )
        is None
    )


async def test_expired_final_attempt_is_terminal_once_and_field_service_scope_is_narrow(pg):
    tenant, exhausted, service_job, forbidden = uuid4(), uuid4(), uuid4(), uuid4()
    await pg.execute(
        "INSERT INTO tenants(id,name,slug) VALUES($1,'Fictional final claim',$2)",
        tenant,
        str(tenant),
    )
    await pg.execute(
        "INSERT INTO "
        "ops.jobs(id,tenant_id,queue,job_type,status,attempts,max_attempts,locked_by,"
        "locked_at,lease_expires_at,payload) "
        "VALUES($1,$2,'messaging','fixture','running',1,1,'expired-worker',"
        "clock_timestamp()-interval '200 seconds',clock_timestamp()-interval '1 second','{}')",
        exhausted,
        tenant,
    )
    await pg.execute(
        "INSERT INTO ops.jobs(id,tenant_id,queue,job_type,priority,payload) "
        "VALUES($1,$2,'field_service','field_service.ocr',9999,'{}'),($3,$2,'field_service','voice.unrelated',9999,'{}')",
        service_job,
        tenant,
        forbidden,
    )
    await pg.execute("SET LOCAL ROLE platform_messaging")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    await pg.fetch("SELECT id FROM ops.claim_jobs_all_tenants('worker','messaging',1,120)")
    await pg.fetch("SELECT id FROM ops.claim_jobs_all_tenants('worker','messaging',1,120)")
    assert await pg.fetchval("SELECT status FROM ops.jobs WHERE id=$1", exhausted) == "dead"
    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM audit.records WHERE target_id=$1 AND "
            "action='job.lease_exhausted'",
            exhausted,
        )
        == 1
    )
    await pg.execute("SET LOCAL ROLE platform_messaging")
    row = await pg.fetchrow(
        "SELECT id,claim_token FROM ops.claim_jobs_all_tenants('worker','field_service',1,120)"
    )
    assert row["id"] == service_job and row["claim_token"] is not None
    assert not await pg.fetch("SELECT id FROM ops.claim_jobs_all_tenants('worker','voice',10,120)")
    assert await pg.fetchval("SELECT status FROM ops.jobs WHERE id=$1", forbidden) == "queued"
