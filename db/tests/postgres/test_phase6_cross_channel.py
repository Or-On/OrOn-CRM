from __future__ import annotations

import asyncio
from uuid import UUID, uuid4

import asyncpg
import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration]


async def _tenant_fixture(
    connection: asyncpg.Connection,
) -> tuple[UUID, UUID, UUID, UUID]:
    tenant_id = uuid4()
    other_tenant_id = uuid4()
    user_id = uuid4()
    contact_id = uuid4()
    await connection.execute(
        "INSERT INTO tenants (id, name, slug) VALUES "
        "($1, 'Phase 6 tenant', $2), ($3, 'Phase 6 other', $4)",
        tenant_id,
        f"phase6-{tenant_id}",
        other_tenant_id,
        f"phase6-{other_tenant_id}",
    )
    await connection.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)",
        user_id,
        f"phase6-{user_id}@example.test",
    )
    await connection.execute(
        "INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')",
        user_id,
        tenant_id,
    )
    await connection.execute(
        "INSERT INTO crm.contacts (id, tenant_id, name) VALUES ($1, $2, 'Phase 6 Contact')",
        contact_id,
        tenant_id,
    )
    return tenant_id, other_tenant_id, user_id, contact_id


async def test_agent_versions_are_scoped_validated_and_immutable(
    postgres_url: str,
) -> None:
    admin = await asyncpg.connect(postgres_url)
    transaction = admin.transaction()
    await transaction.start()
    try:
        tenant_id, other_tenant_id, user_id, _ = await _tenant_fixture(admin)
        await admin.execute("SET LOCAL ROLE platform_web")
        await admin.execute("SELECT set_config('app.current_tenant', $1, true)", str(tenant_id))
        profile_id = await admin.fetchval(
            "INSERT INTO agents.agent_profiles "
            "(tenant_id, name, created_by_user_id) "
            "VALUES ($1, 'Cross-channel agent', $2) RETURNING id",
            tenant_id,
            user_id,
        )
        version_id = await admin.fetchval(
            "INSERT INTO agents.agent_profile_versions "
            "(tenant_id, agent_profile_id, version, system_prompt, "
            "channel_capabilities, validation_status, published_at, "
            "created_by_user_id) "
            "VALUES ($1, $2, 1, 'Serve the fictional customer safely.', "
            "ARRAY['voice','whatsapp'], 'valid', CURRENT_TIMESTAMP, $3) "
            "RETURNING id",
            tenant_id,
            profile_id,
            user_id,
        )
        assert await admin.fetchval("SELECT count(*) FROM agents.agent_profile_versions") == 1
        await admin.execute(
            "SELECT set_config('app.current_tenant', $1, true)",
            str(other_tenant_id),
        )
        assert await admin.fetchval("SELECT count(*) FROM agents.agent_profile_versions") == 0
        await admin.execute("SELECT set_config('app.current_tenant', $1, true)", str(tenant_id))

        with pytest.raises(asyncpg.CheckViolationError):
            async with admin.transaction():
                await admin.execute(
                    "INSERT INTO agents.agent_profile_versions "
                    "(tenant_id, agent_profile_id, version, system_prompt, "
                    "channel_capabilities) VALUES ($1, $2, 2, 'Invalid channel', "
                    "ARRAY['openlive'])",
                    tenant_id,
                    profile_id,
                )
        with pytest.raises(asyncpg.ObjectNotInPrerequisiteStateError):
            async with admin.transaction():
                await admin.execute(
                    "UPDATE agents.agent_profile_versions SET locale = 'he' WHERE id = $1",
                    version_id,
                )
    finally:
        await transaction.rollback()
        await admin.close()


