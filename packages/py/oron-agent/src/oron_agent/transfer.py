"""SIP REFER the caller's leg to a human. `end_conversation` hangs up; this
hands the call over instead."""

from collections.abc import Callable
from typing import Any

from livekit import api
from livekit.protocol import models
from loguru import logger


def make_transfer_action(
    *,
    room: str,
    url: str,
    api_key: str,
    api_secret: str,
    api_factory: Callable[..., api.LiveKitAPI] = api.LiveKitAPI,
):
    """`action["to"]` is already E164 — `ActionSpec` proved that at publish."""

    async def transfer(action: dict, flow_manager: Any) -> None:
        to = None
        try:
            # All inside: a raise here becomes FlowError and ends the call.
            to = action["to"]
            async with api_factory(url, api_key, api_secret) as lkapi:
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
                    logger.warning(f"No SIP participant in {room}; nothing to transfer to {to}")
                    return

                await lkapi.sip.transfer_sip_participant(
                    api.TransferSIPParticipantRequest(
                        room_name=room,
                        participant_identity=sip.identity,
                        transfer_to=f"tel:{to}",
                    )
                )
                logger.info(f"Transferred {sip.identity} in {room} to {to}")
        except Exception as exc:  # noqa: BLE001
            # ponytail: a refused REFER leaves the caller with a silent bot until the
            # idle timer ends the call; warm transfer is the upgrade if that proves harsh.
            logger.error(f"Transfer of {room} to {to} failed: {exc}")

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
            async with api_factory(url, api_key, api_secret) as lkapi:
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
                    logger.warning(f"No SIP participant in {room}; emergency transfer not possible")
                    return "caller_disconnected"
                await lkapi.sip.transfer_sip_participant(
                    api.TransferSIPParticipantRequest(
                        room_name=room,
                        participant_identity=sip.identity,
                        transfer_to=f"tel:{to}",
                    )
                )
                logger.info(f"Emergency transfer initiated for {room}")
                return "transfer_initiated"
        except Exception as exc:  # noqa: BLE001
            logger.error(f"Emergency transfer of {room} failed: {type(exc).__name__}")
            return "transfer_failed"

    return transfer
