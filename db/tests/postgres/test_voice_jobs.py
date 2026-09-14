from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from uuid import uuid4

import asyncpg
import pytest
import pytest_asyncio
from control_api.auth import ServicePrincipal
from control_api.voice import PostgresVoiceRepository, SimulatedCallConflict, SimulatedCallRequest
from control_api.voice_jobs import consume_voice_simulation
from oron_flows.graph import FlowSpec
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from db.tests.postgres.conftest import run_alembic
from db.tests.postgres.test_phase6_cross_channel import _tenant_fixture

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def test_voice_replay_is_bound_to_frozen_flow_version(voice_jobs: tuple) -> None:
    _, repository, tenant, _, actor, contact, _, job, _ = voice_jobs
    identifier = uuid4()
    spec = FlowSpec.model_validate(
        {
            "id": str(identifier),
            "version": 1,
            "entry": "done",
            "nodes": [{"name": "done", "post_actions": [{"type": "end_conversation"}]}],
        }
    )
    principal = ServicePrincipal(
        user_id=actor, tenant_id=tenant, role="agent", session_id=job, capability="voice:write"
    )
    command = SimulatedCallRequest(contact_id=contact, idempotency_key="frozen-flow-fixture")
    assert (await repository.simulate_call(principal, command, retained_flow=spec)).created
    assert not (await repository.simulate_call(principal, command, retained_flow=spec)).created
    with pytest.raises(SimulatedCallConflict, match="another flow version"):
        await repository.simulate_call(
            principal, command, retained_flow=spec.model_copy(update={"version": 2})
        )
    with pytest.raises(SimulatedCallConflict, match="another retained flow"):
        await repository.simulate_call(
            principal, command, retained_flow=spec.model_copy(update={"id": uuid4()})
        )


@pytest_asyncio.fixture
async def voice_jobs(isolated_postgres_url: str) -> AsyncIterator[tuple]:
    await run_alembic(isolated_postgres_url, "upgrade", "head")
    admin = await asyncpg.connect(isolated_postgres_url)
    engine = create_async_engine(
        isolated_postgres_url.replace("postgresql://", "postgresql+asyncpg://", 1),
        connect_args={"server_settings": {"role": "platform_voice"}},
    )
    repository = PostgresVoiceRepository(isolated_postgres_url, engine=engine)
    try:
        tenant, other, actor, contact = await _tenant_fixture(admin)
        await admin.execute(
            "UPDATE crm.contacts SET voice_consent = 'granted' WHERE id = $1", contact
        )
        channel = await admin.fetchval(
            """
            INSERT INTO messaging.channels(tenant_id, kind, provider, provider_account_id)
            VALUES ($1, 'whatsapp', 'simulator', 'fictional-voice-trigger') RETURNING id
        """,
            tenant,
        )
        conversation = await admin.fetchval(
            """
            INSERT INTO messaging.conversations(tenant_id, channel_id, contact_id)
            VALUES ($1, $2, $3) RETURNING id
        """,
            tenant,
            channel,
            contact,
        )
        payload = {
            "mode": "simulator",
            "contactId": str(contact),
            "conversationId": str(conversation),
            "actorUserId": str(actor),
        }
        job = await admin.fetchval(
            """
            INSERT INTO ops.jobs(tenant_id, queue, job_type, reference_id, payload, idempotency_key)
            VALUES ($1, 'voice', 'cross_channel.voice_call.simulated',
                    $2, $3::jsonb, 'fixture-call')
            RETURNING id
        """,
            tenant,
            contact,
            json.dumps(payload),
        )
        async with repository.simulation_transaction() as database:
            assert await database.scalar(text("SELECT current_user")) == "platform_voice"
        yield admin, repository, tenant, other, actor, contact, conversation, job, payload
    finally:
        await repository.close()
        await admin.close()


async def test_voice_job_atomic_concurrency_replay_and_timeline(voice_jobs: tuple) -> None:
    admin, repository, tenant, _, _, contact, _, job, _ = voice_jobs
    assert (
        sum(
            await asyncio.gather(
                *(consume_voice_simulation(repository, f"fixture-{index}") for index in range(4))
            )
        )
        == 1
    )
    assert await admin.fetchval("SELECT status FROM ops.jobs WHERE id=$1", job) == "succeeded"
    assert await admin.fetchval("SELECT count(*) FROM sessions WHERE contact_id=$1", contact) == 1
    assert (
        await admin.fetchval("SELECT count(*) FROM session_events WHERE tenant_id=$1", tenant) == 7
    )
    assert (
        await admin.fetchval("SELECT count(*) FROM ops.outbox_events WHERE tenant_id=$1", tenant)
        == 7
    )
    assert (
        await admin.fetchval(
            "SELECT count(*) FROM platform.contact_activity WHERE contact_id=$1", contact
        )
        >= 1
    )
    await admin.execute("UPDATE ops.jobs SET status='queued', attempts=0 WHERE id=$1", job)
    assert await consume_voice_simulation(repository, "replay")
    assert await admin.fetchval("SELECT count(*) FROM sessions WHERE contact_id=$1", contact) == 1
    assert (
        await admin.fetchval("SELECT count(*) FROM session_events WHERE tenant_id=$1", tenant) == 7
    )


