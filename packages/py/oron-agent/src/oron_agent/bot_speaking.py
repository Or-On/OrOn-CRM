"""Tracks whether the bot is currently speaking.

The caller-gender classifier sits on the transport INPUT and must ignore audio
arriving while the bot talks — that audio is usually the bot's own voice
echoing back through the caller's speakers, and misclassifying it latches a
wrong gender for the whole call.

`BotStartedSpeakingFrame`/`BotStoppedSpeakingFrame` originate at the transport
OUTPUT and flow downstream, so they never reach a processor on the input side.
This observer sits downstream of the output, records the state, and the
classifier reads it through an injected callable.

Ported in spirit from Jpost's `BotSpeakingObserver`.
"""

from pipecat.frames.frames import BotStartedSpeakingFrame, BotStoppedSpeakingFrame, Frame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class BotSpeakingObserver(FrameProcessor):
    """Instance state, not a module global — one observer per call."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._speaking = False
        self._opener_done = False

    @property
    def is_speaking(self) -> bool:
        return self._speaking

    @property
    def opener_done(self) -> bool:
        """True once the bot has finished its first utterance — the greeting.

        Read by the input-side hold, which is on the other side of the pipeline
        and cannot see these frames for itself."""
        return self._opener_done

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame):
            self._speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._speaking = False
            self._opener_done = True
        await self.push_frame(frame, direction)
