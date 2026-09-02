"""Wait for an outbound callee to actually pick up.

LiveKit puts the SIP participant in the room when dialling *starts*, so the
agent's `on_first_participant_joined` fires while the phone is still ringing.
Measured on two live calls on 2026-07-27: the bot delivered its opening line
5.1s and 4.6s before `Outbound SIP call established`. The callee answers to
silence, says "הלו?", and the flow has already advanced past its opening node —
so the model improvises, off-script and out of persona.

The pick-up shows up as the `sip.callStatus` participant attribute turning
`active`. pipecat's LiveKitTransport declares an `on_call_state_updated` event
but never fires it (dead code in the transport), and `get_participant_metadata`
omits attributes, so this reads the room directly.
"""

import asyncio

from loguru import logger

SIP_CALL_STATUS = "sip.callStatus"
ANSWERED = "active"


def _statuses(transport) -> list[str]:
    """Every remote participant's SIP call status.

    Reaches through `_client` because the transport exposes no public accessor
    for participant attributes — `get_participant_metadata` returns only
    id/name/metadata/is_speaking. Wrapped so the private path is in one place
    and a pipecat change breaks one function rather than the call.
    """
    try:
        room = transport._client.room
        return [
            p.attributes.get(SIP_CALL_STATUS, "")
            for p in room.remote_participants.values()
            if p.attributes
        ]
    except Exception:  # noqa: BLE001 — never let introspection end a live call
        return []


async def wait_until_answered(transport, *, timeout_secs: float, poll_secs: float = 0.2) -> bool:
    """Block until a participant reports `active`, or `timeout_secs` elapses.

    Returns True if the pick-up was observed. On timeout it returns False and
    the caller proceeds anyway: a bot that greets a few seconds early is a bad
    call, but a bot that never greets is a dead one — and a carrier that does
    not report the attribute must not silence every outbound call.
    """
    deadline = asyncio.get_running_loop().time() + timeout_secs
    while asyncio.get_running_loop().time() < deadline:
        if ANSWERED in _statuses(transport):
            return True
        await asyncio.sleep(poll_secs)
    logger.warning(
        "no participant reported {}={} within {}s — greeting anyway, which may "
        "play into a ringing line",
        SIP_CALL_STATUS,
        ANSWERED,
        timeout_secs,
    )
    return False
