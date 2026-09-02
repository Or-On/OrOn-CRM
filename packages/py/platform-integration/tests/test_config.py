import pytest
from or_on_platform.config import PlatformSettings
from pydantic import ValidationError


def test_real_provider_actions_default_to_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    # Test defaults, not the operator's explicitly enabled development settings.
    for key in ("ENABLE_REAL_TELEPHONY", "ENABLE_REAL_WHATSAPP", "CONTROL_API_BIND_HOST"):
        monkeypatch.delenv(key, raising=False)
    settings = PlatformSettings(_env_file=None)

    assert settings.enable_real_telephony is False
    assert settings.enable_real_whatsapp is False
    assert settings.control_api_bind_host == "127.0.0.1"


def test_container_bind_host_is_explicitly_supported() -> None:
    settings = PlatformSettings(
        _env_file=None,
        CONTROL_API_BIND_HOST="0.0.0.0",  # noqa: S104 - container-only explicit opt-in
    )

    assert settings.control_api_bind_host == "0.0.0.0"  # noqa: S104


def test_only_postgresql_urls_validate() -> None:
    with pytest.raises(ValidationError):
        PlatformSettings(_env_file=None, DATABASE_URL="sqlite:///unsafe.db")


def test_diagnostics_redact_database_and_provider_secrets() -> None:
    settings = PlatformSettings(
        _env_file=None,
        DATABASE_URL="postgresql://platform:do-not-print@localhost/platform",
        VOICE_DATABASE_URL="postgresql://voice:do-not-print-voice@localhost/platform",
        AUTH_SERVICE_SECRET="auth-service-secret-that-must-not-print",
        LIVEKIT_API_SECRET="livekit-secret",
        WHATSAPP_ACCESS_TOKEN="whatsapp-secret",
        AI_API_KEY="ai-secret",
    )

    rendered = str(settings.diagnostics())
    assert "do-not-print" not in rendered
    assert "do-not-print-voice" not in rendered
    assert "auth-service-secret" not in rendered
    assert "livekit-secret" not in rendered
    assert "whatsapp-secret" not in rendered
    assert "ai-secret" not in rendered
    assert "[REDACTED]" in rendered
