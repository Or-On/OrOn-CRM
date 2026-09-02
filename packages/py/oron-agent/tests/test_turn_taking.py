"""Turn-taking: who interrupted whom, and whether anyone actually spoke.

Deliberately not in test_cost/test_latency. A bot that talks over people is
neither a billing problem nor a slow one.
"""

from oron_agent.turn_taking import TurnTaking, TurnTakingObserver
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
)

MS = 1_000_000


def _pushed(frame, at_ms: float = 0.0):
    return type("FramePushed", (), {"frame": frame, "timestamp": int(at_ms * MS)})()


def _observer() -> tuple[TurnTakingObserver, TurnTaking]:
    tt = TurnTaking()
    return TurnTakingObserver(tt), tt


async def _bot_interrupted_at(obs, *, at_ms: float) -> None:
    await obs.on_push_frame(_pushed(BotStartedSpeakingFrame(), 0))
    await obs.on_push_frame(_pushed(UserStartedSpeakingFrame(), at_ms))


async def test_interruption_followed_by_words_is_not_false():
    obs, tt = _observer()
    await _bot_interrupted_at(obs, at_ms=100)
    await obs.on_push_frame(
        _pushed(TranscriptionFrame(user_id="u", text="לא מעוניין", timestamp=""), 400)
    )
    obs.settle_open_interruption()

    assert tt.interruptions == 1
    assert tt.wordless_interruptions == 0


async def test_interruption_with_no_words_is_false():
    obs, tt = _observer()
    await _bot_interrupted_at(obs, at_ms=100)
    obs.settle_open_interruption()

    assert tt.interruptions == 1
    assert tt.wordless_interruptions == 1


async def test_speaking_while_the_bot_is_silent_is_not_an_interruption():
    obs, tt = _observer()
    await obs.on_push_frame(_pushed(BotStartedSpeakingFrame(), 0))
    await obs.on_push_frame(_pushed(BotStoppedSpeakingFrame(), 50))
    await obs.on_push_frame(_pushed(UserStartedSpeakingFrame(), 100))
    obs.settle_open_interruption()

    assert tt.interruptions == 0


async def test_empty_transcription_does_not_rescue_an_interruption():
    """Soniox emits empty interims; they are not evidence anyone spoke."""
    obs, tt = _observer()
    await _bot_interrupted_at(obs, at_ms=100)
    await obs.on_push_frame(
        _pushed(InterimTranscriptionFrame(user_id="u", text="   ", timestamp=""), 300)
    )
    obs.settle_open_interruption()

    assert tt.wordless_interruptions == 1


async def test_an_interruption_followed_by_silence_expires_on_a_later_frame():
    """The per-frame sweep is the only thing that classifies this; no explicit flush."""
    obs, tt = _observer()
    await _bot_interrupted_at(obs, at_ms=100)
    await obs.on_push_frame(_pushed(BotStoppedSpeakingFrame(), 2000))

    assert tt.wordless_interruptions == 1


async def test_a_second_interruption_before_the_first_resolves_settles_both_false():
    obs, tt = _observer()
    await obs.on_push_frame(_pushed(BotStartedSpeakingFrame(), 0))
    await obs.on_push_frame(_pushed(UserStartedSpeakingFrame(), 100))
    await obs.on_push_frame(_pushed(UserStartedSpeakingFrame(), 200))
    obs.settle_open_interruption()

    assert tt.interruptions == 2
    assert tt.wordless_interruptions == 2


def _broadcast_pair() -> tuple[UserStartedSpeakingFrame, UserStartedSpeakingFrame]:
    """What `FrameProcessor.broadcast_frame` really emits: two DISTINCT instances
    with different ids, linked only by broadcast_sibling_id. Deduping on frame.id
    alone catches neither, which double-counted every interruption."""
    downstream, upstream = UserStartedSpeakingFrame(), UserStartedSpeakingFrame()
    downstream.broadcast_sibling_id = upstream.id
    upstream.broadcast_sibling_id = downstream.id
    return downstream, upstream


async def test_a_broadcast_interruption_counts_once_not_twice():
    obs, tt = _observer()
    await obs.on_push_frame(_pushed(BotStartedSpeakingFrame(), 0))
    downstream, upstream = _broadcast_pair()
    assert downstream.id != upstream.id
    await obs.on_push_frame(_pushed(downstream, 100))
    await obs.on_push_frame(_pushed(upstream, 100))

    assert tt.interruptions == 1


async def test_a_real_broadcast_barge_in_is_not_recorded_as_false():
    """The sibling used to find the pending slot still set and settle it false, so
    a genuine barge-in with words reported interruptions=2, false=1."""
    obs, tt = _observer()
    await obs.on_push_frame(_pushed(BotStartedSpeakingFrame(), 0))
    downstream, upstream = _broadcast_pair()
    await obs.on_push_frame(_pushed(downstream, 100))
    await obs.on_push_frame(_pushed(upstream, 100))
    await obs.on_push_frame(
        _pushed(TranscriptionFrame(user_id="u", text="לא מעוניין", timestamp=""), 400)
    )
    obs.settle_open_interruption()

    assert tt.interruptions == 1
    assert tt.wordless_interruptions == 0
