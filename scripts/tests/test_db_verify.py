from __future__ import annotations

import json

import pytest

from scripts.db_verify import (
    MANIFEST_PATH,
    VerificationError,
    graph_report,
    render_offline_sql,
    validate_contract,
)


def test_graph_has_preserved_oron_root_and_one_target_head() -> None:
    report = graph_report()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    assert report.bases == ("0001",)
    assert report.heads == (manifest["alembic_head"],)
    assert report.branch_points == ("8eda5976c920",)
    assert report.revision_count == 71


def test_rendered_postgresql_contract_passes_static_security_checks() -> None:
    validate_contract(render_offline_sql())


def test_final_fresh_authorization_definition_accepts_canonical_technicians() -> None:
    sql = render_offline_sql()
    marker = "CREATE OR REPLACE FUNCTION platform.lock_current_authorization("
    final_definition = sql.rsplit(marker, maxsplit=1)[1].split(
        "REVOKE ALL ON FUNCTION", maxsplit=1
    )[0]

    assert "('owner','admin','agent','viewer','technician')" in final_definition


@pytest.mark.parametrize(
    "dangerous_sql",
    (
        "SELECT auth.uid();",
        "SELECT * FROM auth.users;",
        "ALTER PUBLICATION supabase_realtime ADD TABLE x;",
        "GRANT SELECT ON secret TO PUBLIC;",
        "ALTER ROLE platform_web BYPASSRLS;",
    ),
)
def test_contract_guard_rejects_dangerous_target_sql(dangerous_sql: str) -> None:
    with pytest.raises(VerificationError, match="prohibited SQL"):
        validate_contract(render_offline_sql() + dangerous_sql)


def test_contract_guard_rejects_python_comments_in_rendered_sql() -> None:
    with pytest.raises(VerificationError, match="Python-style comment"):
        validate_contract(render_offline_sql() + "\n# noqa: invalid PostgreSQL\n")
