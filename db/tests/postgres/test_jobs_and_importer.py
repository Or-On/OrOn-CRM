from __future__ import annotations

import asyncio
from pathlib import Path
from uuid import UUID, uuid4

import asyncpg
import pytest

from db.importers.openlive_legacy.models import PlannerConfig
from db.importers.openlive_legacy.planner import build_import_plan
from db.importers.openlive_legacy.postgres_writer import PostgresCanonicalWriter

pytestmark = [pytest.mark.postgres, pytest.mark.integration]
FIXTURES = Path(__file__).parents[2] / "importers" / "openlive_legacy" / "tests" / "fixtures"


async def _insert_tenant(connection: asyncpg.Connection, label: str) -> UUID:
    tenant_id = uuid4()
    await connection.execute(
        "INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)",
        tenant_id,
        label,
        f"phase2b-{tenant_id}",
    )
    return tenant_id


async def _claim(postgres_url: str, tenant_id: UUID, worker: str, limit: int) -> list[UUID]:
    connection = await asyncpg.connect(postgres_url)
    try:
        async with connection.transaction():
            await connection.execute("SET LOCAL ROLE platform_worker")
            await connection.execute(
                "SELECT set_config('app.current_tenant', $1, true)", str(tenant_id)
            )
            rows = await connection.fetch(
                "SELECT id FROM ops.claim_jobs($1, 'phase2b', $2, 60)", worker, limit
            )
            return [UUID(str(row["id"])) for row in rows]
    finally:
        await connection.close()


async def test_skip_locked_claims_do_not_double_claim_and_do_not_cross_tenants(
    postgres_url: str,
) -> None:
    admin = await asyncpg.connect(postgres_url)
    tenant_a = await _insert_tenant(admin, "Job tenant A")
    tenant_b = await _insert_tenant(admin, "Job tenant B")
    try:
        job_ids = {
            UUID(str(row["id"]))
            for row in await admin.fetch(
                "INSERT INTO ops.jobs (tenant_id, queue, job_type, payload) "
                "SELECT $1, 'phase2b', 'fixture', '{}'::jsonb FROM generate_series(1, 8) "
                "RETURNING id",
                tenant_a,
            )
        }
        await admin.execute(
            "INSERT INTO ops.jobs (tenant_id, queue, job_type, payload) "
            "VALUES ($1, 'phase2b', 'other-tenant', '{}'::jsonb)",
            tenant_b,
        )

        first, second = await asyncio.gather(
            _claim(postgres_url, tenant_a, "worker-a", 4),
            _claim(postgres_url, tenant_a, "worker-b", 4),
        )
        claimed = [*first, *second]
        assert set(claimed) == job_ids
        assert len(claimed) == len(set(claimed))
        assert await _claim(postgres_url, tenant_a, "worker-c", 10) == []
    finally:
        await admin.execute("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [tenant_a, tenant_b])
        await admin.close()


async def test_stale_lease_retry_backoff_and_terminal_failure(postgres_url: str) -> None:
    admin = await asyncpg.connect(postgres_url)
    tenant_id = await _insert_tenant(admin, "Retry tenant")
    try:
        job_id = await admin.fetchval(
            "INSERT INTO ops.jobs "
            "(tenant_id, queue, job_type, payload, status, attempts, max_attempts, "
            "locked_at, locked_by) "
            "VALUES ($1, 'phase2b', 'stale', '{}'::jsonb, 'running', 1, 3, "
            "CURRENT_TIMESTAMP - INTERVAL '10 minutes', 'dead-worker') RETURNING id",
            tenant_id,
        )
        assert await _claim(postgres_url, tenant_id, "recovery-worker", 1) == [job_id]

        connection = await asyncpg.connect(postgres_url)
        try:
            async with connection.transaction():
                await connection.execute("SET LOCAL ROLE platform_worker")
                await connection.execute(
                    "SELECT set_config('app.current_tenant', $1, true)", str(tenant_id)
                )
                retried = await connection.fetchrow(
                    "SELECT * FROM ops.fail_job($1, 'recovery-worker', 'safe fixture error', 2)",
                    job_id,
                )
                assert retried["status"] == "retry"
                delay = (retried["available_at"] - retried["updated_at"]).total_seconds()
                assert 4 <= delay <= 6
        finally:
            await connection.close()

        await admin.execute(
            "UPDATE ops.jobs SET status = 'running', attempts = max_attempts, "
            "locked_at = CURRENT_TIMESTAMP, locked_by = 'terminal-worker' WHERE id = $1",
            job_id,
        )
        connection = await asyncpg.connect(postgres_url)
        try:
            async with connection.transaction():
                await connection.execute("SET LOCAL ROLE platform_worker")
                await connection.execute(
                    "SELECT set_config('app.current_tenant', $1, true)", str(tenant_id)
                )
                terminal = await connection.fetchrow(
                    "SELECT * FROM ops.fail_job($1, 'terminal-worker', 'terminal fixture', 2)",
                    job_id,
                )
                assert terminal["status"] == "dead"
                assert terminal["completed_at"] is not None
        finally:
            await connection.close()
    finally:
        await admin.execute("DELETE FROM tenants WHERE id = $1", tenant_id)
        await admin.close()


async def test_openlive_importer_is_idempotent(postgres_url: str) -> None:
    admin = await asyncpg.connect(postgres_url)
    tenant_id = await _insert_tenant(admin, "Importer tenant")
    user_id = uuid4()
    await admin.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)", user_id, f"{user_id}@example.test"
    )
    await admin.execute(
        "INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')",
        user_id,
        tenant_id,
    )
    await admin.close()
    plan = build_import_plan(
        PlannerConfig(
            tenant_id=tenant_id,
            user_id=user_id,
            conversations_path=FIXTURES / "conversations.json",
            providers_path=FIXTURES / "providers.json",
            settings_path=FIXTURES / "settings.json",
            voice_profiles_path=FIXTURES / "voice-profiles.json",
        )
    )
    writer = PostgresCanonicalWriter(postgres_url)
    try:
        first = await writer.write_async(plan)
        second = await writer.write_async(plan)
        assert first.import_run_id == second.import_run_id
        assert first.imported_count == len(plan.records)
        assert second.skipped_count == len(plan.records)

        check = await asyncpg.connect(postgres_url)
        try:
            assert (
                await check.fetchval(
                    "SELECT count(*) FROM live.chats WHERE tenant_id = $1", tenant_id
                )
                == 1
            )
            assert (
                await check.fetchval(
                    "SELECT count(*) FROM live.messages WHERE tenant_id = $1", tenant_id
                )
                == 1
            )
        finally:
            await check.close()
    finally:
        cleanup = await asyncpg.connect(postgres_url)
        await cleanup.execute("DELETE FROM tenants WHERE id = $1", tenant_id)
        await cleanup.execute("DELETE FROM users WHERE id = $1", user_id)
        await cleanup.close()
