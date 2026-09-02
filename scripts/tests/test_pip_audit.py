from datetime import date

import pytest

from scripts.pip_audit import active_exceptions


def test_security_exception_is_explicit_and_expires() -> None:
    assert active_exceptions(date(2026, 9, 9)) == ("PYSEC-2026-3740",)
    with pytest.raises(RuntimeError, match="expired"):
        active_exceptions(date(2026, 9, 10))
