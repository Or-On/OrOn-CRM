"""Transcript capture, ported from jpost's TranscriptHandler.

Turns come from the aggregators' `on_user_turn_stopped` /
`on_assistant_turn_stopped` events rather than raw frames — pipecat has already
aggregated an utterance by then, so there is no fragment reassembly to get wrong.
"""

import asyncio
import os
from pathlib import Path

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
        self._lock = asyncio.Lock()

    async def save_message(self, message: TranscriptMessage) -> None:
        async with self._lock:
            self.messages.append(message)
            line = self._line(message)
            logger.info("Transcript turn persisted locally")
            try:
                await asyncio.to_thread(self._append_line, line)
            except OSError:
                # A transcript write must never take the call down with it.
                logger.error("Transcript turn could not be persisted locally")

    async def finalize(self) -> None:
        """Write the completed transcript in event-time order.

        Pipecat can deliver a user turn event after an idle/assistant event even
        when its embedded timestamp is earlier. Append-as-you-go remains the
        crash-safe journal; this atomic final pass makes completed playback and
        diagnostics chronological.
        """

        async with self._lock:
            ordered = sorted(
                enumerate(self.messages),
                key=lambda item: (item[1].timestamp is None, item[1].timestamp or "", item[0]),
            )
            lines = [self._line(message) for _, message in ordered]
            try:
                await asyncio.to_thread(self._replace_lines, lines)
            except OSError:
                logger.error("Transcript could not be finalized chronologically")

    @staticmethod
    def _line(message: TranscriptMessage) -> str:
        stamp = f"[{message.timestamp}] " if message.timestamp else ""
        cut = " [interrupted]" if message.interrupted else ""
        return f"{stamp}{message.role}{cut}: {message.content}"

    def _append_line(self, line: str) -> None:
        with open(self.output_file, "a", encoding="utf-8") as output:
            output.write(line + "\n")

    def _replace_lines(self, lines: list[str]) -> None:
        target = Path(self.output_file)
        temporary = target.with_suffix(f"{target.suffix}.tmp")
        temporary.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")
        os.replace(temporary, target)
