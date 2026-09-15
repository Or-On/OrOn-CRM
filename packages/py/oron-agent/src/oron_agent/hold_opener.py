"""Make the opening line unbarge-in-able without deafening the agent.

The greeting is the one sentence that has to land: it says who is calling and
why, and a caller who talks over it never hears either. Everything after it
should stay interruptible — a canvassing bot that cannot be stopped mid-pitch is
worse than one that can.

Holding the caller's audio is the whole mechanism. No audio reaches VAD while
the opener is playing, so it cannot interrupt that sentence. The held frames
are replayed immediately afterward; an eager caller's first answer is delayed,
not discarded.
"""

import time
from collections import deque
from collections.abc import Callable

from loguru import logger
from pipecat.frames.frames import Frame, InputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class HoldOpener(FrameProcessor):
    """Hold inbound audio until the bot's first utterance is done.

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
        self._buffered: deque[InputAudioRawFrame] = deque()
        self._buffered_secs = 0.0
        self._discarded = 0

    @staticmethod
    def _duration_secs(frame: InputAudioRawFrame) -> float:
        # Pipecat telephony PCM is signed 16-bit. Fail closed to zero for a
        # malformed frame; the frame-count fallback below still bounds memory.
        denominator = frame.sample_rate * frame.num_channels * 2
        return len(frame.audio) / denominator if denominator > 0 else 0.0

    def _hold(self, frame: InputAudioRawFrame) -> None:
        self._buffered.append(frame)
        self._buffered_secs += self._duration_secs(frame)
        # A broken transport can misreport duration. The count limit is a
        # second independent bound (100 frames/second at the common 10 ms size).
        max_frames = max(1, int(self._max_hold_secs * 100) + 1)
        while self._buffered and (
            self._buffered_secs > self._max_hold_secs or len(self._buffered) > max_frames
        ):
            removed = self._buffered.popleft()
            self._buffered_secs = max(0.0, self._buffered_secs - self._duration_secs(removed))
            self._discarded += 1

    async def _flush(self, direction: FrameDirection) -> None:
        while self._buffered:
            await self.push_frame(self._buffered.popleft(), direction)
        self._buffered_secs = 0.0

    def _release(self, reason: str) -> None:
        self._released = True
        logger.debug(
            "HoldOpener released with "
            f"{len(self._buffered)} buffered and {self._discarded} discarded frame(s) ({reason})"
        )

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
                self._hold(frame)
                return  # held: the caller cannot interrupt the greeting
            await self._flush(direction)
        await self.push_frame(frame, direction)
