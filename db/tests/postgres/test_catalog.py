from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from typing import Any

import asyncpg
import pytest

from db.tests.postgres.conftest import run_alembic

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.migration]


async def test_postgresql_version_and_alembic_head(
    pg: asyncpg.Connection, schema_manifest: dict[str, Any]
) -> None:
    raw_server_version = await pg.fetchval("SHOW server_version_num")
    assert raw_server_version is not None
    server_version = int(raw_server_version)
    head = await pg.fetchval("SELECT version_num FROM alembic_version")

    assert server_version >= 180006
    assert head == schema_manifest["alembic_head"]


async def test_expected_schemas_tables_functions_and_extensions_exist(
    pg: asyncpg.Connection, schema_manifest: dict[str, Any]
) -> None:
    schemas = await pg.fetch(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[])",
        schema_manifest["expected_schemas"],
    )
    schema_names = {row["schema_name"] for row in schemas}
    assert schema_names == set(schema_manifest["expected_schemas"])

    expected_tables = schema_manifest["expected_tables"]
    assert isinstance(expected_tables, dict)
    rows = await pg.fetch(
        "SELECT schemaname, tablename FROM pg_tables WHERE schemaname = ANY($1::text[])",
        list(expected_tables),
    )
    actual_tables = {(row["schemaname"], row["tablename"]) for row in rows}
    for schema, tables in expected_tables.items():
        assert isinstance(schema, str)
        assert isinstance(tables, list)
        assert {(schema, table) for table in tables}.issubset(actual_tables)

    function_rows = await pg.fetch(
        "SELECT n.nspname || '.' || p.proname AS name "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
        "WHERE n.nspname = ANY($1::text[])",
        schema_manifest["expected_schemas"],
    )
    actual_functions = {row["name"] for row in function_rows}
    assert set(schema_manifest["expected_functions"]).issubset(actual_functions)

    actual_indexes = {
        row["indexname"]
        for row in await pg.fetch(
            "SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[])",
            schema_manifest["expected_indexes"],
        )
    }
    assert actual_indexes == set(schema_manifest["expected_indexes"])

    extensions = schema_manifest["extensions"]
    assert isinstance(extensions, dict)
    installed_extensions = {
        row["extname"] for row in await pg.fetch("SELECT extname FROM pg_extension")
    }
    assert set(extensions["required"]).issubset(installed_extensions)


async def test_runtime_roles_are_unprivileged_and_rls_catalog_is_forced(
    pg: asyncpg.Connection, schema_manifest: dict[str, Any]
) -> None:
    expected_roles = [
        *schema_manifest["runtime_roles"],
        *schema_manifest["legacy_runtime_roles"],
        schema_manifest["migration_role"],
    ]
    roles = await pg.fetch(
        "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls "
        "FROM pg_roles WHERE rolname = ANY($1::text[])",
        expected_roles,
    )
    assert {row["rolname"] for row in roles} == set(expected_roles)
    for role in roles:
        if role["rolname"] == schema_manifest["migration_role"]:
            continue
        assert not role["rolsuper"]
        assert not role["rolcreatedb"]
        assert not role["rolcreaterole"]
        assert not role["rolreplication"]
        assert not role["rolbypassrls"]

    rls_rows = await pg.fetch(
        "SELECT n.nspname || '.' || c.relname AS name, c.relrowsecurity, c.relforcerowsecurity "
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE c.relkind = 'r'"
    )
    rls = {row["name"]: row for row in rls_rows}
    for table in schema_manifest["tenant_rls_tables"]:
        assert rls[table]["relrowsecurity"]
        assert rls[table]["relforcerowsecurity"]


async def test_web_can_validate_retained_voice_flows_without_mutating_them(
    pg: asyncpg.Connection,
) -> None:
    privileges = await pg.fetchrow(
        """
        SELECT has_table_privilege('platform_web', 'public.flows', 'SELECT') AS can_read,
               has_table_privilege('platform_web', 'public.flows', 'INSERT') AS can_insert,
               has_table_privilege('platform_web', 'public.flows', 'UPDATE') AS can_update,
               has_table_privilege('platform_web', 'public.flows', 'DELETE') AS can_delete
        """
    )
    assert privileges is not None
    assert privileges["can_read"]
    assert not privileges["can_insert"]
    assert not privileges["can_update"]
    assert not privileges["can_delete"]


async def test_tenant_work_tables_have_least_privilege_runtime_grants(
    pg: asyncpg.Connection,
) -> None:
    rows = await pg.fetch(
        """
        SELECT role_name, table_name,
               has_table_privilege(role_name, table_name, 'SELECT') AS can_read,
               has_table_privilege(role_name, table_name, 'INSERT') AS can_insert,
               has_table_privilege(role_name, table_name, 'UPDATE') AS can_update,
               has_table_privilege(role_name, table_name, 'DELETE') AS can_delete
        FROM unnest(ARRAY[
          'platform_web', 'platform_readonly', 'platform_voice', 'platform_messaging'
        ]) AS roles(role_name)
        CROSS JOIN unnest(ARRAY[
          'finance.expenses', 'crm.tasks', 'crm.calendar_events'
        ]) AS tables(table_name)
        ORDER BY role_name, table_name
        """
    )

    assert len(rows) == 12
    for row in rows:
        if row["role_name"] == "platform_web":
            assert row["can_read"]
            assert row["can_insert"]
            assert row["can_update"]
            assert row["can_delete"]
        elif row["role_name"] == "platform_readonly":
            assert row["can_read"]
            assert not row["can_insert"]
            assert not row["can_update"]
            assert not row["can_delete"]
        elif row["role_name"] == "platform_messaging" and row["table_name"] == "crm.tasks":
            # The messaging worker may create a tenant-scoped handoff ticket,
            # but it cannot mutate or delete a ticket after admission.
            assert row["can_read"]
            assert row["can_insert"]
            assert not row["can_update"]
            assert not row["can_delete"]
        else:
            assert not row["can_read"]
            assert not row["can_insert"]
            assert not row["can_update"]
            assert not row["can_delete"]