@pytest.mark.parametrize(
    "case", ["consent", "blocked", "foreign", "mode", "actor", "missing_actor"]
)
async def test_voice_job_refuses_ineligible_work(voice_jobs: tuple, case: str) -> None:
    admin, repository, _, other, actor, contact, _, job, payload = voice_jobs
    if case == "consent":
        await admin.execute("UPDATE crm.contacts SET voice_consent='revoked' WHERE id=$1", contact)
    elif case == "blocked":
        await admin.execute(
            "UPDATE crm.contacts SET lifecycle_status='blocked' WHERE id=$1", contact
        )
    elif case == "foreign":
        await admin.execute("UPDATE ops.jobs SET tenant_id=$1 WHERE id=$2", other, job)
    elif case == "actor":
        await admin.execute("UPDATE users SET status='disabled' WHERE id=$1", actor)
    else:
        if case == "mode":
            payload["mode"] = "real"
        else:
            del payload["actorUserId"]
        await admin.execute(
            "UPDATE ops.jobs SET payload=$1::jsonb WHERE id=$2", json.dumps(payload), job
        )
    assert await consume_voice_simulation(repository, "denied")
    assert await admin.fetchval("SELECT status FROM ops.jobs WHERE id=$1", job) == "dead"
    assert await admin.fetchval("SELECT count(*) FROM sessions") == 0


async def test_voice_job_rollback_retry_and_exhaustion(
    voice_jobs: tuple, monkeypatch: pytest.MonkeyPatch
) -> None:
    admin, repository, _, _, _, _, _, job, _ = voice_jobs
    original = repository.simulate_call

    async def fail_after_effects(*args, **kwargs):
        await original(*args, **kwargs)
        raise RuntimeError("sensitive text must never be persisted")

    monkeypatch.setattr(repository, "simulate_call", fail_after_effects)
    assert await consume_voice_simulation(repository, "retry")
    assert await admin.fetchval("SELECT status FROM ops.jobs WHERE id=$1", job) == "retry"
    assert await admin.fetchval("SELECT available_at > now() FROM ops.jobs WHERE id=$1", job)
    assert await admin.fetchval("SELECT count(*) FROM sessions") == 0
    assert await admin.fetchval("SELECT count(*) FROM session_events") == 0
    assert await admin.fetchval("SELECT count(*) FROM audit.records") == 0
    await admin.execute(
        "UPDATE ops.jobs SET attempts=max_attempts-1, available_at=now() WHERE id=$1", job
    )
    assert await consume_voice_simulation(repository, "exhausted")
    assert await admin.fetchval("SELECT status FROM ops.jobs WHERE id=$1", job) == "dead"
    assert (
        await admin.fetchval("SELECT last_error_safe FROM ops.jobs WHERE id=$1", job)
        == "voice_simulation_retryable"
    )


async def test_voice_claim_is_narrow_and_recovers_expired_final_lease(voice_jobs: tuple) -> None:
    admin, repository, tenant, _, _, _, _, job, _ = voice_jobs
    other = await admin.fetchval(
        """
        INSERT INTO ops.jobs(tenant_id, queue, job_type, payload)
        VALUES ($1, 'messaging', 'protected', '{}') RETURNING id
    """,
        tenant,
    )
    await admin.execute(
        """
        UPDATE ops.jobs SET status='running', attempts=max_attempts, locked_by='crashed',
        locked_at=now()-interval '2 minutes' WHERE id=$1
    """,
        job,
    )
    assert await consume_voice_simulation(repository, "recovery")
    assert await admin.fetchval("SELECT status FROM ops.jobs WHERE id=$1", job) == "succeeded"
    async with repository.simulation_transaction() as database:
        await database.execute(
            text("SELECT set_config('app.current_tenant', :tenant, true)"), {"tenant": str(tenant)}
        )
        assert (
            await database.scalar(text("SELECT count(*) FROM ops.jobs WHERE id=:id"), {"id": other})
            == 0
        )
        assert await database.scalar(
            text("SELECT has_schema_privilege(current_user, 'messaging', 'USAGE')")
        )
        assert await database.scalar(
            text("SELECT has_table_privilege(current_user, 'messaging.conversations', 'SELECT')")
        )
        for privilege in ("INSERT", "UPDATE", "DELETE"):
            assert not await database.scalar(
                text(
                    "SELECT has_table_privilege(current_user, "
                    "'messaging.conversations', :privilege)"
                ),
                {"privilege": privilege},
            )
        assert not await database.scalar(
            text("SELECT has_table_privilege(current_user, 'messaging.messages', 'SELECT')")
        )
        assert not await database.scalar(
            text(
                "SELECT has_function_privilege(current_user, "
                "'ops.claim_jobs_all_tenants(text,text,integer,integer)', 'EXECUTE')"
            )
        )
