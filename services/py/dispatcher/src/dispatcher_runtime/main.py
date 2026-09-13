"""Dispatcher process entrypoint; provider actions remain disabled by default."""

from __future__ import annotations

import uvicorn
from or_on_platform.config import PlatformSettings
from or_on_platform.logging import configure_logging
from oron_agent.config import Settings as AgentSettings
from oron_agent.hangup import hangup_room
from oron_agent.tokens import mint_room_token
from oron_dispatcher.config import DispatcherSettings
from oron_dispatcher.sip_client import SipClient
from oron_hebrew import build_g2p

from dispatcher_runtime.app import build, compose_dispatcher
from dispatcher_runtime.persistence import (
    AgentPostgresSessions,
    DispatcherPostgresSessions,
    PostgresVoiceRuntime,
    VoicePersistenceSettings,
)


def _livekit_api_url(url: str) -> str:
    if url.startswith("wss://"):
        return "https://" + url.removeprefix("wss://")
    if url.startswith("ws://"):
        return "http://" + url.removeprefix("ws://")
    return url


def main() -> None:
    settings = PlatformSettings.load(service="dispatcher")
    dispatcher_settings = DispatcherSettings()
    agent_settings = AgentSettings()
    logger = configure_logging(
        service="dispatcher", environment=settings.environment, level=settings.log_level
    )
    runtime = PostgresVoiceRuntime(VoicePersistenceSettings())
    livekit_url = dispatcher_settings.livekit_url
    livekit_key = dispatcher_settings.livekit_api_key
    livekit_secret = dispatcher_settings.livekit_api_secret
    if livekit_url is None or livekit_key is None or livekit_secret is None:
        raise RuntimeError("dispatcher requires the configured LiveKit URL, key, and secret")
    api_url = _livekit_api_url(livekit_url)
    api_key = livekit_key.get_secret_value()
    api_secret = livekit_secret.get_secret_value()
    dispatcher = compose_dispatcher(
        dispatcher_settings=dispatcher_settings,
        agent_settings=agent_settings,
        sessions=DispatcherPostgresSessions(runtime),
        runtime_sessions=AgentPostgresSessions(runtime),
        sip_client=SipClient(
            url=api_url,
            api_key=api_key,
            api_secret=api_secret,
            trunk_id=dispatcher_settings.sip_outbound_trunk_id,
            enabled=dispatcher_settings.enable_real_telephony,
        ),
        resolve_phone=runtime.resolve_phone,
        hangup_room=lambda room: hangup_room(
            room,
            url=api_url,
            api_key=api_key,
            api_secret=api_secret,
        ),
        mint_token=lambda room, identity: mint_room_token(
            api_key, api_secret, room=room, identity=identity
        ),
        g2p=build_g2p(
            agent_settings.renikud_model_path,
            expected_sha256=agent_settings.renikud_model_sha256,
        ),
    )
    logger.info(
        "dispatcher_starting",
        extra={
            "fields": {
                **dispatcher_settings.diagnostics(),
                "voice_agent_adapter": "retained-launcher-available",
                "full_runtime_composition": "postgres-livekit-pipecat",
            }
        },
    )
    uvicorn.run(
        build(
            platform_settings=settings,
            dispatcher_settings=dispatcher_settings,
            dispatcher=dispatcher,
            shutdown=runtime.close,
        ),
        host=dispatcher_settings.bind_host,
        port=dispatcher_settings.port,
    )


if __name__ == "__main__":
    main()
