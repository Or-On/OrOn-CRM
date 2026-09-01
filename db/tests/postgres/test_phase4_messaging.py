from __future__ import annotations

import asyncio
import json
from uuid import UUID, uuid4

import asyncpg
import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration]


async def _claim_inbound(postgres_url: str, worker_id: str) -> list[asyncpg.Record]:
    connection = await asyncpg.connect(postgres_url)
    try:
        async with connection.transaction():
            await connection.execute("SET LOCAL ROLE platform_messaging")
            return await connection.fetch(
                "SELECT id, tenant_id FROM ops.claim_inbound_events($1, 10, 60)",
                worker_id,
            )
    finally:
        await connection.close()


async def test_verified_webhook_store_is_idempotent_and_claimed_once(
    postgres_url: str,
) -> None:
    admin = await asyncpg.connect(postgres_url)
    tenant_id = uuid4()
    account_id = f"phase4-account-{uuid4()}"
    event_id = f"phase4-event-{uuid4()}"
    try:
        await admin.execute(
            "INSERT INTO tenants (id, name, slug) VALUES ($1, 'Phase 4 webhook', $2)",
            tenant_id,
            f"phase4-webhook-{tenant_id}",
        )
        await admin.execute(
            "INSERT INTO messaging.channels "
            "(tenant_id, kind, provider, provider_account_id, status, configuration) "
            "VALUES ($1, 'whatsapp', 'meta', $2, 'active', '{}'::jsonb)",
            tenant_id,
            account_id,
        )
        payload = {
            "providerAccountId": account_id,
            "providerEventId": event_id,
            "providerMessageId": f"phase4-message-{uuid4()}",
            "from": "+972509999989",
            "profileName": "Fictional Webhook Contact",
            "text": "Fictional webhook fixture",
        }
        async with admin.transaction():
            await admin.execute("SET LOCAL ROLE platform_web")
            first = await admin.fetchval(
                "SELECT (ops.accept_whatsapp_inbound($1, $2, "
                "'whatsapp.message.text', $3::jsonb)).id",
                account_id,
                event_id,
                json.dumps(payload),
            )
            second = await admin.fetchval(
                "SELECT (ops.accept_whatsapp_inbound($1, $2, "
                "'whatsapp.message.text', $3::jsonb)).id",
                account_id,
                event_id,
                json.dumps(payload),
            )
            assert first == second

        first_claim, second_claim = await asyncio.gather(
            _claim_inbound(postgres_url, "phase4-worker-a"),
            _claim_inbound(postgres_url, "phase4-worker-b"),
        )
        claimed = [
            *(("phase4-worker-a", row) for row in first_claim),
            *(("phase4-worker-b", row) for row in second_claim),
        ]
        matching = [
            (worker, row) for worker, row in claimed if UUID(str(row["tenant_id"])) == tenant_id
        ]
        assert len(matching) == 1
        claimed_worker, claimed_row = matching[0]
        claimed_id = UUID(str(claimed_row["id"]))
        completed = await admin.fetchrow(
            "SELECT * FROM ops.complete_inbound_event($1, $2)",
            claimed_id,
            claimed_worker,
        )
        assert completed is not None
        assert completed["status"] == "processed"
    finally:
        await admin.execute("DELETE FROM tenants WHERE id = $1", tenant_id)
        await admin.close()


async def test_cross_tenant_messaging_job_claim_is_lease_safe(postgres_url: str) -> None:
    admin = await asyncpg.connect(postgres_url)
    tenant_ids = [uuid4(), uuid4()]
    try:
        for tenant_id in tenant_ids:
            await admin.execute(
                "INSERT INTO tenants (id, name, slug) VALUES ($1, 'Phase 4 job', $2)",
                tenant_id,
                f"phase4-job-{tenant_id}",
            )
            await admin.execute(
                "INSERT INTO ops.jobs "
                "(tenant_id, queue, job_type, payload, idempotency_key) "
                "VALUES ($1, 'messaging', 'fixture', '{}'::jsonb, $2)",
                tenant_id,
                f"phase4-{tenant_id}",
            )

        async def claim(worker: str) -> list[asyncpg.Record]:
            connection = await asyncpg.connect(postgres_url)
            try:
                async with connection.transaction():
                    await connection.execute("SET LOCAL ROLE platform_messaging")
                    return await connection.fetch(
                        "SELECT id, tenant_id FROM "
                        "ops.claim_jobs_all_tenants($1, 'messaging', 1, 60)",
                        worker,
                    )
            finally:
                await connection.close()

        first, second = await asyncio.gather(claim("phase4-job-a"), claim("phase4-job-b"))
        claimed = [*first, *second]
        assert len(claimed) == 2
        assert {UUID(str(row["tenant_id"])) for row in claimed} == set(tenant_ids)
        assert len({UUID(str(row["id"])) for row in claimed}) == 2
    finally:
        await admin.execute("DELETE FROM tenants WHERE id = ANY($1::uuid[])", tenant_ids)
        await admin.close()


async def test_scoped_api_key_resolution_preserves_tenant_boundary(postgres_url: str) -> None:
    admin = await asyncpg.connect(postgres_url)
    tenant_id = uuid4()
    other_tenant_id = uuid4()
    user_id = uuid4()
    key_id = uuid4()
    digest = f"phase4-digest-{uuid4()}"
    try:
        await admin.execute(
            "INSERT INTO tenants (id, name, slug) VALUES "
            "($1, 'Phase 4 API', $2), ($3, 'Other API tenant', $4)",
            tenant_id,
            f"phase4-api-{tenant_id}",
            other_tenant_id,
            f"phase4-api-{other_tenant_id}",
        )
        await admin.execute(
            "INSERT INTO users (id, email) VALUES ($1, $2)",
            user_id,
            f"{user_id}@example.test",
        )
        await admin.execute(
            "INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')",
            user_id,
            tenant_id,
        )
        async with admin.transaction():
            await admin.execute("SET LOCAL ROLE platform_web")
            await admin.execute("SELECT set_config('app.current_tenant', $1, true)", str(tenant_id))
            await admin.execute(
                "INSERT INTO api_keys "
                "(id, hashed_key, tenant_id, name, prefix, scopes, created_by_user_id) "
                "VALUES ($1, $2, $3, 'Phase 4 fixture', 'oron_fixture', "
                "ARRAY['crm:read'], $4)",
                key_id,
                digest,
                tenant_id,
                user_id,
            )
            assert await admin.fetchval("SELECT count(*) FROM api_keys") == 1
            await admin.execute(
                "SELECT set_config('app.current_tenant', $1, true)", str(other_tenant_id)
            )
            assert await admin.fetchval("SELECT count(*) FROM api_keys") == 0

        async with admin.transaction():
            await admin.execute("SET LOCAL ROLE platform_web")
            resolved = await admin.fetchrow("SELECT * FROM platform.resolve_api_key($1)", digest)
            assert UUID(str(resolved["resolved_tenant_id"])) == tenant_id
            assert resolved["resolved_scopes"] == ["crm:read"]
    finally:
        await admin.execute("DELETE FROM api_keys WHERE id = $1", key_id)
        await admin.execute(
            "DELETE FROM tenants WHERE id = ANY($1::uuid[])", [tenant_id, other_tenant_id]
        )
        await admin.execute("DELETE FROM users WHERE id = $1", user_id)
        await admin.close()
