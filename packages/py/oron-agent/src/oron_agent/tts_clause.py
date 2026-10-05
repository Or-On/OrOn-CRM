"""Streaming sentence boundaries without model files or the NLTK runtime.

Only the FIRST chunk of a turn gates the audio, so it is the only one split.
Every later chunk stays a whole sentence: each opens its own TTS session, so
splitting those adds a gap mid-answer and buys nothing the caller can hear.
"""

# The parallel-channel adapter below adapts Pipecat 1.11's sequencer algorithm.
# Copyright (c) 2024-2026, Daily. All rights reserved.
# Redistribution and use in source and binary forms, with or without modification,
# are permitted provided that the following conditions are met:
# 1. Redistributions of source code must retain the above copyright notice, this
#    list of conditions and the following disclaimer.
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
# DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
# FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
# DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
# SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED
# AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
# (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
# SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

import re
from collections.abc import AsyncIterator

from pipecat.frames.frames import AggregatedTextFrame, Frame
from pipecat.utils.context.aggregated_frame_sequencer import (
    AggregatedFrameSequencer,
    _ParallelAggregation,
    _ParallelSentenceAggregator,
    _StreamingContext,
)
from pipecat.utils.text.base_text_aggregator import Aggregation, AggregationType
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

# Comma and the dashes an LLM actually emits mid-sentence. Not the colon: it
# introduces a list, and a list read without its items is a false start.
CLAUSE_MARKS = ",;،—–"
_END_MARKS = ".!?;…。！？؟؛"
_CLOSING_MARKS = "\"'”’»)]}״"
_BOUNDARY = re.compile(
    rf"(?<![{re.escape(_END_MARKS)}])"
    rf"(?P<ending>[{re.escape(_END_MARKS)}]+)[{re.escape(_CLOSING_MARKS)}]*(?=\s+\S)"
)
_ABBREVIATIONS = frozenset(
    {
        "mr",
        "mrs",
        "ms",
        "dr",
        "prof",
        "sr",
        "jr",
        "st",
        "vs",
        "etc",
        "e.g",
        "i.e",
        "fig",
        "no",
        "inc",
        "ltd",
        "co",
        "dept",
        "approx",
        "פרופ",
        "מס",
        "עמ",
    }
)


def sentence_boundary(text: str, *, start: int = 0) -> int:
    """Find a conservative boundary confirmed by a following word.

    A separator is required: punctuation inside decimals, versions, email
    addresses, URLs, and paths never separates those tokens. Ambiguous initials
    and abbreviations stay with their following words. End-of-turn flush emits
    anything left, so conservative decisions delay speech rather than lose text.
    """
    for match in _BOUNDARY.finditer(text, start):
        ending = match.group("ending")
        if ending == ".":
            # Examine only this token, not an ever-growing sentence prefix.
            # Dotted initials can otherwise make repeated rejected boundaries
            # very expensive on the speech pipeline's event loop.
            token_start = match.start()
            while token_start and (
                text[token_start - 1].isalnum() or text[token_start - 1] in "_."
            ):
                token_start -= 1
            token = text[token_start : match.start()].strip(".")
            if token.casefold() in _ABBREVIATIONS:
                continue
            if re.fullmatch(r"(?:[A-Za-z]\.)*[A-Z]", token):
                continue
            following_start = match.end()
            while text[following_start].isspace():
                following_start += 1
            if (
                match.start()
                and text[match.start() - 1].isdigit()
                and text[following_start].isdigit()
            ):
                continue
        return match.end()
    return 0


