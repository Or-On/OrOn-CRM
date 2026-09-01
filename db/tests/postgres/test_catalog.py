from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from typing import Any

import asyncpg
import pytest

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


async def test_development_seed_is_idempotent(postgres_url: str) -> None:
    environment = dict(os.environ)
    environment["DATABASE_URL"] = postgres_url

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
    connection = await asyncpg.connect(postgres_url)
    try:
        count = await connection.fetchval(
            "SELECT count(*) FROM platform.system_metadata WHERE key = 'foundation_version'"
        )
        assert count == 1
    finally:
        await connection.close()
