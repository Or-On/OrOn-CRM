import pytest
from or_on_platform.config import PlatformSettings
from pydantic import ValidationError


def test_real_provider_actions_default_to_disabled() -> None:
    settings = PlatformSettings(_env_file=None)

    assert settings.enable_real_telephony is False
    assert settings.enable_real_whatsapp is False


def test_only_postgresql_urls_validate() -> None:
    with pytest.raises(ValidationError):
        PlatformSettings(_env_file=None, DATABASE_URL="sqlite:///unsafe.db")


def test_diagnostics_redact_database_and_provider_secrets() -> None:
    settings = PlatformSettings(
        _env_file=None,
        DATABASE_URL="postgresql://platform:do-not-print@localhost/platform",
        LIVEKIT_API_SECRET="livekit-secret",
        WHATSAPP_ACCESS_TOKEN="whatsapp-secret",
        AI_API_KEY="ai-secret",
    )

    rendered = str(settings.diagnostics())
    assert "do-not-print" not in rendered
    assert "livekit-secret" not in rendered
    assert "whatsapp-secret" not in rendered
    assert "ai-secret" not in rendered
    assert "[REDACTED]" in rendered