class SentenceAggregator(SimpleTextAggregator):
    """Retain Pipecat's TOKEN/flush/reset lifecycle; replace its NLTK hook."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._sentence_scan_offset = 0

    async def _check_sentence_with_lookahead(self, char: str) -> Aggregation | None:
        if char in _END_MARKS:
            self._needs_lookahead = True
            return None
        if not self._needs_lookahead or char.isspace() or char in _CLOSING_MARKS:
            return None
        self._needs_lookahead = False
        boundary = sentence_boundary(self._text, start=self._sentence_scan_offset)
        if not boundary:
            # The new non-punctuation character permanently disambiguates all
            # earlier candidates. Never rescan those rejected abbreviations.
            self._sentence_scan_offset = len(self._text)
            return None
        result, self._text = self._text[:boundary], self._text[boundary:]
        self._sentence_scan_offset = 0
        return Aggregation(text=result.strip(" "), type=AggregationType.SENTENCE)

    async def reset(self):
        await super().reset()
        self._sentence_scan_offset = 0

    async def handle_interruption(self):
        await super().handle_interruption()
        self._sentence_scan_offset = 0


class _RuntimeParallelAggregator(_ParallelSentenceAggregator):
    """Keep all three TOKEN channels aligned without either SDK NLTK call.

    Pipecat 1.11 has no aggregator factory. Its parallel aggregator calls the
    NLTK matcher both inside SimpleTextAggregator and again when slicing aligned
    channels. Override both per instance; preserve its token-boundary fallback
    when transforms change channel lengths, plus inherited flush/interruption.
    """

    def __init__(self):
        super().__init__()
        self._aggregator = SentenceAggregator(aggregation_type=AggregationType.SENTENCE)

    async def aggregate(
        self, tts_text: str, llm_text: str, user_facing_text: str
    ) -> AsyncIterator[_ParallelAggregation]:
        identical = tts_text == llm_text == user_facing_text
        boundaries = 0
        async for _ in self._aggregator.aggregate(tts_text):
            boundaries += 1
        if boundaries and self._aligned and identical:
            combined = self._tts + tts_text
            offset = 0
            for _ in range(boundaries):
                boundary = sentence_boundary(combined[offset:])
                if not boundary:
                    break
                sentence = combined[offset : offset + boundary]
                yield _ParallelAggregation(sentence, sentence, sentence)
                offset += boundary
            self._tts = self._llm = self._user = combined[offset:]
            self._aligned = True
            return
        if boundaries and (self._tts or self._llm or self._user):
            yield _ParallelAggregation(self._tts, self._llm, self._user)
            self._tts = self._llm = self._user = ""
        self._tts += tts_text
        self._llm += llm_text
        self._user += user_facing_text
        self._aligned = self._tts == self._llm == self._user == self._aggregator._text


class SentenceFrameSequencer(AggregatedFrameSequencer):
    """Use an app-owned sentence aggregator in each isolated TOKEN context.

    All ordering, tracking, skipped-frame handling and context retirement remain
    Pipecat's. This pinned private seam is exercised by the image smoke test.
    """

    async def register_spoken(
        self,
        frame: AggregatedTextFrame,
        context_id: str,
        tts_text: str,
        append_to_context: bool,
        build_tracker: bool = True,
        includes_inter_frame_spaces: bool = False,
    ) -> list[Frame]:
        if not self._streaming:
            return await super().register_spoken(
                frame,
                context_id,
                tts_text,
                append_to_context,
                build_tracker,
                includes_inter_frame_spaces,
            )
        state = self._streaming_contexts.get(context_id)
        if state is None:
            state = _StreamingContext(
                _RuntimeParallelAggregator(), append_to_context, build_tracker
            )
            self._streaming_contexts[context_id] = state
        frames: list[Frame] = []
        async for aggregation in state.aggregator.aggregate(
            tts_text, frame.raw_text or frame.text, frame.text
        ):
            frames.extend(
                self._promote(aggregation, context_id, state.append_to_context, state.build_tracker)
            )
        return frames


class FirstClauseAggregator(SentenceAggregator):
    """Sentence aggregation, except the turn's opening clause leaves early.

    Shares `SentenceAggregator` so TOKEN mode, sentence lookahead and `flush()`
    retain their lifecycle without loading model files. A
    hand-rolled loop misses the lookahead and splits `"29."` from a following
    `"90"`, and ignores the aggregation type entirely.

    `min_chars` keeps a bare connective ("אז," / "well,") from being shipped as
    the opener: it would sound clipped, and spends a whole TTS session on two
    syllables.
    """

    def __init__(self, *, min_chars: int = 14, **kwargs):
        super().__init__(**kwargs)
        self._min_chars = min_chars
        self._opened = False

    async def _check_sentence_with_lookahead(self, char: str) -> Aggregation | None:
        """The per-character hook pipecat's own loop calls, so the loop is reused.

        Never reached in TOKEN mode — the parent returns before the loop — which
        is what keeps `TTS_TEXT_AGGREGATION` meaningful with this installed.
        """
        if (
            not self._opened
            and char in CLAUSE_MARKS
            and len(self._text[:-1].strip()) >= self._min_chars
        ):
            result, self._text = self._text, ""
            self._sentence_scan_offset = 0
            self._opened = True
            # The clause mark ends the chunk, so nothing is waiting on a lookahead.
            self._needs_lookahead = False
            return Aggregation(text=result.strip(" "), type=AggregationType.SENTENCE)

        aggregation = await super()._check_sentence_with_lookahead(char)
        if aggregation is not None:
            self._opened = True
        return aggregation

    async def flush(self) -> Aggregation | None:
        """End of the LLM response — and the turn boundary this relies on.

        `TTSService` never calls `reset()`, so `_opened` has to clear here or the
        flag latches after the first turn and every later opener waits again.
        """
        self._opened = False
        return await super().flush()

    async def handle_interruption(self):
        self._opened = False
        await super().handle_interruption()

    async def reset(self):
        self._opened = False
        await super().reset()
