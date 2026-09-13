"""Speech-gating and buffering/retry behaviour of the ECAPA processor.

Two ported bugs are pinned here:
  * inference re-fired on every ~20ms frame while the retry window was open;
  * nothing gated on speech, so the silence at the start of a call produced a
    confident male verdict that latched for the whole call.

Classification itself is stubbed — the real model on real speech is exercised
by hand against the model card's example clips, not in CI.
"""

import asyncio
from unittest.mock import AsyncMock

import pytest
from oron_hebrew.gender_audio_ecapa import GenderClassifierProcessor
from pipecat.audio.vad.vad_analyzer import VADState
from pipecat.frames.frames import (
    InputAudioRawFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection


class _StubVAD:
    """Speech gate under test control. Real Silero is exercised separately —
    here we need to drive the gate open and shut deterministically."""

    def __init__(self, state: VADState = VADState.SPEAKING):
        self.state = state

    def set_sample_rate(self, sample_rate: int) -> None:
        pass

    async def analyze_audio(self, buffer: bytes) -> VADState:
        return self.state


_SR = 16000
_FRAME_SECONDS = 0.02  # pipecat's ~20ms audio frames


@pytest.fixture(autouse=True)
def _local_fixture_model(monkeypatch):
    """Exercise processor behavior without loading or downloading ECAPA weights."""
    monkeypatch.setattr(GenderClassifierProcessor, "_model", object())
    monkeypatch.setattr(GenderClassifierProcessor, "_model_loaded", True)
    monkeypatch.setattr(GenderClassifierProcessor, "_model_failed", False)


def _frame(seconds: float = _FRAME_SECONDS) -> InputAudioRawFrame:
    return InputAudioRawFrame(
        audio=b"\x00\x00" * int(_SR * seconds), sample_rate=_SR, num_channels=1
    )


async def _feed(proc: GenderClassifierProcessor, seconds: float) -> None:
    proc.push_frame = AsyncMock()
    # Audio is only buffered inside the caller's turn, so open one first.
    await proc.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    for _ in range(int(seconds / _FRAME_SECONDS)):
        await proc.process_frame(_frame(), FrameDirection.DOWNSTREAM)
        # The event loop MUST get a turn between frames, as it does in a live
        # call: classification runs in a task, and without a yield here it never
        # starts until every frame is already buffered — which silently makes
        # the retry-spacing assertion below unfalsifiable (it measured 1 call
        # either way).
        await asyncio.sleep(0.001)
    await asyncio.sleep(0.2)  # drain in-flight classification tasks


@pytest.fixture
def low_confidence_processor(monkeypatch):
    """A processor whose inference always comes back under the threshold, so the
    retry path stays open for the whole 1s->3s window. VAD is held open so the
    scheduling logic is what is under test."""
    proc = GenderClassifierProcessor(vad_analyzer=_StubVAD(VADState.SPEAKING))
    calls = []
    monkeypatch.setattr(
        proc, "_classify", lambda: (calls.append(1), ("male", 0.10))[1], raising=True
    )
    return proc, calls


async def test_no_inference_before_required_seconds(low_confidence_processor):
    proc, calls = low_confidence_processor
    await _feed(proc, 0.5)  # under required_seconds=1.0
    assert calls == []


async def test_low_confidence_retries_are_spaced_not_per_frame(low_confidence_processor):
    proc, calls = low_confidence_processor
    # 3s of audio = 150 frames. Unspaced, that is ~100 inferences across the
    # 1s->3s retry window; spaced at 0.5s it must be a handful.
    await _feed(proc, 3.0)
    # Measured: 101 unspaced vs 5 spaced at 0.5s over this exact input.
    assert 0 < len(calls) <= 8, f"expected a few spaced retries, got {len(calls)}"


async def test_defaults_leave_a_retry_window(low_confidence_processor):
    proc, _ = low_confidence_processor
    assert proc._required_seconds == 1.0  # fast first verdict
    assert proc._max_seconds == 3.0  # ...with room to reconsider
    assert proc._required_seconds < proc._max_seconds, "retry path must be reachable"


async def test_configured_confirmation_requires_two_matching_readings(monkeypatch):
    results = iter([("female", 0.96), ("female", 0.95)])
    observed: list[tuple[str, float]] = []
    proc = GenderClassifierProcessor(
        required_seconds=0.1,
        retry_interval_seconds=0.1,
        max_seconds=0.5,
        confidence_threshold=0.9,
        confirmation_attempts=2,
        on_gender_classified=lambda gender, confidence: _record(observed, gender, confidence),
        vad_analyzer=_StubVAD(VADState.SPEAKING),
    )
    monkeypatch.setattr(proc, "_classify", lambda: next(results), raising=True)

    await _feed(proc, 0.35)

    assert observed == [("female", 0.95)]


async def _record(target: list[tuple[str, float]], gender: str, confidence: float) -> None:
    target.append((gender, confidence))


async def test_conflicting_high_confidence_readings_do_not_latch(monkeypatch):
    results = iter([("male", 0.96), ("female", 0.97), ("female", 0.96)])
    observed: list[tuple[str, float]] = []
    proc = GenderClassifierProcessor(
        required_seconds=0.1,
        retry_interval_seconds=0.1,
        max_seconds=0.6,
        confidence_threshold=0.9,
        confirmation_attempts=2,
        on_gender_classified=lambda gender, confidence: _record(observed, gender, confidence),
        vad_analyzer=_StubVAD(VADState.SPEAKING),
    )
    monkeypatch.setattr(proc, "_classify", lambda: next(results), raising=True)

    await _feed(proc, 0.45)

    assert observed == [("female", 0.96)]


def test_confirmation_attempts_must_be_positive():
    with pytest.raises(ValueError, match="confirmation_attempts"):
        GenderClassifierProcessor(confirmation_attempts=0, vad_analyzer=_StubVAD(VADState.SPEAKING))


async def test_non_speech_never_reaches_the_classifier():
    """The regression that matters: ECAPA scores silence as male at 0.81-0.99
    confidence — above threshold, so it would be ACCEPTED and latched. The bot
    greets first, so the caller really is silent at that point, and every caller
    would be gendered male before speaking."""
    classified = []
    proc = GenderClassifierProcessor(vad_analyzer=_StubVAD(VADState.QUIET))
    proc._classify = lambda: (classified.append(1), ("male", 0.99))[1]

    await _feed(proc, 4.0)  # well past max_seconds

    assert classified == [], "non-speech audio must never be classified"
    assert proc._buffered_seconds() == 0.0
    assert not proc._classified, "a non-speech verdict must not latch"


async def test_frames_pass_through_even_when_gated():
    """Side-effect-only: STT sits in the other parallel branch, but the gate
    must not swallow frames on this one either."""
    proc = GenderClassifierProcessor(vad_analyzer=_StubVAD(VADState.QUIET))

    await _feed(proc, 0.1)

    # Count the AUDIO frames specifically: _feed also pushes the turn-start
    # frame through, and it is the audio the other branch must not lose.
    audio = [
        c.args[0]
        for c in proc.push_frame.await_args_list
        if isinstance(c.args[0], InputAudioRawFrame)
    ]
    assert len(audio) == 5  # 0.1s / 20ms


async def test_audio_while_the_bot_speaks_is_not_buffered():
    """Observed live 2026-07-26: a female verdict (0.85) for a male caller,
    logged 13ms BEFORE he first spoke — the buffer held the agent's own tail.
    The buffer is never cleared, so one contaminated stretch poisons every
    later inference."""
    speaking = True
    processor = GenderClassifierProcessor(
        required_seconds=1.0,
        vad_analyzer=_StubVAD(VADState.SPEAKING),
        is_bot_speaking=lambda: speaking,
    )
    processor._model_loaded = True

    for _ in range(10):  # bot's own turn — gated, as before
        await processor.process_frame(_frame(), FrameDirection.DOWNSTREAM)
    assert processor._buffered_seconds() == 0.0

    speaking = False
    for _ in range(10):  # 0.2s of echo tail, still the bot
        await processor.process_frame(_frame(), FrameDirection.DOWNSTREAM)
    assert processor._buffered_seconds() == 0.0, "echo tail reached the buffer"


async def test_only_audio_inside_the_callers_own_turn_is_buffered():
    """The echo guard is a timing guess; the turn boundary is not. Echo arrives
    when the caller is NOT speaking, and since the buffer is never cleared any
    leak accumulates for the whole call. Observed 2026-07-26: a male caller
    giving three one-word answers, against an agent speaking full sentences,
    came out female at 0.90."""
    processor = GenderClassifierProcessor(
        required_seconds=1.0,
        vad_analyzer=_StubVAD(VADState.SPEAKING),
        is_bot_speaking=lambda: False,
    )
    processor._model_loaded = True

    for _ in range(10):  # between turns — nobody is speaking to us
        await processor.process_frame(_frame(), FrameDirection.DOWNSTREAM)
    assert processor._buffered_seconds() == 0.0

    await processor.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    for _ in range(10):
        await processor.process_frame(_frame(), FrameDirection.DOWNSTREAM)
    assert processor._buffered_seconds() == pytest.approx(0.2, abs=0.01)

    await processor.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    for _ in range(10):  # turn over — this is the window echo arrives in
        await processor.process_frame(_frame(), FrameDirection.DOWNSTREAM)
    assert processor._buffered_seconds() == pytest.approx(0.2, abs=0.01)


def test_default_vad_is_no_stricter_than_the_pipeline():
    """The gate must not discard speech the pipeline just took a turn on.

    Pipecat's defaults are 0.7/0.6, and this processor used them: across 13
    carrier calls that dropped half the caller's speech and two calls whole.
    """
    from oron_hebrew.gender_audio_ecapa import GENDER_VAD_PARAMS
    from pipecat.audio.vad.vad_analyzer import VADParams

    # Strictly looser, not merely "no stricter": equality is the regression.
    pipecat_default = VADParams()
    assert GENDER_VAD_PARAMS.confidence < pipecat_default.confidence
    assert GENDER_VAD_PARAMS.min_volume < pipecat_default.min_volume
