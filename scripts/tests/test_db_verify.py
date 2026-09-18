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
    # Bumped by exactly one per deliberate migration; 88 adds tenant modules,
    # templates and explicit process bindings (f4c8a2d91e70). An unexplained
    # change here means a migration arrived that nobody reviewed.
    assert report.revision_count == 88


def test_rendered_postgresql_contract_passes_static_security_checks() -> None:
    validate_contract(render_offline_sql())


def test_final_fresh_authorization_definition_accepts_canonical_technicians() -> None:
    sql = render_offline_sql()
    marker = "CREATE OR REPLACE FUNCTION platform.lock_current_authorization("
    final_definition = sql.rsplit(marker, maxsplit=1)[1].split(
        "REVOKE ALL ON FUNCTION", maxsplit=1
    )[0]

    assert "('owner','admin','agent','viewer','technician')" in final_definition


def test_report_tenant_name_boundary_does_not_grant_private_table_access() -> None:
    sql = render_offline_sql()

    assert "CREATE FUNCTION platform.current_tenant_name()" in sql
    assert "GRANT EXECUTE ON FUNCTION platform.current_tenant_name() TO platform_web" in sql
    assert "GRANT SELECT ON public.tenants TO platform_web" not in sql


def test_whatsapp_binding_migration_quarantines_work_in_both_directions() -> None:
    migration = (
        MANIFEST_PATH.parent.parent
        / "alembic"
        / "versions"
        / "8d3a9f0c2b71_bind_whatsapp_sender_and_callback.py"
    ).read_text(encoding="utf-8")
    upgrade, downgrade = migration.split("def downgrade() -> None:", maxsplit=1)

    upgrade_quarantine = upgrade.index("whatsapp.outbound.legacy_quarantined")
    upgrade_terminalize = upgrade.index("last_error_code='legacy_recipient_binding_unavailable'")
    terminal_audit_backfill = upgrade.index("SET recipient_address=identity.normalized_value")
    assert upgrade_quarantine < upgrade_terminalize < terminal_audit_backfill
    assert "request.status IN ('sent', 'delivered', 'read', 'failed')" in upgrade
    assert "conversation.callback.legacy_quarantined" in upgrade

    outbound_downgrade = downgrade.index("whatsapp.outbound.downgrade_quarantined")
    callback_downgrade = downgrade.index("conversation.callback.downgrade_quarantined")
    downgrade_lock = downgrade.index("LOCK TABLE messaging.outbound_requests")
    protections_removed = downgrade.index(
        "DROP TRIGGER trg_protect_whatsapp_callback_authorization"
    )
    assert downgrade_lock < outbound_downgrade < callback_downgrade < protections_removed
    assert "messaging.inbound_message_origins" in downgrade[downgrade_lock:outbound_downgrade]
    assert downgrade.index("messaging.outbound_requests", downgrade_lock) < downgrade.index(
        "messaging.messages", downgrade_lock
    )
    assert "messaging.outbound_requests" in downgrade[downgrade_lock:outbound_downgrade]
    assert "ops.jobs" in downgrade[downgrade_lock:outbound_downgrade]
    assert "IN ACCESS EXCLUSIVE MODE" in downgrade[downgrade_lock:outbound_downgrade]
    assert "recipient_binding_removed_by_downgrade" in downgrade
    assert "callback binding removed by downgrade" in downgrade
    assert "status IN ('succeeded', 'dead', 'cancelled')" in upgrade
    assert "GRANT SELECT ON messaging.inbound_message_origins TO platform_web" in migration
    assert "REVOKE SELECT ON messaging.inbound_message_origins FROM platform_web" in migration


def test_active_whatsapp_outbound_requires_a_recipient_snapshot() -> None:
    migration = (
        MANIFEST_PATH.parent.parent
        / "alembic"
        / "versions"
        / "9b7e4c2d1a60_require_active_outbound_recipient.py"
    ).read_text(encoding="utf-8")
    upgrade, downgrade = migration.split("def downgrade() -> None:", maxsplit=1)

    assert "recipient_address IS NOT NULL" in upgrade
    assert "AND recipient_address ~" in upgrade
    assert "whatsapp.outbound.missing_binding_quarantined" in upgrade
    assert "request.status IN ('queued', 'sending')" in upgrade
    assert "VALIDATE CONSTRAINT ck_outbound_request_recipient_e164" in upgrade
    assert "recipient_address IS NOT NULL" not in downgrade


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
