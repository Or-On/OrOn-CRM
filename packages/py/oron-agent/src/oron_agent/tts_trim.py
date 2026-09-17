"""Drop the silent head of each TTS response — the transport plays Gemini's ~0.3s
of leading silence out in real time, so it is latency, not padding."""

from collections import deque

from loguru import logger
from pipecat.audio.utils import detect_speech_onset
from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

# An all-silent response must still reach the caller, so stop hunting eventually.
_MAX_BUFFER_SECONDS = 2.0
_ONSET_PREROLL_SECONDS = 0.04


class TrimLeadingSilence(FrameProcessor):
    """Withhold a TTS response's opening audio until speech actually starts."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._trimming = False
        self._buffer = b""
        self._template: TTSAudioRawFrame | None = None
        self._interrupted = False
        self._context_id: str | None = None
        self._cancelled_contexts: deque[str] = deque(maxlen=128)

    async def _flush(self, direction: FrameDirection, *, offset: int = 0) -> None:
        if self._buffer and self._template is not None:
            audio = self._buffer[offset:]
            if audio:
                trimmed = TTSAudioRawFrame(
                    audio=audio,
                    sample_rate=self._template.sample_rate,
                    num_channels=self._template.num_channels,
                    context_id=self._template.context_id,
                )
                trimmed.metadata.update(self._template.metadata)
                trimmed.transport_destination = self._template.transport_destination
                await self.push_frame(trimmed, direction)
        self._trimming = False
        self._buffer = b""
        self._template = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction is not FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, InterruptionFrame):
            if self._context_id is not None:
                # Remember each cancelled context once: the window is bounded, so
                # interruption redeliveries that arrive before the next response
                # starts must not shrink the retention every other cancelled
                # context gets. Clearing here leaves nothing for a second
                # interruption to append until TTSStartedFrame names a new one.
                self._cancelled_contexts.append(self._context_id)
                self._context_id = None
            self._trimming = False
            self._buffer = b""
            self._template = None
            self._interrupted = True
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, (TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame)):
            if frame.context_id in self._cancelled_contexts:
                return
            if self._interrupted and not isinstance(frame, TTSStartedFrame):
                return

        if isinstance(frame, TTSStartedFrame):
            self._interrupted = False
            self._context_id = frame.context_id
            self._trimming = True
            self._buffer = b""
            self._template = None
        elif isinstance(frame, TTSAudioRawFrame) and self._trimming:
            self._buffer += frame.audio
            self._template = frame
            onset = detect_speech_onset(self._buffer, frame.sample_rate, frame.num_channels)
            if onset is not None:
                # onset is a per-channel SAMPLE index, not a byte offset.
                # Keep a small prefix for soft initial consonants that onset
                # detection may put below its energy threshold.
                kept_onset = max(0, onset - int(_ONSET_PREROLL_SECONDS * frame.sample_rate))
                offset = kept_onset * frame.num_channels * 2
                logger.debug(
                    f"[TrimLeadingSilence] dropped {onset / frame.sample_rate * 1000:.0f}ms "
                    "of leading silence"
                )
                await self._flush(direction, offset=offset)
                return
            cap = int(_MAX_BUFFER_SECONDS * frame.sample_rate * max(frame.num_channels, 1) * 2)
            if len(self._buffer) >= cap:
                await self._flush(direction)
            return  # still hunting for onset — hold this audio back
        elif isinstance(frame, TTSStoppedFrame) and self._trimming:
            await self._flush(direction)  # response ended before onset was confirmed

        await self.push_frame(frame, direction)
