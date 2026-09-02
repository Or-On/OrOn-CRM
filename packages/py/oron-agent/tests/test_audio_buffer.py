"""The recorder's two channels must stay on one timeline.

Pins the drift that put the bot's voice into the caller channel of a real
recording, several seconds away from any agent audio.
"""

import pytest
from oron_agent.audio_buffer import AlignedAudioBufferProcessor
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor

_SR = 16000
_FRAME_SECONDS = 0.02
_FRAME_BYTES = int(_SR * _FRAME_SECONDS) * 2


def _audio(cls):
    return cls(audio=b"\x01\x00" * int(_SR * _FRAME_SECONDS), sample_rate=_SR, num_channels=1)


async def _record(processor, audio_cls, frames: int):
    """Both parties flagged speaking, then one of them actually sends audio.

    This is the case that drifts, and the one a real call hits constantly: the
    caller's mic picks up the bot, so `UserStartedSpeakingFrame` fires while the
    bot is still talking. The base class then skips the sync for the silent
    channel and never repays it.

    Drives `_process_recording` directly: pipecat's base `process_frame` wants a
    live TaskManager, and the sync rule is what is under test — the same bypass
    `test_idle.py` uses.
    """
    processor._recording = True
    processor._sample_rate = _SR
    processor._audio_buffer_size_1s = _SR * 2
    await processor._process_recording(UserStartedSpeakingFrame())
    await processor._process_recording(BotStartedSpeakingFrame())
    for _ in range(frames):
        await processor._process_recording(_audio(audio_cls))


@pytest.mark.parametrize("audio_cls", [InputAudioRawFrame, OutputAudioRawFrame])
async def test_channels_stay_aligned_through_overlap(audio_cls):
    processor = AlignedAudioBufferProcessor(num_channels=2, sample_rate=_SR)
    await _record(processor, audio_cls, frames=25)

    # One frame, not zero: the sync pads the other buffer to this one's length
    # BEFORE appending, so the quiet channel always trails by the newest frame.
    drift = abs(len(processor._user_audio_buffer) - len(processor._bot_audio_buffer))
    assert drift <= _FRAME_BYTES


async def test_the_base_class_is_what_drifts():
    """Guards against the subclass quietly becoming a no-op: if upstream ever
    stops skipping the sync, this fails and the subclass can be deleted."""
    processor = AudioBufferProcessor(num_channels=2, sample_rate=_SR)
    await _record(processor, InputAudioRawFrame, frames=25)

    drift = len(processor._user_audio_buffer) - len(processor._bot_audio_buffer)
    assert drift > 10 * _FRAME_BYTES, "upstream no longer drifts; delete the subclass"


def test_turn_audio_is_refused_rather_than_silently_broken():
    with pytest.raises(ValueError):
        AlignedAudioBufferProcessor(num_channels=2, enable_turn_audio=True)
