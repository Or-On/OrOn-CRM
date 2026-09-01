from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID

import pytest

from db.importers.wacrm_legacy.planner import (
    WacrmDataError,
    build_import_plan,
    snapshot_from_path,
)

FIXTURE = Path(__file__).parent / "fixtures" / "wacrm-export.json"
ACCOUNT_ID = UUID("10000000-0000-0000-0000-000000000001")
SOURCE_USER_ID = UUID("20000000-0000-0000-0000-000000000002")
TENANT_ID = UUID("a0000000-0000-0000-0000-000000000001")
USER_ID = UUID("b0000000-0000-0000-0000-000000000002")


def _plan(path: Path = FIXTURE):
    return build_import_plan(
        snapshot_from_path(path),
        account_to_tenant={ACCOUNT_ID: TENANT_ID},
        source_user_to_canonical_user={SOURCE_USER_ID: USER_ID},
    )


def test_plan_is_deterministic_complete_and_content_safe() -> None:
    first = _plan()
    second = _plan()

    assert first == second
    assert first.entity_counts == {
        "channel": 1,
        "contact": 1,
        "conversation": 1,
        "deal": 1,
        "message": 1,
        "pipeline": 1,
        "pipeline_stage": 1,
    }
    assert [record.target_id for record in first.records] == [
        record.target_id for record in second.records
    ]
    safe = json.dumps(first.safe_summary(), sort_keys=True)
    assert "Fictional WACRM import message" not in safe
    assert "wacrm-contact@example.test" not in safe


def test_missing_account_mapping_fails_closed() -> None:
    with pytest.raises(WacrmDataError, match="explicit tenant mapping"):
        build_import_plan(
            snapshot_from_path(FIXTURE),
            account_to_tenant={},
            source_user_to_canonical_user={SOURCE_USER_ID: USER_ID},
        )


def test_snapshot_checksum_detects_source_change(tmp_path: Path) -> None:
    path = tmp_path / "export.json"
    path.write_bytes(FIXTURE.read_bytes())
    snapshot = snapshot_from_path(path)
    path.write_text('{"formatVersion":"wacrm-export-v1"}', encoding="utf-8")

    with pytest.raises(WacrmDataError, match="checksum changed"):
        build_import_plan(
            snapshot,
            account_to_tenant={ACCOUNT_ID: TENANT_ID},
            source_user_to_canonical_user={SOURCE_USER_ID: USER_ID},
        )
