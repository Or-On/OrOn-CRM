from pathlib import Path

import scripts.dev
from scripts.dev import _supported_compose_version


def test_compose_v2_and_later_are_supported() -> None:
    assert not _supported_compose_version((1, 29, 2))
    assert _supported_compose_version((2, 0, 0))
    assert _supported_compose_version((5, 5, 0))


def test_local_environment_overrides_unrelated_ambient_database_url(monkeypatch) -> None:
    environment_file = Path(__file__).with_name("fixtures") / "dev-local.env"
    monkeypatch.setattr(scripts.dev, "ENV_FILE", environment_file)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://example.invalid:5432/external",
    )

    loaded = scripts.dev._load_environment()

    assert loaded["DATABASE_URL"] == ("postgresql://127.0.0.1:5433/platform")
