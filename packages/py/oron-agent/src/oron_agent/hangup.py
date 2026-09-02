"""Drop the call when the bot is the one that finished.

`end_conversation` ends the pipeline; it does not disconnect the SIP leg. Heard
live 2026-07-27: the bot said "יום טוב" at 16:20:06 and the line stayed open
until 16:20:43 — 37 seconds of dead air while the caller waited for a call that
was already over. Deleting the room drops everyone in it, which is what hangs up
the phone.
"""

from livekit import api
from loguru import logger


async def hangup_room(room: str, *, url: str, api_key: str, api_secret: str) -> None:
    """Delete `room`, hanging up every leg. Never raises: this runs during
    teardown, where the call is over either way and an exception would only lose
    the finalize that follows."""
    lkapi = api.LiveKitAPI(url, api_key, api_secret)
    try:
        await lkapi.room.delete_room(api.DeleteRoomRequest(room=room))
        logger.info(f"Hung up room {room}")
    except Exception as exc:  # noqa: BLE001 — teardown must not raise
        logger.warning(f"Could not hang up room {room}: {exc}")
    finally:
        await lkapi.aclose()
