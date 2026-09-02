"""How the turn was taken: was the bot talked over, and by a person or a noise?

Does not belong with usage and cost — a bot that talks over people is not a
billing problem, and `UsageObserver` had accreted these counters only because it
was already watching the frames.

Not the same count as pipecat's `turn.was_interrupted`, and deliberately so.
`MinWordsUserTurnStartStrategy` gates the interruption before a turn ever starts,
so pipecat sees only the worded ones. This counts every `UserStartedSpeakingFrame`
over a speaking bot — the gap between the two numbers IS what the gate suppressed.
"""

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pydantic import BaseModel

_NS_PER_MS = 1_000_000
_S_TO_MS = 1_000
# How long an interruption waits for a transcribed word before it is counted
# wordless. Not a knob: no call has ever needed a different value.
_INTERRUPT_WORD_WINDOW_NS = 1500 * _NS_PER_MS


class TurnTaking(BaseModel):
    """One call's interruption counts.

    Logged, not persisted, and that is a judgement about statistics rather than
    tidiness. Interruptions are rare — order 1-2 per call — so telling a real
    change from noise needs ~100 events per arm, i.e. tens of calls per arm. At
    the volumes this project runs, the recordings answer "did noise cut the bot
    off" and a count cannot. Columns become worth their migration when there is
    enough traffic for a rate to move outside its own variance.
    """

    interruptions: int = 0
    # Named for what is counted, not for what it is taken to mean: an
    # interruption after which no word was transcribed inside the window. Noise
    # stopping the bot is the case of interest, but a real word STT missed lands
    # here too, and a transcribed backchannel ("אה") does not.
    wordless_interruptions: int = 0


class TurnTakingObserver(BaseObserver):
    """Counts interruptions, and how many produced no words.

    The pair is the only instrument for "does the bot get talked over, and was
    it a person or a noise?" — so it is what says whether an interruption gate
    or a noise filter did anything — but see `TurnTaking` on why that comparison
    needs far more calls than one batch. Register via
    `PipelineWorker(observers=[…])` and call `settle_open_interruption()` once at
    call end.
    """

    def __init__(self, turn_taking: TurnTaking):
        super().__init__()
        self._turn_taking = turn_taking
        # broadcast_frame() emits the same interruption twice, upstream and
        # downstream, with different ids. Keyed by frame.id, not id(frame),
        # whose address CPython recycles onto the next frame.
        self._counted: set[int] = set()
        self._bot_speaking = False
        self._pending_ns: int | None = None

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        self.settle_open_interruption(data.timestamp)
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
        elif (
            isinstance(frame, UserStartedSpeakingFrame)
            and self._bot_speaking
            and frame.id not in self._counted
        ):
            self._counted.add(frame.id)
            if frame.broadcast_sibling_id is not None:
                self._counted.add(frame.broadcast_sibling_id)
            # A second interruption cannot resolve the first's pending slot, so
            # settle it before it is overwritten.
            if self._pending_ns is not None:
                self._turn_taking.wordless_interruptions += 1
            self._turn_taking.interruptions += 1
            self._pending_ns = data.timestamp
        elif (
            isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame))
            and self._pending_ns is not None
            and frame.text.split()
        ):
            self._pending_ns = None

    def settle_open_interruption(self, now_ns: int | None = None) -> None:
        """Count an open interruption as wordless once its window has passed.

        `now_ns=None` means expired by definition — the call is over, so no
        further frame can bring a word.
        """
        if self._pending_ns is None:
            return
        if now_ns is not None and now_ns - self._pending_ns <= _INTERRUPT_WORD_WINDOW_NS:
            return
        self._turn_taking.wordless_interruptions += 1
        self._pending_ns = None
