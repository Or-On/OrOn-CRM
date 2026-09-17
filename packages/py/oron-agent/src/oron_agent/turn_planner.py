"""Stream model text to speech at natural semantic boundaries.

The chunker waits for a sentence, a substantial clause, or a bounded amount of
text. It never sends individual model tokens to TTS, and it does not wait for a
complete multi-sentence answer before the first synthesis request.
"""

from __future__ import annotations

import time

from pipecat.frames.frames import (
    AggregatedTextFrame,
    Frame,
    FunctionCallsStartedFrame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.utils.text.base_text_aggregator import AggregationType

_SENTENCE_MARKS = frozenset(".!?؟\n")
_CLAUSE_MARKS = frozenset(",;،—–")


class NaturalTurnChunker(FrameProcessor):
    """Emit cancellable, generation-tagged speech chunks from one LLM stream."""

    def __init__(
        self,
        *,
        min_clause_chars: int = 48,
        max_chunk_chars: int = 220,
        max_turn_chars: int = 8192,
        **kwargs,
    ):
        super().__init__(**kwargs)
        if not 8 <= min_clause_chars <= max_chunk_chars <= max_turn_chars:
            raise ValueError("invalid conversational chunk limits")
        self._min_clause_chars = min_clause_chars
        self._max_chunk_chars = max_chunk_chars
        self._max_turn_chars = max_turn_chars
        self._generation = 0
        self._started_ns = 0
        self._first_token_ns: int | None = None
        self._buffer = ""
        self._total_chars = 0
        self._collecting = False
        self._function_call_started = False
        self._pending_function_call = False
        self._skip_tts = False
        self._emitted = False

    def _reset_turn(self) -> None:
        self._buffer = ""
        self._total_chars = 0
        self._collecting = False
        self._function_call_started = False
        self._skip_tts = False
        self._emitted = False
        self._first_token_ns = None

    @staticmethod
    def _continues_a_token(text: str, index: int, *, final: bool) -> bool:
        """True when the mark at `index` sits inside a token rather than ending a
        sentence or clause.

        A price streams in as "29." then "90": splitting there sends two TTS
        chunks, so the caller hears "twenty-nine" — pause — "ninety", and the
        downstream Hebrew currency normalizer never sees the whole value either.
        The same shape covers "1.2.3", "16.09.2026" and "example.com".

        The test is what follows the mark, because a sentence never resumes with
        a letter or digit and no space in between. When nothing follows it yet,
        only a digit before the mark is worth waiting a token for — making every
        ordinary sentence end wait for lookahead would spend first-audio latency
        on the rare case. At the end of a turn nothing more is coming, so the
        mark is a real boundary either way.
        """
        if text[index] == "\n":
            return False  # a line break is the one mark that is never intra-token
        following = text[index + 1 : index + 2]
        if following:
            # "..." and "?!" end at their last mark; splitting inside the run
            # would open the next chunk with stray punctuation.
            return following.isalnum() or (following in _SENTENCE_MARKS and following != "\n")
        return index > 0 and text[index - 1].isdigit() and not final

    def _next_boundary(self, *, final: bool) -> int | None:
        text = self._buffer
        if not text:
            return None
        # Evidence selectors must remain one complete JSON object for the
        # downstream validator. Ordinary conversational text streams.
        if text.lstrip().startswith("{"):
            return len(text) if final else None
        for index, char in enumerate(text):
            length = index + 1
            if char in _SENTENCE_MARKS and length >= 8:
                if self._continues_a_token(text, index, final=final):
                    continue
                return length
            if char in _CLAUSE_MARKS and length >= self._min_clause_chars:
                if self._continues_a_token(text, index, final=final):
                    continue
                return length
        if len(text) >= self._max_chunk_chars:
            split = text.rfind(" ", self._min_clause_chars, self._max_chunk_chars + 1)
            return split + 1 if split >= self._min_clause_chars else self._max_chunk_chars
        return len(text) if final else None

    async def _flush_ready(self, *, final: bool) -> None:
        while (boundary := self._next_boundary(final=final)) is not None:
            chunk, self._buffer = self._buffer[:boundary], self._buffer[boundary:]
            chunk = chunk.strip()
            if not chunk:
                if not self._buffer:
                    return
                continue
            planned = AggregatedTextFrame(
                chunk,
                AggregationType.SENTENCE,
                raw_text=chunk,
            )
            planned.metadata.update(
                voice_generation=self._generation,
                voice_text_state="authored",
                voice_delivery_state="streaming_chunk",
                planner_ms=(time.monotonic_ns() - self._started_ns) / 1_000_000,
                model_first_token_ms=(
                    (self._first_token_ns - self._started_ns) / 1_000_000
                    if self._first_token_ns is not None
                    else None
                ),
            )
            self._emitted = True
            await self.push_frame(planned, FrameDirection.DOWNSTREAM)
            if not final:
                # One chunk per token arrival keeps ordering fair while the
                # provider/TTS tasks run; later text will trigger the next flush.
                return

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction is not FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, InterruptionFrame):
            self._generation += 1
            self._reset_turn()
            self._pending_function_call = False
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, LLMFullResponseStartFrame):
            pending = self._pending_function_call
            self._reset_turn()
            self._function_call_started = pending
            self._pending_function_call = False
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
                return
            self._total_chars += len(frame.text)
            if self._total_chars <= self._max_turn_chars:
                self._buffer += frame.text
                await self._flush_ready(final=False)
            return
        if isinstance(frame, FunctionCallsStartedFrame):
            if self._collecting:
                self._function_call_started = True
                self._buffer = ""
            else:
                self._pending_function_call = True
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, LLMTextFrame):
            # Never let a late token from a cancelled generation bypass the
            # chunk validator and ownership gates.
            return
        if isinstance(frame, LLMFullResponseEndFrame) and self._collecting:
            if not self._skip_tts and not self._function_call_started:
                if self._total_chars > self._max_turn_chars:
                    self._buffer = (
                        "That answer became too long for a voice reply. "
                        "What should we focus on first?"
                    )
                elif not self._buffer.strip() and not self._emitted:
                    self._buffer = (
                        "Sorry, I lost the thread for a moment. Could you say that again?"
                    )
                await self._flush_ready(final=True)
            self._reset_turn()
            self._pending_function_call = False
            await self.push_frame(frame, direction)
            return
        await self.push_frame(frame, direction)


# Retain the import name used by the existing pipeline while removing the old
# Hebrew-specific behavior from the implementation.
HebrewTurnPlanner = NaturalTurnChunker
