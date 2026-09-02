"""Release the opening clause of a turn to TTS without waiting for its sentence.

Only the FIRST chunk of a turn gates the audio, so it is the only one split.
Every later chunk stays a whole sentence: each opens its own TTS session, so
splitting those adds a gap mid-answer and buys nothing the caller can hear.
"""

from pipecat.utils.text.base_text_aggregator import Aggregation, AggregationType
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

# Comma and the dashes an LLM actually emits mid-sentence. Not the colon: it
# introduces a list, and a list read without its items is a false start.
CLAUSE_MARKS = ",;،—–"


class FirstClauseAggregator(SimpleTextAggregator):
    """Sentence aggregation, except the turn's opening clause leaves early.

    Subclasses rather than replaces `SimpleTextAggregator` so TOKEN mode, the
    end-of-sentence lookahead and `flush()` all keep pipecat's behaviour — a
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
