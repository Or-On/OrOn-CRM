import pytest
from oron_agent.bot import RealVoiceProvidersDenied, require_real_voice_providers
from oron_agent.config import Settings
from pydantic import ValidationError


def test_real_voice_providers_default_to_false_without_credentials() -> None:
    settings = Settings(_env_file=None)
    assert settings.enable_real_voice_providers is False
    with pytest.raises(RealVoiceProvidersDenied, match="disabled"):
        require_real_voice_providers(settings)


def test_diagnostics_redact_every_provider_secret() -> None:
    settings = Settings(
        _env_file=None,
        LIVEKIT_API_KEY="livekit-secret-value",
        LIVEKIT_API_SECRET="livekit-api-secret-value",
        SONIOX_API_KEY="soniox-secret-value",
        LLM_API_KEY="llm-secret-value",
    )
    rendered = repr(settings.diagnostics())
    assert "secret-value" not in rendered
    assert rendered.count("[REDACTED]") == 4


def test_enabling_real_voice_providers_requires_complete_configuration() -> None:
    with pytest.raises(ValidationError, match="ENABLE_REAL_VOICE_PROVIDERS"):
        Settings(_env_file=None, ENABLE_REAL_VOICE_PROVIDERS=True)


def test_model_path_and_hash_must_be_configured_together() -> None:
    with pytest.raises(ValidationError, match="Renikud"):
        Settings(
            _env_file=None,
            ENABLE_REAL_VOICE_PROVIDERS=True,
            LIVEKIT_URL="ws://127.0.0.1:7880",
            LIVEKIT_API_KEY="fixture",
            LIVEKIT_API_SECRET="fixture-secret",
            SONIOX_API_KEY="fixture-soniox",
            GOOGLE_CLOUD_PROJECT="fixture-project",
            RENUKID_MODEL_PATH="models/renikud.onnx",
        )
