import json
from unittest.mock import AsyncMock

from oron_agent.quality_persistence import persist_quality_summary, stage_quality_snapshot


async def test_quality_success_does_not_create_failure_alert():
    write, alert = AsyncMock(), AsyncMock()
    assert await persist_quality_summary(write, alert)
    write.assert_awaited_once()
    alert.assert_not_awaited()


async def test_quality_failure_creates_one_static_alert_without_claiming_success():
    write, alert = AsyncMock(side_effect=ValueError("private session details")), AsyncMock()
    assert not await persist_quality_summary(write, alert)
    alert.assert_awaited_once_with()


async def test_missing_binding_alert_failure_remains_failure():
    write = AsyncMock(side_effect=ValueError("missing"))
    alert = AsyncMock(side_effect=PermissionError("unbound"))
    assert not await persist_quality_summary(write, alert)


def test_bounded_quality_artifact_is_staged_for_wholesale_upload(tmp_path):
    (tmp_path / "diagnostics").mkdir()
    metrics = {"schema_version": "1.1", "total_turns": 1, "turns": [], "summary_ms": {}}
    stage_quality_snapshot(tmp_path, metrics)
    assert json.loads((tmp_path / "diagnostics/voice-quality.json").read_text()) == metrics


def test_oversized_quality_does_not_replace_prior_recovery_artifact(tmp_path):
    import pytest

    (tmp_path / "diagnostics").mkdir()
    stage_quality_snapshot(tmp_path, {"total_turns": 1})
    with pytest.raises(ValueError):
        stage_quality_snapshot(tmp_path, {"turns": [0] * 262144})
    assert json.loads((tmp_path / "diagnostics/voice-quality.json").read_text()) == {
        "total_turns": 1
    }
