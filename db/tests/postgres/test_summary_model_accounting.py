"""Summary-only capability positives and negative authorization on actual PG."""

# ruff: noqa: F811
import json
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from db.tests.postgres.lead_capture_support import execute, seed_call
from db.tests.postgres.test_voice_memory_capture import enable_memory
from db.tests.postgres.test_voice_service_intake_runtime import service_runtime  # noqa: F401

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def setup(service_runtime):
    runtime, context, connection, _ = service_runtime
    await enable_memory(connection, context.tenant_id)
    await connection.execute(text("RESET ROLE"))
    configuration, credential = uuid4(), uuid4()
    await execute(
        connection,
        "INSERT INTO platform.credential_records(id,tenant_id,kind,algorithm,key_version,"
        "ciphertext,nonce) "
        "VALUES(:credential,:tenant,'llm_api_key_v2','aes-256-gcm:model-provider:v2','syn"
        "thetic:v2',decode(repeat('ab',32),'hex'),decode(repeat('ab',12),'hex'))",
        credential=credential,
        tenant=context.tenant_id,
    )
    await execute(
        connection,
        "INSERT INTO agents.model_configurations(id,tenant_id,name,provider,model,credent"
        "ial_id,settings,daily_request_limit,is_enabled) VALUES(:id,:tenant,'Synthetic "
        "summary','openai','synthetic-model',:credential,'{}',1,true)",
        id=configuration,
        tenant=context.tenant_id,
        credential=credential,
    )
    version = uuid4()
    await execute(
        connection,
        """INSERT INTO agents.agent_profile_versions
    (id,tenant_id,agent_profile_id,version,system_prompt,locale,channel_capabilities,
    tool_permissions,validation_status,published_at,model_configuration_id)
    SELECT :version,tenant_id,agent_profile_id,version+1,system_prompt,locale,
    channel_capabilities,tool_permissions,validation_status,CURRENT_TIMESTAMP,:configuration
    FROM agents.agent_profile_versions WHERE id=(SELECT (payload->>'agent_version_id')::uuid
    FROM public.session_events WHERE session_id=:session AND event_type='voice.agent.binding.v1')
    """,
        version=version,
        configuration=configuration,
        session=context.session_id,
    )
    session = await seed_call(connection, context.tenant_id, context.contact_id)
    context = context.model_copy(update={"session_id": session})
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    await runtime.pin_voice_agent(context, version)
    for ordinal in range(1, 11):
        await runtime.append_voice_memory_turn(context, ordinal, f"Synthetic assertion {ordinal}")
    await connection.execute(text("SET LOCAL ROLE platform_messaging"))
    job = (
        await execute(
            connection, "SELECT id,claim_token FROM ops.claim_memory_summary('synthetic-summary')"
        )
    ).one()
    return connection, context, configuration, job


async def project(connection, job):
    return (
        await execute(
            connection,
            "SELECT platform.memory_summary_model_projection(:job,'synthetic-summary',:token)",
            job=job.id,
            token=job.claim_token,
        )
    ).scalar_one()


async def test_summary_projection_reservation_accounting_and_no_direct_grants(service_runtime):
    connection, context, configuration, job = await setup(service_runtime)
    projection = await project(connection, job)
    assert projection["credential"]["tenantId"] == str(context.tenant_id)
    attempt = (
        await execute(
            connection,
            "SELECT platform.reserve_memory_summary_attempt(:job,'synthetic-"
            "summary',:token,CAST(:expected AS jsonb))",
            job=job.id,
            token=job.claim_token,
            expected=json.dumps(projection),
        )
    ).scalar_one()
    await execute(
        connection,
        "SELECT platform.settle_memory_summary_attempt(:job,'synthetic-"
        "summary',:token,:attempt,true,23,7)",
        job=job.id,
        token=job.claim_token,
        attempt=attempt,
    )
    with pytest.raises(DBAPIError):
        async with connection.begin_nested():
            await connection.execute(text("SELECT * FROM agents.memory_summary_attempts"))
    with pytest.raises(DBAPIError):
        async with connection.begin_nested():
            await execute(
                connection,
                "SELECT platform.reserve_memory_summary_attempt(:job,'synthetic-"
                "summary',:token,CAST(:expected AS jsonb))",
                job=job.id,
                token=job.claim_token,
                expected=json.dumps(projection),
            )
    await connection.execute(text("RESET ROLE"))
    assert (
        await execute(
            connection,
            "SELECT state,input_tokens,output_tokens FROM agents.memory_summary_attempts "
            "WHERE id=:attempt",
            attempt=attempt,
        )
    ).one() == ("complete", 23, 7)
    assert (
        await execute(
            connection,
            "SELECT reserved_attempts FROM agents.model_daily_reservations WHERE "
            "model_configuration_id=:configuration",
            configuration=configuration,
        )
    ).scalar_one() == 1


