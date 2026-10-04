"""SIP REFER the caller's leg to a human. `end_conversation` hangs up; this
hands the call over instead."""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from livekit import api
from livekit.protocol import models
from loguru import logger
from oron_common import validate_e164

_TRANSFER_TIMEOUT_SECONDS = 10.0


def make_transfer_action(
    *,
    room: str,
    url: str,
    api_key: str,
    api_secret: str,
    api_factory: Callable[..., api.LiveKitAPI] = api.LiveKitAPI,
    on_failure: Callable[[], Awaitable[None]] | None = None,
):
    """`action["to"]` is already E164 — `ActionSpec` proved that at publish."""

    async def transfer(action: dict, flow_manager: Any) -> None:
        to = None
        try:
            # All inside: a raise here becomes FlowError and ends the call.
            to = validate_e164(action["to"])
            async with (
                asyncio.timeout(_TRANSFER_TIMEOUT_SECONDS),
                api_factory(url, api_key, api_secret) as lkapi,
            ):
                participants = await lkapi.room.list_participants(
                    api.ListParticipantsRequest(room=room)
                )
                sip = next(
                    (
                        p
                        for p in participants.participants
                        if p.kind == models.ParticipantInfo.Kind.SIP
                    ),
                    None,
                )
                if sip is None:
                    logger.warning("Transfer unavailable: caller disconnected")
                    return

                await lkapi.sip.transfer_sip_participant(
                    api.TransferSIPParticipantRequest(
                        room_name=room,
                        participant_identity=sip.identity,
                        transfer_to=f"tel:{to}",
                    )
                )
                logger.info("SIP transfer initiated; remote answer remains unknown")
        except Exception as exc:  # noqa: BLE001
            logger.warning("SIP transfer failed: {}", type(exc).__name__)
            if on_failure is not None:
                try:
                    async with asyncio.timeout(_TRANSFER_TIMEOUT_SECONDS):
                        await on_failure()
                except Exception as fallback_error:
                    logger.warning(
                        "Transfer fallback unavailable: {}", type(fallback_error).__name__
                    )

    return transfer


def make_emergency_transfer(
    *,
    room: str,
    url: str,
    api_key: str,
    api_secret: str,
    api_factory: Callable[..., api.LiveKitAPI] = api.LiveKitAPI,
):
    """SIP REFER for an emergency escalation that REPORTS its outcome.

    ``transfer_initiated`` means the provider accepted the REFER, not that the
    on-call person answered; nothing here can observe an answer. The number is
    supplied by the trusted runtime from server configuration and is never
    logged.
    """

    async def transfer(to: str) -> str:
        try:
            target = validate_e164(to)
            async with (
                asyncio.timeout(_TRANSFER_TIMEOUT_SECONDS),
                api_factory(url, api_key, api_secret) as lkapi,
            ):
                participants = await lkapi.room.list_participants(
                    api.ListParticipantsRequest(room=room)
                )
                sip = next(
                    (
                        p
                        for p in participants.participants
                        if p.kind == models.ParticipantInfo.Kind.SIP
                    ),
                    None,
                )
                if sip is None:
                    logger.warning("Emergency transfer unavailable: caller disconnected")
                    return "caller_disconnected"
                await lkapi.sip.transfer_sip_participant(
                    api.TransferSIPParticipantRequest(
                        room_name=room,
                        participant_identity=sip.identity,
                        transfer_to=f"tel:{target}",
                    )
                )
                logger.info("Emergency transfer initiated; remote answer remains unknown")
                return "transfer_initiated"
        except Exception as exc:  # noqa: BLE001
            logger.warning("Emergency transfer failed: {}", type(exc).__name__)
            return "transfer_failed"

    return transfer
