"""Validated process configuration with provider-safe defaults."""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, PostgresDsn, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class SettingsError(ValueError):
    """Raised when configuration cannot safely start a process."""


class PlatformSettings(BaseSettings):
    """Common settings loaded once at an entrypoint and injected into services."""

    model_config = SettingsConfigDict(
        case_sensitive=True,
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: Literal["development", "test", "production"] = Field(
        default="development", validation_alias="PLATFORM_ENV"
    )
    service: str = Field(default="unknown-service", validation_alias="PLATFORM_SERVICE")
    database_url: PostgresDsn | None = Field(default=None, validation_alias="DATABASE_URL")
    voice_database_url: PostgresDsn | None = Field(
        default=None, validation_alias="VOICE_DATABASE_URL"
    )
    control_api_url: str = Field(
        default="http://127.0.0.1:8000", validation_alias="CONTROL_API_URL"
    )
    control_api_bind_host: Literal["127.0.0.1", "0.0.0.0"] = Field(  # noqa: S104
        default="127.0.0.1", validation_alias="CONTROL_API_BIND_HOST"
    )
    log_level: Annotated[
        Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        Field(validation_alias="LOG_LEVEL"),
    ] = "INFO"
    enable_real_telephony: bool = Field(default=False, validation_alias="ENABLE_REAL_TELEPHONY")
    enable_real_whatsapp: bool = Field(default=False, validation_alias="ENABLE_REAL_WHATSAPP")
    livekit_api_secret: SecretStr | None = Field(
        default=None, validation_alias="LIVEKIT_API_SECRET"
    )
    auth_service_secret: SecretStr | None = Field(
        default=None, min_length=32, validation_alias="AUTH_SERVICE_SECRET"
    )
    whatsapp_access_token: SecretStr | None = Field(
        default=None, validation_alias="WHATSAPP_ACCESS_TOKEN"
    )
    ai_api_key: SecretStr | None = Field(default=None, validation_alias="AI_API_KEY")

    @classmethod
    def load(cls, *, require_database: bool = False, service: str | None = None) -> Self:
        """Read the environment and enforce entrypoint-specific requirements."""

        settings = cls()
        if service is not None:
            settings.service = service
        if require_database and settings.database_url is None:
            raise SettingsError("DATABASE_URL is required for this service and must use PostgreSQL")
        return settings

    def diagnostics(self) -> dict[str, object]:
        """Return startup-safe fields; secret values and the DB URL never escape."""

        return {
            "environment": self.environment,
            "service": self.service,
            "database_url": "unset" if self.database_url is None else "[REDACTED]",
            "voice_database_url": "unset" if self.voice_database_url is None else "[REDACTED]",
            "control_api_url": self.control_api_url,
            "control_api_bind_host": self.control_api_bind_host,
            "log_level": self.log_level,
            "enable_real_telephony": self.enable_real_telephony,
            "enable_real_whatsapp": self.enable_real_whatsapp,
            "livekit_api_secret": self._secret_state(self.livekit_api_secret),
            "auth_service_secret": self._secret_state(self.auth_service_secret),
            "whatsapp_access_token": self._secret_state(self.whatsapp_access_token),
            "ai_api_key": self._secret_state(self.ai_api_key),
        }

    @staticmethod
    def _secret_state(value: SecretStr | None) -> str:
        return "unset" if value is None else "[REDACTED]"
