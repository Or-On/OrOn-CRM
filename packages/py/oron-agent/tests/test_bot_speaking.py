"""The bot-speaking gate that keeps the agent's own voice out of the caller-gender
classifier.

Observed 2026-07-24: a male caller was classified FEMALE at 0.94 confidence.
The classifier listens to the transport INPUT, and the bot's voice echoing back
through the caller's speakers is inbound audio like any other — except it is the
bot's (female) voice, and the verdict latches for the whole call.
"""

from oron_agent.bot_speaking import BotSpeakingObserver
from oron_agent.pipeline import build_agent_processors
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InputAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameDirection


async def _send(observer: BotSpeakingObserver, frame):
    async def noop(f, d=FrameDirection.DOWNSTREAM):
        return None

    observer.push_frame = noop  # type: ignore[method-assign]
    await observer.process_frame(frame, FrameDirection.DOWNSTREAM)


async def test_observer_tracks_the_bot_speaking_window():
    obs = BotSpeakingObserver()
    assert obs.is_speaking is False

    await _send(obs, BotStartedSpeakingFrame())
    assert obs.is_speaking is True

    await _send(obs, BotStoppedSpeakingFrame())
    assert obs.is_speaking is False


async def test_classifier_ignores_inbound_audio_while_the_bot_speaks():
    """The gate itself: audio arriving mid-bot-turn must not reach the buffer."""
    from oron_hebrew.gender_audio_ecapa import GenderClassifierProcessor

    speaking = {"value": True}
    clf = GenderClassifierProcessor(is_bot_speaking=lambda: speaking["value"])
    if not clf.available:  # model unavailable in this environment
        return

    async def noop(f, d=FrameDirection.DOWNSTREAM):
        return None

    clf.push_frame = noop  # type: ignore[method-assign]
    audio = InputAudioRawFrame(audio=b"\x01\x00" * 1600, sample_rate=16000, num_channels=1)

    await clf.process_frame(audio, FrameDirection.DOWNSTREAM)
    assert len(clf._audio_buffer) == 0, "bot audio must never enter the buffer"

    # With the bot quiet the VAD decides, and silence-like PCM stays out too —
    # what matters here is that the bot-speaking gate ran first.
    speaking["value"] = False
    await clf.process_frame(audio, FrameDirection.DOWNSTREAM)


def test_the_observer_sits_downstream_of_the_transport_output():
    """It can only see BotStarted/StoppedSpeakingFrame if it is after the output."""
    procs = build_agent_processors(
        "IN", "STT", "USER", "LLM", "TTS", "OUT", "ASSISTANT", bot_speaking="OBS"
    )
    assert procs.index("OBS") > procs.index("OUT")
    assert procs.index("OBS") < procs.index("ASSISTANT")
