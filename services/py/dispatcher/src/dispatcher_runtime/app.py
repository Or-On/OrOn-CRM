"""Composition boundary for the retained dispatcher HTTP runtime."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from livekit import api
from or_on_platform.config import PlatformSettings
from or_on_platform.service_auth import ServiceAssertionVerifier
from oron_dispatcher.config import DispatcherSettings
from oron_dispatcher.dispatcher import (
    Dispatcher,
    HangupRoom,
    MintToken,
    ResolvePhone,
    SessionPersistence,
)
from oron_dispatcher.sip_client import SipClient
from oron_dispatcher.webhook import create_app
from oron_dispatcher.webhook_ledger import PostgresWebhookLedger

if TYPE_CHECKING:
    from oron_agent.config import Settings as AgentSettings
    from oron_agent.runtime_sessions import RuntimeSessions
    from renikud_onnx import G2P


def compose_dispatcher(
    *,
    dispatcher_settings: DispatcherSettings,
    agent_settings: AgentSettings,
    sessions: SessionPersistence,
    sip_client: SipClient,
    resolve_phone: ResolvePhone,
    hangup_room: HangupRoom,
    mint_token: MintToken,
    runtime_sessions: RuntimeSessions | None = None,
    g2p: G2P | None = None,
) -> Dispatcher:
    """Inject the retained agent launcher while keeping all I/O ports explicit."""

    from oron_agent.launcher import make_launch_bot

    return Dispatcher(
        settings=dispatcher_settings,
        sessions=sessions,
        sip_client=sip_client,
        launch_bot=make_launch_bot(agent_settings, g2p=g2p, sessions=runtime_sessions),
        resolve_phone=resolve_phone,
        hangup_room=hangup_room,
        mint_token=mint_token,
    )


def build(
    *,
    platform_settings: PlatformSettings | None = None,
    dispatcher_settings: DispatcherSettings | None = None,
    dispatcher: Dispatcher | None = None,
    shutdown: Callable[[], Awaitable[None]] | None = None,
):
    """Build without globals; full I/O composition remains explicit at the edge."""

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
        shutdown=shutdown,
    )
