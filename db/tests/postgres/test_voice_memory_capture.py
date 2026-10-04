"""Fresh voice proof, not caller-ID correlation, authorizes durable memory sources."""

# ruff: noqa: F811 -- imported fixture is explicitly requested below
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from db.tests.postgres.lead_capture_support import execute
from db.tests.postgres.test_voice_service_intake_runtime import service_runtime  # noqa: F401

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def enable_memory(connection, tenant):
    await connection.execute(text("RESET ROLE"))
    await execute(
        connection,
        "INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled) "
        "VALUES(:tenant,'session_memory',true) "
        "ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true",
        tenant=tenant,
    )
    await connection.execute(text("SET LOCAL ROLE platform_voice"))


async def test_verified_capture_is_idempotent_but_not_directly_readable(service_runtime):
    runtime, context, connection, _ = service_runtime
    await enable_memory(connection, context.tenant_id)
    await runtime.append_voice_memory_turn(context, 1, "Fictional caller statement")
    await runtime.append_voice_memory_turn(context, 1, "Fictional caller statement")
    with pytest.raises(DBAPIError):
        await runtime.append_voice_memory_turn(context, 1, "Different assertion")
    # Function-owned data never acquires a broad runtime-role SELECT grant.
    with pytest.raises(DBAPIError):
        async with connection.begin_nested():
            await connection.execute(text("SELECT text FROM agents.voice_memory_turns"))
    await connection.execute(text("RESET ROLE"))
    count = (
        await execute(
            connection,
            "SELECT count(*) FROM agents.voice_memory_turns WHERE session_id=:session",
            session=context.session_id,
        )
    ).scalar_one()
    assert count == 1


@pytest.mark.parametrize("service_runtime", [False], indirect=True)
async def test_unverified_caller_id_has_session_only_provenance(service_runtime):
    runtime, context, connection, _ = service_runtime
    await enable_memory(connection, context.tenant_id)
    await runtime.append_voice_memory_turn(context, 1, "This must not enter shared memory")
    await connection.execute(text("RESET ROLE"))
    count = (
        await execute(
            connection,
            "SELECT count(*) FROM agents.voice_memory_turns WHERE session_id=:session "
            "AND identity_verified=false AND verified_contact_id IS NULL",
            session=context.session_id,
        )
    ).scalar_one()
    assert count == 1


async def test_foreign_session_cannot_be_captured(service_runtime):
    runtime, context, connection, _ = service_runtime
    await enable_memory(connection, context.tenant_id)
    with pytest.raises(DBAPIError):
        async with connection.begin_nested():
            await execute(
                connection,
                "SELECT platform.append_voice_memory_turn(:session,1,'Forbidden')",
                session=uuid4(),
            )


async def test_verification_revocation_never_promotes_old_or_new_claims(service_runtime):
    runtime, context, connection, _ = service_runtime
    await enable_memory(connection, context.tenant_id)
    await runtime.append_voice_memory_turn(
        context, 1, "Identity verified; statement remains untrusted"
    )
    await connection.execute(text("RESET ROLE"))
    await execute(
        connection,
        "UPDATE automation.voice_identity_verifications SET state='identity_required',"
        "verified_at=NULL,context_unlocked_at=NULL WHERE tenant_id=:tenant AND session_id=:session",
        tenant=context.tenant_id,
        session=context.session_id,
    )
    await connection.execute(text("SET LOCAL ROLE platform_voice"))
    await runtime.append_voice_memory_turn(context, 2, "Unverified subsequent statement")
    await connection.execute(text("RESET ROLE"))
    rows = (
        await execute(
            connection,
            "SELECT ordinal,identity_verified,verified_contact_id FROM agents.voice_memory_turns "
            "WHERE session_id=:session ORDER BY ordinal",
            session=context.session_id,
        )
    ).all()
    assert rows[0] == (1, True, context.contact_id)
    assert rows[1] == (2, False, None)