async def test_cross_channel_run_handoff_and_activity_are_idempotent(
    postgres_url: str,
) -> None:
    admin = await asyncpg.connect(postgres_url)
    transaction = admin.transaction()
    await transaction.start()
    try:
        tenant_id, other_tenant_id, user_id, contact_id = await _tenant_fixture(admin)
        await admin.execute("SET LOCAL ROLE platform_web")
        await admin.execute("SELECT set_config('app.current_tenant', $1, true)", str(tenant_id))
        profile_id = await admin.fetchval(
            "INSERT INTO agents.agent_profiles (tenant_id, name, created_by_user_id) "
            "VALUES ($1, 'Workflow agent', $2) RETURNING id",
            tenant_id,
            user_id,
        )
        profile_version_id = await admin.fetchval(
            "INSERT INTO agents.agent_profile_versions "
            "(tenant_id, agent_profile_id, version, system_prompt, "
            "channel_capabilities, validation_status, published_at) "
            "VALUES ($1, $2, 1, 'Use approved channels.', "
            "ARRAY['voice','whatsapp'], 'valid', CURRENT_TIMESTAMP) RETURNING id",
            tenant_id,
            profile_id,
        )
        definition_id = await admin.fetchval(
            "INSERT INTO automation.flow_definitions "
            "(tenant_id, name, channel_capabilities, created_by_user_id) "
            "VALUES ($1, 'Phase 6 cross-channel flow', "
            "ARRAY['voice','whatsapp'], $2) RETURNING id",
            tenant_id,
            user_id,
        )
        version_id = await admin.fetchval(
            "INSERT INTO automation.flow_versions "
            "(tenant_id, flow_definition_id, version, schema_version, definition, "
            "validation_status, published_at, agent_profile_version_id, "
            "compiled_adapters) VALUES ($1, $2, 1, '1.0', $3::jsonb, 'valid', "
            "CURRENT_TIMESTAMP, $4, $5::jsonb) RETURNING id",
            tenant_id,
            definition_id,
            '{"nodes":[{"id":"start","type":"start"}],"edges":[]}',
            profile_version_id,
            '{"voice":{"schemaVersion":"oron-flow.v1"},'
            '"whatsapp":{"schemaVersion":"wacrm-automation.v1"}}',
        )
        run_id = await admin.fetchval(
            "INSERT INTO automation.flow_runs "
            "(tenant_id, flow_version_id, contact_id, trigger_type, status, "
            "idempotency_key) VALUES ($1, $2, $3, 'test', 'handed_off', $4) "
            "RETURNING id",
            tenant_id,
            version_id,
            contact_id,
            f"phase6-run-{tenant_id}",
        )
        with pytest.raises(asyncpg.UniqueViolationError):
            async with admin.transaction():
                await admin.execute(
                    "INSERT INTO automation.flow_runs "
                    "(tenant_id, flow_version_id, contact_id, trigger_type, "
                    "idempotency_key) VALUES ($1, $2, $3, 'test', $4)",
                    tenant_id,
                    version_id,
                    contact_id,
                    f"phase6-run-{tenant_id}",
                )
        handoff_id = await admin.fetchval(
            "INSERT INTO automation.handoffs "
            "(tenant_id, contact_id, flow_run_id, source_channel, reason_safe, "
            "idempotency_key) VALUES ($1, $2, $3, 'voice', "
            "'Customer requested a person', $4) RETURNING id",
            tenant_id,
            contact_id,
            run_id,
            f"phase6-handoff-{tenant_id}",
        )
        activity = await admin.fetchrow(
            "SELECT source_type, event_type, metadata "
            "FROM platform.contact_activity WHERE event_id = $1",
            handoff_id,
        )
        assert activity is not None
        assert activity["source_type"] == "handoff"
        assert activity["event_type"] == "handoff.pending"
        assert "reason_safe" not in activity["metadata"]

        await admin.execute(
            "SELECT set_config('app.current_tenant', $1, true)",
            str(other_tenant_id),
        )
        assert (
            await admin.fetchval(
                "SELECT count(*) FROM platform.contact_activity WHERE event_id = $1",
                handoff_id,
            )
            == 0
        )
    finally:
        await transaction.rollback()
        await admin.close()


async def test_handoff_accept_is_race_safe(postgres_url: str) -> None:
    admin = await asyncpg.connect(postgres_url)
    tenant_id = uuid4()
    user_ids = [uuid4(), uuid4()]
    contact_id = uuid4()
    handoff_id = uuid4()
    try:
        await admin.execute(
            "INSERT INTO tenants (id, name, slug) VALUES ($1, 'Handoff race', $2)",
            tenant_id,
            f"phase6-race-{tenant_id}",
        )
        await admin.executemany(
            "INSERT INTO users (id, email) VALUES ($1, $2)",
            [(user_id, f"phase6-race-{user_id}@example.test") for user_id in user_ids],
        )
        await admin.executemany(
            "INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'agent')",
            [(user_id, tenant_id) for user_id in user_ids],
        )
        await admin.execute(
            "INSERT INTO crm.contacts (id, tenant_id, name) VALUES ($1, $2, 'Race contact')",
            contact_id,
            tenant_id,
        )
        await admin.execute(
            "INSERT INTO automation.handoffs "
            "(id, tenant_id, contact_id, source_channel, reason_safe, idempotency_key) "
            "VALUES ($1, $2, $3, 'whatsapp', 'Race-safe assignment', $4)",
            handoff_id,
            tenant_id,
            contact_id,
            f"phase6-race-{handoff_id}",
        )

        async def accept(user_id: UUID) -> UUID | None:
            connection = await asyncpg.connect(postgres_url)
            try:
                async with connection.transaction():
                    await connection.execute("SET LOCAL ROLE platform_web")
                    await connection.execute(
                        "SELECT set_config('app.current_tenant', $1, true)", str(tenant_id)
                    )
                    return await connection.fetchval(
                        "UPDATE automation.handoffs SET status = 'accepted', "
                        "assigned_user_id = $2, accepted_at = CURRENT_TIMESTAMP "
                        "WHERE id = $1 AND status = 'pending' RETURNING assigned_user_id",
                        handoff_id,
                        user_id,
                    )
            finally:
                await connection.close()

        results = await asyncio.gather(*(accept(user_id) for user_id in user_ids))
        assert len([result for result in results if result is not None]) == 1
        assert (
            await admin.fetchval(
                "SELECT assigned_user_id FROM automation.handoffs WHERE id = $1", handoff_id
            )
            in user_ids
        )
    finally:
        await admin.execute("DELETE FROM tenants WHERE id = $1", tenant_id)
        await admin.execute("DELETE FROM users WHERE id = ANY($1::uuid[])", user_ids)
        await admin.close()
