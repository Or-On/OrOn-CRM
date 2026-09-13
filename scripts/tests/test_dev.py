from pathlib import Path

import pytest

import scripts.dev
from scripts.dev import (
    _ensure_local_voice_credentials,
    _ensure_real_voice_material,
    _require_provider_safety,
    _supported_compose_version,
)


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


def test_voice_up_generates_ignored_local_credentials_without_enabling_providers(
    monkeypatch, tmp_path: Path
) -> None:
    environment_file = tmp_path / ".env"
    environment_file.write_text(
        "LIVEKIT_API_KEY=\n"
        "LIVEKIT_API_SECRET=\n"
        "ENABLE_REAL_TELEPHONY=false\n"
        "ENABLE_REAL_WHATSAPP=false\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(scripts.dev, "ENV_FILE", environment_file)

    loaded = _ensure_local_voice_credentials()

    assert loaded["LIVEKIT_API_KEY"].startswith("local-")
    assert len(loaded["LIVEKIT_API_SECRET"]) >= 32
    assert loaded["ENABLE_REAL_TELEPHONY"] == "false"
    assert loaded["ENABLE_REAL_WHATSAPP"] == "false"


def test_real_voice_flags_must_be_enabled_together(monkeypatch, tmp_path: Path) -> None:
    environment_file = tmp_path / ".env"
    environment_file.write_text("", encoding="utf-8")
    monkeypatch.setattr(scripts.dev, "ENV_FILE", environment_file)

    try:
        _ensure_real_voice_material(
            {
                "ENABLE_REAL_TELEPHONY": "true",
                "ENABLE_REAL_VOICE_PROVIDERS": "false",
            }
        )
    except RuntimeError as error:
        assert "must be enabled together" in str(error)
    else:
        raise AssertionError("mismatched real-voice flags were accepted")


def test_verification_refuses_the_automatic_call_switch() -> None:
    with pytest.raises(RuntimeError, match="ENABLE_WHATSAPP_AUTO_CALLS"):
        _require_provider_safety({"ENABLE_WHATSAPP_AUTO_CALLS": "true"})


def test_real_voice_startup_generates_only_ignored_local_encryption_keys(
    monkeypatch, tmp_path: Path
) -> None:
    environment_file = tmp_path / ".env"
    environment_file.write_text(
        "ENABLE_REAL_TELEPHONY=true\nENABLE_REAL_VOICE_PROVIDERS=true\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(scripts.dev, "ENV_FILE", environment_file)

    loaded = _ensure_real_voice_material(
        {
            "ENABLE_REAL_TELEPHONY": "true",
            "ENABLE_REAL_VOICE_PROVIDERS": "true",
        }
    )

    assert len(loaded["FIELD_CIPHER_LOCAL_KEY"]) == 44
    assert len(loaded["BLIND_INDEX_KEY"]) == 44
    assert loaded["ENABLE_REAL_TELEPHONY"] == "true"
    assert loaded["ENABLE_REAL_VOICE_PROVIDERS"] == "true"
