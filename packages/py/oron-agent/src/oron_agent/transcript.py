"""Transcript capture, ported from jpost's TranscriptHandler.

Turns come from the aggregators' `on_user_turn_stopped` /
`on_assistant_turn_stopped` events rather than raw frames — pipecat has already
aggregated an utterance by then, so there is no fragment reassembly to get wrong.
"""

import asyncio

from loguru import logger
from pydantic import BaseModel


class TranscriptMessage(BaseModel):
    """One conversation turn. Local structure, not a pipecat type."""

    role: str
    content: str
    timestamp: str | None = None
    # A cut-off line is otherwise indistinguishable from a complete one, which
    # is exactly the difference you are looking for when a caller reports the
    # bot talking over them.
    interrupted: bool = False


class TranscriptHandler:
    """Appends turns to a local .txt as they happen.

    Written line-by-line during the call rather than assembled at the end, so a
    call that dies mid-way still leaves everything said up to that point on disk
    for the upload to collect.
    """

    def __init__(self, output_file: str):
        self.messages: list[TranscriptMessage] = []
        self.output_file = output_file

    async def save_message(self, message: TranscriptMessage) -> None:
        self.messages.append(message)
        stamp = f"[{message.timestamp}] " if message.timestamp else ""
        cut = " [interrupted]" if message.interrupted else ""
        line = f"{stamp}{message.role}{cut}: {message.content}"
        logger.info("Transcript turn persisted locally")
        try:
            await asyncio.to_thread(self._append_line, line)
        except OSError:
            # A transcript write must never take the call down with it.
            logger.error("Transcript turn could not be persisted locally")

    def _append_line(self, line: str) -> None:
        with open(self.output_file, "a", encoding="utf-8") as output:
            output.write(line + "\n")
