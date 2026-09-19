"""The lead capture migrations against a database that already holds data.

An empty-database rehearsal proves the DDL parses. It does not prove that a
tenant who has been running agents since before leads existed keeps the
behaviour they published: ``agents.agent_profile_versions`` is immutable once
published, so the new ``implicit_ticketing`` column has to arrive with a
default rather than a backfill, and the rows that predate capabilities have to
come out of the upgrade still opening tickets.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

import asyncpg
import pytest

from db.tests.postgres.conftest import run_alembic

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.migration]

BEFORE_LEADS = "b8d5e21f7a04"
LEAD_TABLES = ("leads", "lead_field_values", "lead_operations", "lead_interactions")
RUNTIME_ROLES = ("platform_messaging", "platform_voice", "platform_worker")


class _Fixture:
    """Identifiers of the rows seeded before the lead migrations run."""

    def __init__(self) -> None:
        self.tenant = uuid4()
        self.user = uuid4()
        self.contact = uuid4()
        self.channel = uuid4()
        self.conversation = uuid4()
        self.profile = uuid4()
        self.published = uuid4()
        self.draft = uuid4()
        self.ticket = uuid4()


async def _seed_pre_change_tenant(connection: asyncpg.Connection) -> _Fixture:
    """A tenant already running one published WhatsApp agent and one ticket."""

    ids = _Fixture()
    await connection.execute(
        "INSERT INTO tenants(id,name,slug,status) VALUES($1,$2,$3,'active')",
        ids.tenant,
        "Fictional pre-lead tenant",
        f"pre-lead-{ids.tenant}",
    )
    await connection.execute(
        "INSERT INTO users(id,email,status) VALUES($1,$2,'active')",
        ids.user,
        f"pre-lead-{ids.user}@example.invalid",
    )
    await connection.execute(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
        ids.tenant,
        ids.user,
    )
    await connection.execute("INSERT INTO crm.tenant_settings(tenant_id) VALUES($1)", ids.tenant)
    await connection.execute(
        "INSERT INTO crm.contacts(id,tenant_id,name) VALUES($1,$2,'Fictional customer')",
        ids.contact,
        ids.tenant,
    )
    await connection.execute(
        "INSERT INTO messaging.channels(id,tenant_id,kind,provider,status) "
        "VALUES($1,$2,'whatsapp','meta','active')",
        ids.channel,
        ids.tenant,
    )
    await connection.execute(
        "INSERT INTO agents.agent_profiles(id,tenant_id,name) VALUES($1,$2,$3)",
        ids.profile,
        ids.tenant,
        "Fictional support agent",
    )
    for version_id, version, published in ((ids.published, 1, True), (ids.draft, 2, False)):
        await connection.execute(
            """
            INSERT INTO agents.agent_profile_versions
              (id,tenant_id,agent_profile_id,version,system_prompt,locale,
               channel_capabilities,tool_permissions,validation_status,published_at)
            VALUES($1,$2,$3,$4,'Fictional support agent.','he',
                   ARRAY['whatsapp'],$5::jsonb,'valid',
                   CASE WHEN $6 THEN TIMESTAMPTZ '2026-01-02 03:04:05+00' END)
            """,
            version_id,
            ids.tenant,
            ids.profile,
            version,
            json.dumps(["knowledge.search"]),
            published,
        )
    await connection.execute(
        "INSERT INTO messaging.conversations"
        "(id,tenant_id,channel_id,contact_id,status,ai_agent_profile_version_id) "
        "VALUES($1,$2,$3,$4,'open',$5)",
        ids.conversation,
        ids.tenant,
        ids.channel,
        ids.contact,
        ids.published,
    )
    await connection.execute(
        "INSERT INTO support.tickets"
        "(id,tenant_id,reference,attachment_key,contact_id,subject,stage,"
        "source_conversation_id) "
        "VALUES($1,$2,$3,$4,$5,'Fictional open issue','ai_handling',$6)",
        ids.ticket,
        ids.tenant,
        f"T-{ids.ticket.hex[:8]}",
        f"conversation:{ids.conversation}",
        ids.contact,
        ids.conversation,
    )
    return ids


async def _seeded_state(connection: asyncpg.Connection, ids: _Fixture) -> dict[str, Any]:
    conversation = await connection.fetchrow(
        "SELECT status, ai_agent_profile_version_id FROM messaging.conversations WHERE id=$1",
        ids.conversation,
    )
    ticket = await connection.fetchrow(
        "SELECT status, stage, handling_mode, subject FROM support.tickets WHERE id=$1",
        ids.ticket,
    )
    versions = await connection.fetch(
        "SELECT id, published_at, tool_permissions, validation_status "
        "FROM agents.agent_profile_versions WHERE tenant_id=$1 ORDER BY version",
        ids.tenant,
    )
    return {
        "conversation": dict(conversation) if conversation else None,
        "ticket": dict(ticket) if ticket else None,
        "versions": [dict(row) for row in versions],
    }


async def test_upgrading_a_populated_database_preserves_what_the_tenant_published(
    isolated_postgres_url: str,
) -> None:
    await run_alembic(isolated_postgres_url, "upgrade", BEFORE_LEADS)
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        ids = await _seed_pre_change_tenant(connection)
        before = await _seeded_state(connection, ids)
    finally:
        await connection.close()

    await run_alembic(isolated_postgres_url, "upgrade", "head")

    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        assert await _seeded_state(connection, ids) == before

        # Every version that existed before capabilities were explicit keeps
        # opening tickets on escalation; the column arrived by default, so the
        # published row was never updated and the immutability trigger never
        # fired.
        existing = await connection.fetch(
            "SELECT version, implicit_ticketing FROM agents.agent_profile_versions "
            "WHERE tenant_id=$1 ORDER BY version",
            ids.tenant,
        )
        assert [(row["version"], row["implicit_ticketing"]) for row in existing] == [
            (1, True),
            (2, True),
        ]
        with pytest.raises(asyncpg.PostgresError) as refused:
            await connection.execute(
                "UPDATE agents.agent_profile_versions SET implicit_ticketing=false WHERE id=$1",
                ids.published,
            )
        assert refused.value.sqlstate == "55000"

        # A version authored after the upgrade gets nothing it was not granted.
        fresh = uuid4()
        await connection.execute(
            """
            INSERT INTO agents.agent_profile_versions
              (id,tenant_id,agent_profile_id,version,system_prompt,locale,
               channel_capabilities,tool_permissions,validation_status)
            VALUES($1,$2,$3,3,'Fictional lead agent.','he',ARRAY['whatsapp'],
                   '[]'::jsonb,'valid')
            """,
            fresh,
            ids.tenant,
            ids.profile,
        )
        assert (
            await connection.fetchval(
                "SELECT implicit_ticketing FROM agents.agent_profile_versions WHERE id=$1",
                fresh,
            )
            is False
        )

        # The upgrade grants no existing agent a lead capability, and adds no
        # lead rows to a tenant that never captured one.
        assert [row["tool_permissions"] for row in before["versions"]] == [
            json.dumps(["knowledge.search"])
        ] * 2
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM crm.leads WHERE tenant_id=$1", ids.tenant
            )
            == 0
        )
    finally:
        await connection.close()


async def test_the_lead_migrations_roll_back_and_forward_without_losing_data(
    isolated_postgres_url: str,
) -> None:
    await run_alembic(isolated_postgres_url, "upgrade", BEFORE_LEADS)
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        ids = await _seed_pre_change_tenant(connection)
        before = await _seeded_state(connection, ids)
    finally:
        await connection.close()

    await run_alembic(isolated_postgres_url, "upgrade", "head")
    await run_alembic(isolated_postgres_url, "downgrade", BEFORE_LEADS)

    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        # A rollback returns the schema to what the previous release expects…
        assert await _seeded_state(connection, ids) == before
        assert (
            await connection.fetchval(
                "SELECT to_regclass('crm.leads') IS NULL AND "
                "to_regclass('crm.lead_interactions') IS NULL"
            )
            is True
        )
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM information_schema.columns "
                "WHERE table_schema='agents' AND table_name='agent_profile_versions' "
                "AND column_name='implicit_ticketing'"
            )
            == 0
        )
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM pg_proc JOIN pg_namespace ns ON ns.oid=pronamespace "
                "WHERE ns.nspname='platform' AND proname LIKE 'lead\\_%'"
            )
            == 0
        )
    finally:
        await connection.close()

    await run_alembic(isolated_postgres_url, "upgrade", "head")

    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        # …and rolling forward again lands on the same behaviour as the first
        # upgrade, not on a half-applied schema.
        assert await _seeded_state(connection, ids) == before
        assert (
            await connection.fetchval(
                "SELECT bool_and(implicit_ticketing) FROM agents.agent_profile_versions "
                "WHERE tenant_id=$1",
                ids.tenant,
            )
            is True
        )
        assert await connection.fetchval("SELECT to_regclass('crm.lead_interactions')") is not None
    finally:
        await connection.close()


@pytest.mark.rls
async def test_the_upgraded_schema_leaves_no_direct_lead_write_path(
    pg: asyncpg.Connection,
) -> None:
    """The migration's security posture, asserted on the migrated database."""

    for schema, table in (("crm", name) for name in LEAD_TABLES):
        qualified = f"{schema}.{table}"
        for role in RUNTIME_ROLES:
            privileges = await pg.fetchrow(
                "SELECT has_table_privilege($1,$2,'SELECT') AS readable,"
                "       has_table_privilege($1,$2,'INSERT') AS insertable,"
                "       has_table_privilege($1,$2,'UPDATE') AS updatable,"
                "       has_table_privilege($1,$2,'DELETE') AS deletable",
                role,
                qualified,
            )
            assert privileges is not None
            assert privileges["readable"] is True, f"{role} must still read {qualified}"
            assert not privileges["insertable"], f"{role} may not insert into {qualified}"
            assert not privileges["updatable"], f"{role} may not update {qualified}"
            assert not privileges["deletable"], f"{role} may not delete {qualified}"
        secured = await pg.fetchrow(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
            "JOIN pg_namespace ns ON ns.oid=relnamespace "
            "WHERE ns.nspname=$1 AND relname=$2",
            schema,
            table,
        )
        assert secured is not None, f"{qualified} is missing"
        assert secured["relrowsecurity"] is True, f"{qualified} needs row level security"

    # The workspace triages a lead a human owns, but cannot open one behind the
    # functions' back, and holds no write grant on the append-only tables.
    assert await pg.fetchval("SELECT has_table_privilege('platform_web','crm.leads','UPDATE')")
    assert not await pg.fetchval("SELECT has_table_privilege('platform_web','crm.leads','INSERT')")
    for table in ("crm.lead_field_values", "crm.lead_operations"):
        assert not await pg.fetchval(
            "SELECT has_table_privilege('platform_web',$1,'INSERT')", table
        )
        assert not await pg.fetchval(
            "SELECT has_table_privilege('platform_web',$1,'UPDATE')", table
        )

    functions = {
        row["name"]: row
        for row in await pg.fetch(
            "SELECT proname AS name, prosecdef, proconfig FROM pg_proc "
            "JOIN pg_namespace ns ON ns.oid=pronamespace "
            "WHERE ns.nspname='platform' AND proname LIKE 'lead\\_%'"
        )
    }
    assert {
        "lead_ensure_for_interaction",
        "lead_save_fields",
        "lead_operator_save_fields",
        "lead_finalize",
        "lead_request_follow_up",
        "lead_capture_state",
        "lead_operation_receipt",
    } <= set(functions)
    for name, row in functions.items():
        assert row["prosecdef"] is True, f"platform.{name} must run as its definer"
        assert any(setting.startswith("search_path=") for setting in (row["proconfig"] or [])), (
            f"platform.{name} must pin its search path"
        )

    for role in (*RUNTIME_ROLES, "platform_web"):
        assert await pg.fetchval(
            "SELECT has_function_privilege($1,"
            "'platform.lead_operation_receipt(jsonb,text)','EXECUTE')",
            role,
        ), f"{role} must be able to reconcile an unknown commit"


async def test_the_tenant_running_calls_function_exposes_counts_only(
    pg: asyncpg.Connection,
) -> None:
    """The workspace reads how many calls are running, never their payloads."""

    assert not await pg.fetchval(
        "SELECT has_table_privilege('platform_web','public.session_events','SELECT')"
    )
    returns = await pg.fetchval(
        "SELECT pg_get_function_result(fn.oid) FROM pg_proc fn "
        "JOIN pg_namespace ns ON ns.oid=fn.pronamespace "
        "WHERE ns.nspname='platform' AND proname='current_tenant_running_agent_calls'"
    )
    assert returns == "TABLE(agent_profile_version_id uuid, running bigint)"
