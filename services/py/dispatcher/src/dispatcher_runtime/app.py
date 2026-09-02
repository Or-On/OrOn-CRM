"""Composition boundary for the retained dispatcher HTTP runtime."""

from __future__ import annotations

from livekit import api
from or_on_platform.config import PlatformSettings
from or_on_platform.service_auth import ServiceAssertionVerifier
from oron_dispatcher.config import DispatcherSettings
from oron_dispatcher.dispatcher import Dispatcher
from oron_dispatcher.webhook import create_app
from oron_dispatcher.webhook_ledger import PostgresWebhookLedger


def build(
    *,
    platform_settings: PlatformSettings | None = None,
    dispatcher_settings: DispatcherSettings | None = None,
    dispatcher: Dispatcher | None = None,
):
    """Build without globals; P5-010 injects the retained voice-agent launcher."""

    platform = platform_settings or PlatformSettings.load(service="dispatcher")
    configured = dispatcher_settings or DispatcherSettings()

    database_url = platform.voice_database_url
    ledger = PostgresWebhookLedger(str(database_url)) if database_url is not None else None

    secret = platform.auth_service_secret
    verifier = (
        ServiceAssertionVerifier(secret.get_secret_value(), audience="dispatcher")
        if secret is not None
        else None
    )

    livekit_key = configured.livekit_api_key
    livekit_secret = configured.livekit_api_secret
    receiver = (
        api.WebhookReceiver(
            api.TokenVerifier(
                livekit_key.get_secret_value(),
                livekit_secret.get_secret_value(),
            )
        )
        if livekit_key is not None and livekit_secret is not None
        else None
    )
    return create_app(
        dispatcher=dispatcher,
        receiver=receiver,
        ledger=ledger,
        assertion_verifier=verifier,
    )
