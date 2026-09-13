"""Plan one complete LLM turn before it reaches text-to-speech.

Pipecat applies TTS text filters after sentence/clause aggregation. A filter
there cannot repair a boundary that the aggregator has already emitted, and a
terminal full stop is deliberately stripped for Soniox. This processor holds
the already-bounded LLM turn, repairs it once with full context, and emits one
AggregatedTextFrame. TTS therefore receives an internal full stop between an
answer and its question, while the assistant transcript sees the same text.
"""

import time

from oron_hebrew.filters import normalize_question_boundary
from pipecat.frames.frames import (
    AggregatedTextFrame,
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.utils.text.base_text_aggregator import AggregationType


class HebrewTurnPlanner(FrameProcessor):
    """Collapse a streamed, spoken LLM response into one canonical utterance.

    The live model is capped at 256 output tokens and instructed to produce no
    more than two short sentences. Waiting for its end frame is consequently
    bounded, while avoiding an irreversible early clause send.
    """

    def __init__(self, *, max_chars: int = 8192, **kwargs):
        super().__init__(**kwargs)
        if max_chars < 1:
            raise ValueError("max_chars must be positive")
        self._max_chars = max_chars
        self._generation = 0
        self._started_ns = 0
        self._first_token_ns: int | None = None
        self._length = 0
        self._overflow = False
        self._parts: list[str] = []
        self._collecting = False
        self._skip_tts = False

    def _reset_turn(self) -> None:
        self._parts = []
        self._collecting = False
        self._skip_tts = False
        self._first_token_ns = None
        self._length = 0
        self._overflow = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction is not FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, InterruptionFrame):
            self._generation += 1
            self._reset_turn()
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMFullResponseStartFrame):
            self._reset_turn()
            self._generation += 1
            self._started_ns = time.monotonic_ns()
            self._collecting = True
            self._skip_tts = bool(frame.skip_tts)
            frame.metadata["voice_generation"] = self._generation
            await self.push_frame(frame, direction)
            return

        if self._collecting and isinstance(frame, LLMTextFrame):
            if self._first_token_ns is None:
                self._first_token_ns = time.monotonic_ns()
            if self._skip_tts or frame.skip_tts:
                await self.push_frame(frame, direction)
            else:
                # LLMTextFrame carries its own inter-frame whitespace. Joining
                # exactly mirrors the text TTS's character aggregator receives.
                self._length += len(frame.text)
                if self._length > self._max_chars:
                    self._parts = []
                    self._overflow = True
                elif not self._overflow:
                    self._parts.append(frame.text)
            return

        if isinstance(frame, LLMTextFrame):
            # Late tokens from a cancelled generation must not bypass full-turn
            # validation merely because there is no longer an open buffer.
            return

        if isinstance(frame, LLMFullResponseEndFrame) and self._collecting:
            if not self._skip_tts:
                planned = (
                    "התשובה ארוכה מדי למסירה בטוחה. אפשר להתמקד בשאלה אחת?"
                    if self._overflow
                    else "".join(self._parts)
                )
                # The evidence gate parses structured selectors after this
                # buffer. Never insert spoken punctuation inside model JSON.
                if not planned.lstrip().startswith("{"):
                    planned = normalize_question_boundary(planned)
                if planned.strip():
                    planned_frame = AggregatedTextFrame(
                        planned,
                        AggregationType.SENTENCE,
                        raw_text=planned,
                    )
                    planned_frame.metadata.update(frame.metadata)
                    planned_frame.metadata.update(
                        voice_generation=self._generation,
                        voice_text_state="authored",
                        voice_delivery_state="generated",
                        planner_ms=(time.monotonic_ns() - self._started_ns) / 1_000_000,
                        model_first_token_ms=(
                            (self._first_token_ns - self._started_ns) / 1_000_000
                            if self._first_token_ns is not None
                            else None
                        ),
                    )
                    await self.push_frame(planned_frame, direction)
            self._reset_turn()
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)
