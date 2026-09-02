"""Make the opening line unbarge-in-able.

The greeting is the one sentence that has to land: it says who is calling and
why, and a caller who talks over it never hears either. Everything after it
should stay interruptible — a canvassing bot that cannot be stopped mid-pitch is
worse than one that can.

Dropping the caller's audio is the whole mechanism. No audio means no VAD, no
transcript and no user turn, so nothing downstream has anything to interrupt
with — rather than letting the interruption start and trying to unwind it.
"""

import time
from collections.abc import Callable

from loguru import logger
from pipecat.frames.frames import Frame, InputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class HoldOpener(FrameProcessor):
    """Drop inbound audio until the bot's first utterance is done.

    `opener_done` is injected rather than observed here: BotStoppedSpeakingFrame
    originates at the transport OUTPUT and never reaches the input side, which is
    the same split BotSpeakingObserver already exists to bridge.
    """

    def __init__(self, opener_done: Callable[[], bool], *, max_hold_secs: float, **kwargs):
        super().__init__(**kwargs)
        self._opener_done = opener_done
        self._max_hold_secs = max_hold_secs
        self._started: float | None = None
        self._released = False
        self._dropped = 0

    def _release(self, reason: str) -> None:
        self._released = True
        logger.debug(f"HoldOpener released after {self._dropped} frame(s) ({reason})")

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if not self._released and isinstance(frame, InputAudioRawFrame):
            if self._started is None:
                self._started = time.monotonic()
            if self._opener_done():
                self._release("opener finished")
            # A bot that never speaks must not deafen the call forever: a flow
            # that fails to greet would otherwise drop every frame for the whole
            # call, and the caller would talk to something that cannot hear.
            elif time.monotonic() - self._started > self._max_hold_secs:
                self._release(f"timed out after {self._max_hold_secs}s without an opener")
            else:
                self._dropped += 1
                return  # swallowed: the caller cannot interrupt the greeting
        await self.push_frame(frame, direction)
