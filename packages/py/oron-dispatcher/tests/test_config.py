from oron_dispatcher.config import DispatcherSettings


def test_real_telephony_defaults_off_and_secrets_are_redacted(monkeypatch) -> None:
    monkeypatch.delenv("ENABLE_REAL_TELEPHONY", raising=False)
    settings = DispatcherSettings(
        _env_file=None,
        LIVEKIT_API_KEY="test-key",
        LIVEKIT_API_SECRET="test-secret-test-secret-test-secret",
    )

    diagnostics = settings.diagnostics()
    assert settings.enable_real_telephony is False
    assert diagnostics["livekit_api_key"] == "[REDACTED]"
    assert diagnostics["livekit_api_secret"] == "[REDACTED]"
    assert "firebase" not in " ".join(diagnostics).lower()
