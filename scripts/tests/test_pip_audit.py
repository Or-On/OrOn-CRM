from datetime import date
from pathlib import Path

import pytest

from scripts.pip_audit import active_exceptions


def test_security_exception_is_explicit_and_expires() -> None:
    assert active_exceptions(date(2026, 10, 13)) == ("PYSEC-2026-3740",)
    with pytest.raises(RuntimeError, match="expired"):
        active_exceptions(date(2026, 10, 14))


def test_voice_runtime_image_removes_the_unused_vulnerable_dependency() -> None:
    dockerfile = (
        Path(__file__).resolve().parents[2] / "infra/images/dispatcher.Dockerfile"
    ).read_text(encoding="utf-8")
    assert "uv pip uninstall nltk" in dockerfile
