"""Typed dispatcher configuration with provider-safe defaults."""

from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from oron_dispatcher.outbound_routing import OutboundRoute, validate_routes
from oron_dispatcher.twilio_inbound import (
    TwilioInboundRoute,
    validate_callback_url,
)
from oron_dispatcher.twilio_inbound import (
    validate_routes as validate_inbound_routes,
)


class DispatcherSettings(BaseSettings):
    model_config = SettingsConfigDict(
        case_sensitive=True,
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
    )

    livekit_url: str | None = Field(default=None, validation_alias="LIVEKIT_URL")
    livekit_api_key: SecretStr | None = Field(default=None, validation_alias="LIVEKIT_API_KEY")
    livekit_api_secret: SecretStr | None = Field(
        default=None, validation_alias="LIVEKIT_API_SECRET"
    )
    sip_outbound_trunk_id: str | None = Field(
        default=None, validation_alias="SIP_OUTBOUND_TRUNK_ID"
    )
    # The old global trunk remains recognizable for diagnostics only. It must
    # never become a fallback for a tenant whose reviewed route is absent.
    outbound_routes: tuple[OutboundRoute, ...] = Field(
        default=(), validation_alias="VOICE_OUTBOUND_ROUTES_JSON"
    )

    @field_validator("outbound_routes")
    @classmethod
    def _validate_outbound_routes(cls, routes: tuple[OutboundRoute, ...]):
        return validate_routes(routes)

    enable_real_telephony: bool = Field(default=False, validation_alias="ENABLE_REAL_TELEPHONY")
    enable_twilio_inbound: bool = Field(default=False, validation_alias="ENABLE_TWILIO_INBOUND")
    twilio_inbound_callback_url: str | None = Field(
        default=None, validation_alias="TWILIO_INBOUND_CALLBACK_URL"
    )
    twilio_inbound_routes: tuple[TwilioInboundRoute, ...] = Field(
        default=(), validation_alias="TWILIO_INBOUND_ROUTES_JSON"
    )

    @field_validator("twilio_inbound_routes")
    @classmethod
    def _validate_inbound_routes(cls, routes: tuple[TwilioInboundRoute, ...]):
        return validate_inbound_routes(routes)

    @field_validator("twilio_inbound_callback_url")
    @classmethod
    def _validate_callback_url(cls, value: str | None):
        return validate_callback_url(value) if value is not None else None

    @model_validator(mode="after")
    def _inbound_is_explicit(self):
        if self.enable_twilio_inbound and (
            not self.twilio_inbound_callback_url or not self.twilio_inbound_routes
        ):
            raise ValueError("enabled Twilio inbound requires callback URL and route bindings")
        return self

    bind_host: Literal["127.0.0.1", "0.0.0.0"] = Field(  # noqa: S104
        default="127.0.0.1", validation_alias="DISPATCHER_BIND_HOST"
    )
    port: int = Field(default=8082, ge=1, le=65535, validation_alias="DISPATCHER_PORT")
    room_prefix: str = Field(default="call-", validation_alias="ROOM_PREFIX")
    bot_identity: str = Field(default="oron-agent", validation_alias="BOT_IDENTITY")
    max_active_calls: int = Field(
        default=3, ge=1, le=100, validation_alias="DISPATCHER_MAX_ACTIVE_CALLS"
    )
    max_active_calls_per_tenant: int = Field(
        default=3, ge=1, le=100, validation_alias="DISPATCHER_MAX_ACTIVE_CALLS_PER_TENANT"
    )

    def diagnostics(self) -> dict[str, object]:
        return {
            "livekit_url": self.livekit_url or "unset",
            "livekit_api_key": "unset" if self.livekit_api_key is None else "[REDACTED]",
            "livekit_api_secret": "unset" if self.livekit_api_secret is None else "[REDACTED]",
            "sip_outbound_trunk_id": (
                "unset" if self.sip_outbound_trunk_id is None else "[CONFIGURED]"
            ),
            "enable_real_telephony": self.enable_real_telephony,
            "outbound_route_count": len(self.outbound_routes),
            "enable_twilio_inbound": self.enable_twilio_inbound,
            "twilio_inbound_route_count": len(self.twilio_inbound_routes),
            "bind_host": self.bind_host,
            "port": self.port,
            "room_prefix": self.room_prefix,
            "bot_identity": self.bot_identity,
        }
