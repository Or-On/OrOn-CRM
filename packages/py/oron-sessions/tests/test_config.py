import pytest
from oron_sessions.config import Settings, load_settings
from pydantic import ValidationError

DSN_VARS = (
    "DATABASE_URL",
    "CONTROL_DATABASE_URL",
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_SESSIONS_PASSWORD",
    "DB_TENANCY_PASSWORD",
    "ENABLE_REAL_TELEPHONY",
)


def _settings(monkeypatch, **env) -> Settings:
    """Settings from `env` alone — `_env_file=None` because the repo's own `.env`
    would otherwise supply the very variables these tests remove."""
    for name in DSN_VARS:
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return Settings(_env_file=None)


def test_the_listen_port_is_configurable(monkeypatch):
    """oron-sessions and oron-dispatcher both run with host networking on the
    LiveKit VM, and LiveKit's webhook must own 8080 — so a hardcoded 8080 here
    means the two collide and one silently never binds."""
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://x/y")
    monkeypatch.setenv("CONTROL_DATABASE_URL", "postgresql+asyncpg://x/y")
    monkeypatch.setenv("PORT", "8081")
    assert load_settings().port == 8081


def test_the_listen_port_defaults_to_8080(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://x/y")
    monkeypatch.setenv("CONTROL_DATABASE_URL", "postgresql+asyncpg://x/y")
    monkeypatch.delenv("PORT", raising=False)
    assert load_settings().port == 8080


def test_real_telephony_defaults_to_disabled(monkeypatch):
    settings = _settings(
        monkeypatch,
        DATABASE_URL="postgresql+asyncpg://x/y",
        CONTROL_DATABASE_URL="postgresql+asyncpg://x/y",
    )
    assert settings.enable_real_telephony is False


def test_session_secrets_are_redacted_from_settings_diagnostics(monkeypatch):
    settings = _settings(
        monkeypatch,
        DATABASE_URL="postgresql+asyncpg://x/y",
        CONTROL_DATABASE_URL="postgresql+asyncpg://x/y",
        BLIND_INDEX_KEY="never-print-index-key",
        OUTBOUND_API_TOKEN="never-print-outbound-token",
    )
    rendered = repr(settings)
    assert "never-print-index-key" not in rendered
    assert "never-print-outbound-token" not in rendered


def test_the_dsns_are_composed_from_the_shared_parts(monkeypatch):
    """One host to change, not two — and each role gets its own credentials."""
    settings = _settings(
        monkeypatch,
        DB_HOST="db.internal",
        DB_PORT="6432",
        DB_NAME="oron",
        DB_SESSIONS_PASSWORD="s3ss",
        DB_TENANCY_PASSWORD="t3n",
    )
    assert (
        settings.database_url == "postgresql+asyncpg://oron_sessions_app:s3ss@db.internal:6432/oron"
    )
    assert settings.control_database_url == (
        "postgresql+asyncpg://oron_tenancy_app:t3n@db.internal:6432/oron"
    )


def test_an_explicit_url_wins_over_the_parts(monkeypatch):
    """Existing deployments resolve the whole DSN from Secret Manager; the parts
    must not quietly override what they supply."""
    settings = _settings(
        monkeypatch,
        DATABASE_URL="postgresql+asyncpg://someone:else@elsewhere/db",
        DB_HOST="db.internal",
        DB_NAME="oron",
        DB_SESSIONS_PASSWORD="s3ss",
        DB_TENANCY_PASSWORD="t3n",
    )
    assert settings.database_url == "postgresql+asyncpg://someone:else@elsewhere/db"
    # ...and the other DSN still composes, so one override does not require both.
    assert settings.control_database_url.startswith("postgresql+asyncpg://oron_tenancy_app:t3n@")


def test_driverless_deployment_dsns_select_the_async_driver(monkeypatch):
    """Deployment env files carry `postgresql://`. Passed through unchanged,
    create_async_engine picks psycopg2 (not installed) and the process dies at
    its first query."""
    from oron_db import make_engine

    settings = _settings(
        monkeypatch,
        DATABASE_URL="postgresql://oron_sessions_app:s3ss@postgres:5432/oron",
        CONTROL_DATABASE_URL="postgres://oron_tenancy_app:t3n@postgres:5432/oron",
    )
    assert settings.database_url == "postgresql+asyncpg://oron_sessions_app:s3ss@postgres:5432/oron"
    assert settings.control_database_url == (
        "postgresql+asyncpg://oron_tenancy_app:t3n@postgres:5432/oron"
    )
    for url in (settings.database_url, settings.control_database_url):
        assert make_engine(url).dialect.driver == "asyncpg"


def test_incomplete_parts_without_an_override_fail_at_load(monkeypatch):
    """Fail closed: a half-built DSN surfaces as a baffling connection error at
    the first query instead of a missing-variable message at startup."""
    with pytest.raises(ValidationError, match="DB_NAME"):
        _settings(monkeypatch, DB_HOST="db.internal", DB_SESSIONS_PASSWORD="s3ss")
