"""The greeting cannot be talked over; early caller speech is replayed after it.

The opener is what says who is calling and why. A caller who barges in never
hears either — and on 2026-07-27 a caller who answered mid-greeting said "הלו?"
and the bot spent the rest of the call off-script.
"""

import asyncio

import pytest
from oron_agent.hold_opener import HoldOpener
from pipecat.frames.frames import InputAudioRawFrame, TextFrame
from pipecat.processors.frame_processor import FrameDirection


def _audio() -> InputAudioRawFrame:
    return InputAudioRawFrame(audio=b"\x00" * 320, sample_rate=16000, num_channels=1)


@pytest.fixture
def collect(monkeypatch):
    """Capture what the processor lets through."""
    passed = []

    async def fake_push(self, frame, direction=FrameDirection.DOWNSTREAM):
        passed.append(frame)

    monkeypatch.setattr(HoldOpener, "push_frame", fake_push)
    return passed


async def _feed(proc, *frames):
    for f in frames:
        await proc.process_frame(f, FrameDirection.DOWNSTREAM)


async def test_caller_audio_is_held_while_the_bot_is_greeting(collect):
    proc = HoldOpener(lambda: False, max_hold_secs=30)

    await _feed(proc, _audio(), _audio(), _audio())

    assert collect == []


async def test_audio_flows_once_the_opener_has_finished(collect):
    done = {"v": False}
    proc = HoldOpener(lambda: done["v"], max_hold_secs=30)

    await _feed(proc, _audio())
    assert collect == []

    done["v"] = True
    await _feed(proc, _audio(), _audio())
    # The first answer frame is delayed until the opener completes, not lost.
    assert len(collect) == 3


async def test_the_hold_never_re_arms(collect):
    """Only the FIRST utterance is protected. Re-arming would make the whole
    call unbarge-in-able, which is worse than the problem."""
    done = {"v": True}
    proc = HoldOpener(lambda: done["v"], max_hold_secs=30)
    await _feed(proc, _audio())

    done["v"] = False  # bot starts its next turn
    await _feed(proc, _audio(), _audio())

    assert len(collect) == 3


async def test_non_audio_frames_are_never_held(collect):
    """The hold must not stall control frames — only the caller's microphone."""
    proc = HoldOpener(lambda: False, max_hold_secs=30)

    await _feed(proc, TextFrame("hello"))

    assert len(collect) == 1


async def test_a_bot_that_never_greets_does_not_stay_deaf(collect):
    """Fail open. If the flow never speaks, holding forever would leave the
    caller talking to something that cannot hear them for the whole call."""
    proc = HoldOpener(lambda: False, max_hold_secs=0.05)

    await _feed(proc, _audio())
    assert collect == []

    await asyncio.sleep(0.06)
    await _feed(proc, _audio())
    assert len(collect) == 2


async def test_buffer_is_bounded_if_the_transport_never_finishes_the_opener(collect):
    proc = HoldOpener(lambda: False, max_hold_secs=0.02)

    await _feed(proc, *[_audio() for _ in range(8)])

    assert len(proc._buffered) <= 3
    assert proc._discarded > 0