@pytest.mark.parametrize(
    "mode",
    [
        "wrong_claim",
        "foreign_tenant",
        "disabled",
        "rotated",
        "expired",
        "quota",
        "zero",
        "unlimited",
    ],
)
async def test_summary_attempt_rechecks_authority_and_does_not_charge_rejected_work(
    service_runtime, mode
):
    connection, context, configuration, job = await setup(service_runtime)
    projection = await project(connection, job)
    await connection.execute(text("RESET ROLE"))
    if mode == "disabled":
        await execute(
            connection,
            "UPDATE agents.model_configurations SET is_enabled=false WHERE id=:id",
            id=configuration,
        )
    if mode == "rotated":
        await execute(
            connection,
            "UPDATE platform.credential_records SET nonce=decode(repeat('cd',12),'hex') "
            "WHERE id=:id",
            id=projection["credential"]["credentialId"],
        )
    if mode == "expired":
        await execute(
            connection,
            "UPDATE ops.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' "
            "WHERE id=:id",
            id=job.id,
        )
    if mode == "zero":
        with pytest.raises(DBAPIError):
            async with connection.begin_nested():
                await execute(
                    connection,
                    "UPDATE agents.model_configurations SET daily_request_limit=0 WHERE id=:id",
                    id=configuration,
                )
        assert (
            await execute(
                connection,
                "SELECT count(*) FROM agents.memory_summary_attempts WHERE job_id=:id",
                id=job.id,
            )
        ).scalar_one() == 0
        return
    if mode == "unlimited":
        await execute(
            connection,
            "UPDATE agents.model_configurations SET daily_request_limit=NULL WHERE id=:id",
            id=configuration,
        )
    if mode == "quota":
        await execute(
            connection,
            "INSERT INTO agents.model_daily_reservations(tenant_id,model_configuration_id"
            ",utc_day,reserved_attempts) VALUES(:tenant,:id,(clock_timestamp() AT TIME "
            "ZONE 'UTC')::date,1)",
            tenant=context.tenant_id,
            id=configuration,
        )
    await connection.execute(text("SET LOCAL ROLE platform_messaging"))
    if mode == "foreign_tenant":
        await execute(
            connection, "SELECT set_config('app.current_tenant',:tenant,true)", tenant=str(uuid4())
        )
    with pytest.raises(DBAPIError):
        async with connection.begin_nested():
            await execute(
                connection,
                "SELECT platform.reserve_memory_summary_attempt(:job,'synthetic-"
                "summary',:token,CAST(:expected AS jsonb))",
                job=job.id,
                token=uuid4() if mode == "wrong_claim" else job.claim_token,
                expected=json.dumps(projection),
            )
    await connection.execute(text("RESET ROLE"))
    assert (
        await execute(
            connection,
            "SELECT count(*) FROM agents.memory_summary_attempts WHERE job_id=:id",
            id=job.id,
        )
    ).scalar_one() == 0
    assert (
        await execute(
            connection,
            "SELECT coalesce(sum(reserved_attempts),0) FROM "
            "agents.model_daily_reservations WHERE model_configuration_id=:id",
            id=configuration,
        )
    ).scalar_one() == (1 if mode == "quota" else 0)


@pytest.mark.parametrize("mode", ["disabled", "rotated", "expired"])
async def test_summary_after_provider_authority_revoke_retains_unknown_attempt(
    service_runtime, mode
):
    connection, context, configuration, job = await setup(service_runtime)
    projection = await project(connection, job)
    attempt = (
        await execute(
            connection,
            "SELECT platform.reserve_memory_summary_attempt(:job,'synthetic-summary',:token,"
            "CAST(:expected AS jsonb))",
            job=job.id,
            token=job.claim_token,
            expected=json.dumps(projection),
        )
    ).scalar_one()
    await connection.execute(text("RESET ROLE"))
    if mode == "disabled":
        await execute(
            connection,
            "UPDATE agents.model_configurations SET is_enabled=false WHERE id=:id",
            id=configuration,
        )
    if mode == "rotated":
        await execute(
            connection,
            "UPDATE platform.credential_records SET nonce=decode(repeat('cd',12),'hex') "
            "WHERE id=:id",
            id=projection["credential"]["credentialId"],
        )
    if mode == "expired":
        await execute(
            connection,
            "UPDATE ops.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' "
            "WHERE id=:id",
            id=job.id,
        )
    await connection.execute(text("SET LOCAL ROLE platform_messaging"))
    with pytest.raises(DBAPIError):
        async with connection.begin_nested():
            await execute(
                connection,
                "SELECT platform.settle_memory_summary_attempt(:job,'synthetic-summary',:token,"
                ":attempt,true,23,7)",
                job=job.id,
                token=job.claim_token,
                attempt=attempt,
            )
    await connection.execute(text("RESET ROLE"))
    assert (
        await execute(
            connection,
            "SELECT state,input_tokens,output_tokens FROM agents.memory_summary_attempts "
            "WHERE id=:id",
            id=attempt,
        )
    ).one() == ("reserved", None, None)
    assert (
        await execute(
            connection,
            "SELECT reserved_attempts FROM agents.model_daily_reservations "
            "WHERE model_configuration_id=:id",
            id=configuration,
        )
    ).scalar_one() == 1