async def test_target_policies_have_no_supabase_auth_dependency(pg: asyncpg.Connection) -> None:
    policy_sql = "\n".join(
        str(row["definition"])
        for row in await pg.fetch(
            "SELECT pg_get_expr(polqual, polrelid) || ' ' || "
            "pg_get_expr(polwithcheck, polrelid) AS definition FROM pg_policy"
        )
    ).lower()
    dependencies = await pg.fetchval(
        """
        SELECT count(*) FROM pg_depend d
        JOIN pg_class c ON c.oid = d.refobjid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'auth' AND c.relname = 'users'
        """
    )

    assert "auth.uid" not in policy_sql
    assert "auth.users" not in policy_sql
    assert dependencies == 0


async def test_security_definer_functions_pin_search_path_and_public_has_no_execute(
    pg: asyncpg.Connection,
) -> None:
    rows = await pg.fetch(
        """
        SELECT n.nspname || '.' || p.proname AS name, p.proconfig,
               EXISTS (
                 SELECT 1
                 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                 WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
               ) AS public_execute
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prosecdef AND n.nspname IN ('ops', 'automation', 'messaging', 'platform')
        """
    )

    assert rows
    for row in rows:
        assert any(value.startswith("search_path=") for value in (row["proconfig"] or []))
        assert not row["public_execute"]


async def test_whatsapp_ai_defaults_archival_and_notification_grants(
    pg: asyncpg.Connection,
) -> None:
    columns = {
        (row["table_schema"], row["table_name"], row["column_name"])
        for row in await pg.fetch(
            """
            SELECT table_schema, table_name, column_name
            FROM information_schema.columns
            WHERE (table_schema, table_name) IN (
              ('agents', 'agent_profiles'),
              ('automation', 'flow_definitions'),
              ('crm', 'tenant_settings')
            )
            """
        )
    }
    assert ("agents", "agent_profiles", "archived_at") in columns
    assert ("automation", "flow_definitions", "archived_at") in columns
    assert (
        "crm",
        "tenant_settings",
        "whatsapp_ai_agent_profile_id",
    ) in columns
    assert (
        "crm",
        "tenant_settings",
        "whatsapp_ai_enabled_by_user_id",
    ) in columns
    assert ("crm", "tenant_settings", "whatsapp_ai_enabled_at") in columns

    privileges = await pg.fetchrow(
        """
        SELECT
          has_function_privilege(
            'platform_messaging',
            'platform.current_tenant_notification_recipients()',
            'EXECUTE'
          ) AS can_resolve_recipients,
          has_column_privilege(
            'platform_messaging', 'crm.tenant_settings', 'tenant_id', 'SELECT'
          ) AS can_read_tenant,
          has_column_privilege(
            'platform_messaging', 'crm.tenant_settings',
            'whatsapp_ai_agent_profile_id', 'SELECT'
          ) AS can_read_agent,
          has_column_privilege(
            'platform_messaging', 'crm.tenant_settings',
            'whatsapp_ai_enabled_by_user_id', 'SELECT'
          ) AS can_read_actor,
          has_column_privilege(
            'platform_messaging', 'crm.tenant_settings', 'display_name', 'SELECT'
          ) AS can_read_display_name
        """
    )
    assert privileges is not None
    assert privileges["can_resolve_recipients"]
    assert privileges["can_read_tenant"]
    assert privileges["can_read_agent"]
    assert privileges["can_read_actor"]
    assert not privileges["can_read_display_name"]


async def test_all_unified_foreign_keys_declare_delete_semantics(pg: asyncpg.Connection) -> None:
    rows = await pg.fetch(
        """
        SELECT n.nspname || '.' || c.relname AS table_name, con.conname,
               con.confdeltype::text AS confdeltype
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype = 'f'
          AND n.nspname = ANY($1::text[])
        """,
        [
            "platform",
            "crm",
            "messaging",
            "automation",
            "agents",
            "objects",
            "ops",
            "audit",
            "live",
            "finance",
        ],
    )

    assert rows
    assert all(row["confdeltype"] in {"c", "n", "r"} for row in rows)
    assert {row["confdeltype"] for row in rows} == {"c", "n", "r"}


async def test_development_seed_is_idempotent(isolated_postgres_url: str) -> None:
    # Seed updates credentials: never run it against the developer's shared DB.
    await run_alembic(isolated_postgres_url, "upgrade", "head")
    environment = dict(os.environ)
    environment["DATABASE_URL"] = isolated_postgres_url
    environment["DEV_AUTH_EMAIL"] = "operator@or-on.local"
    environment["DEV_AUTH_PASSWORD_HASH"] = (
        "$argon2id$v=19$m=65536,t=3,p=1$cGhhc2UtdGhyZWUtdGVzdA$bm90LXVzZWQtZm9yLXZlcmlmaWNhdGlvbg"
    )

    def run_seed() -> None:
        subprocess.run(  # noqa: S603
            [sys.executable, "db/seeds/seed_development.py"],
            env=environment,
            check=True,
            capture_output=True,
            text=True,
        )

    await asyncio.to_thread(run_seed)
    await asyncio.to_thread(run_seed)
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        row = await connection.fetchrow(
            "SELECT value FROM platform.system_metadata WHERE key = 'foundation_version'"
        )
        assert row is not None
        assert json.loads(row["value"]) == "phase-7"
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM users WHERE email = 'operator@or-on.local'"
            )
            == 1
        )
    finally:
        await connection.close()
