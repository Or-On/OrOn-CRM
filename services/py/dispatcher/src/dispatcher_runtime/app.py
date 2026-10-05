"""Composition boundary for the retained dispatcher HTTP runtime."""

from __future__ import annotations

import asyncio
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
    PlayAnnouncement,
    ResolvePhone,
    SessionPersistence,
)
from oron_dispatcher.sip_client import SipClient
from oron_dispatcher.twilio_inbound import TwilioInboundHandler
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
    play_announcement: PlayAnnouncement | None = None,
    g2p: G2P | None = None,
) -> Dispatcher:
    """Inject the retained agent launcher while keeping all I/O ports explicit."""

    from oron_agent.launcher import make_launch_bot

    return Dispatcher(
        settings=dispatcher_settings,
        sessions=sessions,
        sip_client=sip_client,
        launch_bot=make_launch_bot(
            agent_settings,
            g2p=g2p,
            sessions=runtime_sessions,
            play_failure=(lambda room: play_announcement(room, "failure"))
            if play_announcement is not None
            else None,
            play_goodbye=(lambda room: play_announcement(room, "goodbye"))
            if play_announcement is not None
            else None,
            play_recovery=(lambda room: play_announcement(room, "recovery"))
            if play_announcement is not None
            else None,
        ),
        resolve_phone=resolve_phone,
        hangup_room=hangup_room,
        mint_token=mint_token,
        play_announcement=play_announcement,
    )


def build(
    *,
    platform_settings: PlatformSettings | None = None,
    dispatcher_settings: DispatcherSettings | None = None,
    dispatcher: Dispatcher | None = None,
    shutdown: Callable[[], Awaitable[None]] | None = None,
    resolve_phone: ResolvePhone | None = None,
):
    """Build without globals; full I/O composition remains explicit at the edge."""

    platform = platform_settings or PlatformSettings.load(service="dispatcher")
    configured = dispatcher_settings or DispatcherSettings()
    twilio_inbound = None
    if configured.enable_twilio_inbound:
        if resolve_phone is None or configured.twilio_inbound_callback_url is None:
            raise RuntimeError("Twilio inbound requires authoritative phone resolution")
        twilio_inbound = TwilioInboundHandler(
            callback_url=configured.twilio_inbound_callback_url,
            routes=configured.twilio_inbound_routes,
            resolve_phone=resolve_phone,
        )

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

    async def participant_is_current(event) -> bool:
        if configured.livekit_url is None or livekit_key is None or livekit_secret is None:
            raise RuntimeError("LiveKit liveness read is not configured")
        # Process-owned short-lived read client; fixed configured host, not webhook URL.
        async with asyncio.timeout(5):
            async with api.LiveKitAPI(
                configured.livekit_url,
                livekit_key.get_secret_value(),
                livekit_secret.get_secret_value(),
            ) as client:
                try:
                    participant = await client.room.get_participant(
                        api.RoomParticipantIdentity(
                            room=event.room.name, identity=event.participant.identity
                        )
                    )
                except api.TwirpError as exc:
                    if exc.code == "not_found":
                        return False
                    raise
        return (
            participant.sid == event.participant.sid and participant.kind == event.participant.kind
        )

    return create_app(
        participant_is_current=participant_is_current
        if configured.livekit_url is not None
        else None,
        dispatcher=dispatcher,
        receiver=receiver,
        ledger=ledger,
        assertion_verifier=verifier,
        shutdown=shutdown,
        twilio_inbound=twilio_inbound,
    )
