from unittest.mock import AsyncMock

import numpy as np
import pytest
from oron_agent.tts_trim import TrimLeadingSilence
from pipecat.frames.frames import (
    InterruptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameDirection

SR = 24000


def _pcm(seconds: float, *, silent: bool) -> bytes:
    n = int(SR * seconds)
    if silent:
        return np.zeros(n, dtype=np.int16).tobytes()
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 220 * t) * 12000).astype(np.int16).tobytes()


async def _run(frames) -> list:
    trim = TrimLeadingSilence()
    out = []

    async def _capture(f, d=FrameDirection.DOWNSTREAM):
        out.append(f)

    trim.push_frame = _capture  # type: ignore[method-assign]
    for f in frames:
        await trim.process_frame(f, FrameDirection.DOWNSTREAM)
    return out


def _audio_bytes(frames) -> bytes:
    return b"".join(f.audio for f in frames if isinstance(f, TTSAudioRawFrame))


@pytest.fixture
def speech() -> bytes:
    return _pcm(0.5, silent=False)


async def test_leading_silence_is_dropped(speech):
    """0.35s of silence in front of speech — the measured Gemini TTS shape."""
    head = _pcm(0.35, silent=True)
    out = await _run(
        [
            TTSStartedFrame(),
            TTSAudioRawFrame(audio=head + speech, sample_rate=SR, num_channels=1),
            TTSStoppedFrame(),
        ]
    )
    emitted = _audio_bytes(out)
    # ALL the silence goes, not merely some of it — a half-trim must fail here.
    slack = int(SR * 0.06) * 2  # onset confirmation needs a little audio
    assert len(speech) - slack <= len(emitted) <= len(speech) + slack


async def test_trimmed_audio_preserves_ownership_generation(speech):
    frame = TTSAudioRawFrame(audio=speech, sample_rate=SR, num_channels=1, context_id="current")
    frame.metadata["ownership_generation"] = 3
    out = await _run(
        [TTSStartedFrame(context_id="current"), frame, TTSStoppedFrame(context_id="current")]
    )
    emitted = [item for item in out if isinstance(item, TTSAudioRawFrame)]
    assert emitted and all(item.metadata["ownership_generation"] == 3 for item in emitted)


async def test_silence_split_across_frames_is_still_dropped(speech):
    """The silent head can span several chunks before any speech arrives."""
    out = await _run(
        [
            TTSStartedFrame(),
            TTSAudioRawFrame(audio=_pcm(0.2, silent=True), sample_rate=SR, num_channels=1),
            TTSAudioRawFrame(audio=_pcm(0.2, silent=True), sample_rate=SR, num_channels=1),
            TTSAudioRawFrame(audio=speech, sample_rate=SR, num_channels=1),
            TTSStoppedFrame(),
        ]
    )
    slack = int(SR * 0.06) * 2
    assert len(speech) - slack <= len(_audio_bytes(out)) <= len(speech) + slack


async def test_audio_after_the_first_response_passes_through_untouched(speech):
    """Only the head is trimmed — silence mid-response is speech rhythm, not lag."""
    out = await _run(
        [
            TTSStartedFrame(),
            TTSAudioRawFrame(audio=speech, sample_rate=SR, num_channels=1),
            TTSAudioRawFrame(audio=_pcm(0.3, silent=True), sample_rate=SR, num_channels=1),
            TTSStoppedFrame(),
        ]
    )
    assert len(_audio_bytes(out)) >= len(speech) + len(_pcm(0.3, silent=True)) * 0.9


async def test_an_all_silent_response_still_reaches_the_caller():
    """No onset ever confirmed: pass it on rather than swallowing the response."""
    out = await _run(
        [
            TTSStartedFrame(),
            TTSAudioRawFrame(audio=_pcm(0.5, silent=True), sample_rate=SR, num_channels=1),
            TTSStoppedFrame(),
        ]
    )
    assert _audio_bytes(out)


async def test_interruption_discards_buffer_and_stale_audio_context(monkeypatch):
    trim = TrimLeadingSilence()
    trim.push_frame = AsyncMock()
    monkeypatch.setattr(trim, "_start_interruption", AsyncMock())
    for frame in [
        TTSStartedFrame(context_id="old"),
        TTSAudioRawFrame(
            audio=_pcm(0.3, silent=True), sample_rate=SR, num_channels=1, context_id="old"
        ),
        InterruptionFrame(),
        TTSStoppedFrame(context_id="old"),
        TTSStartedFrame(context_id="new"),
        TTSAudioRawFrame(
            audio=_pcm(0.3, silent=False), sample_rate=SR, num_channels=1, context_id="old"
        ),
        TTSAudioRawFrame(
            audio=_pcm(0.3, silent=False), sample_rate=SR, num_channels=1, context_id="new"
        ),
        TTSStoppedFrame(context_id="new"),
    ]:
        await trim.process_frame(frame, FrameDirection.DOWNSTREAM)
    audio = [
        call.args[0]
        for call in trim.push_frame.call_args_list
        if isinstance(call.args[0], TTSAudioRawFrame)
    ]
    assert audio and all(frame.context_id == "new" for frame in audio)


async def test_onset_preroll_keeps_soft_initial_audio(monkeypatch):
    # A deterministic onset fixture proves sample retention, not intelligibility.
    monkeypatch.setattr("oron_agent.tts_trim.detect_speech_onset", lambda *_: int(SR * 0.1))
    audio = _pcm(0.3, silent=False)
    out = await _run(
        [
            TTSStartedFrame(),
            TTSAudioRawFrame(audio=audio, sample_rate=SR, num_channels=1),
            TTSStoppedFrame(),
        ]
    )
    assert _audio_bytes(out) == audio[int(SR * 0.06) * 2 :]
