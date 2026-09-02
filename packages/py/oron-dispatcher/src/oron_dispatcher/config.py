"""Typed dispatcher configuration with provider-safe defaults."""

from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class DispatcherSettings(BaseSettings):
    model_config = SettingsConfigDict(
        case_sensitive=True,
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    livekit_url: str | None = Field(default=None, validation_alias="LIVEKIT_URL")
    livekit_api_key: SecretStr | None = Field(default=None, validation_alias="LIVEKIT_API_KEY")
    livekit_api_secret: SecretStr | None = Field(
        default=None, validation_alias="LIVEKIT_API_SECRET"
    )
    sip_outbound_trunk_id: str | None = Field(
        default=None, validation_alias="SIP_OUTBOUND_TRUNK_ID"
    )
    enable_real_telephony: bool = Field(default=False, validation_alias="ENABLE_REAL_TELEPHONY")
    bind_host: Literal["127.0.0.1", "0.0.0.0"] = Field(  # noqa: S104
        default="127.0.0.1", validation_alias="DISPATCHER_BIND_HOST"
    )
    port: int = Field(default=8082, ge=1, le=65535, validation_alias="DISPATCHER_PORT")
    room_prefix: str = Field(default="call-", validation_alias="ROOM_PREFIX")
    bot_identity: str = Field(default="oron-agent", validation_alias="BOT_IDENTITY")

    def diagnostics(self) -> dict[str, object]:
        return {
            "livekit_url": self.livekit_url or "unset",
            "livekit_api_key": "unset" if self.livekit_api_key is None else "[REDACTED]",
            "livekit_api_secret": "unset" if self.livekit_api_secret is None else "[REDACTED]",
            "sip_outbound_trunk_id": (
                "unset" if self.sip_outbound_trunk_id is None else "[CONFIGURED]"
            ),
            "enable_real_telephony": self.enable_real_telephony,
            "bind_host": self.bind_host,
            "port": self.port,
            "room_prefix": self.room_prefix,
            "bot_identity": self.bot_identity,
        }
