"""Drop the silent head of each TTS response — the transport plays Gemini's ~0.3s
of leading silence out in real time, so it is latency, not padding."""

from loguru import logger
from pipecat.audio.utils import detect_speech_onset
from pipecat.frames.frames import Frame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

# An all-silent response must still reach the caller, so stop hunting eventually.
_MAX_BUFFER_SECONDS = 2.0


class TrimLeadingSilence(FrameProcessor):
    """Withhold a TTS response's opening audio until speech actually starts."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._trimming = False
        self._buffer = b""
        self._template: TTSAudioRawFrame | None = None

    async def _flush(self, direction: FrameDirection, *, offset: int = 0) -> None:
        if self._buffer and self._template is not None:
            audio = self._buffer[offset:]
            if audio:
                await self.push_frame(
                    TTSAudioRawFrame(
                        audio=audio,
                        sample_rate=self._template.sample_rate,
                        num_channels=self._template.num_channels,
                    ),
                    direction,
                )
        self._trimming = False
        self._buffer = b""
        self._template = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TTSStartedFrame):
            self._trimming = True
            self._buffer = b""
            self._template = None
        elif isinstance(frame, TTSAudioRawFrame) and self._trimming:
            self._buffer += frame.audio
            self._template = frame
            onset = detect_speech_onset(self._buffer, frame.sample_rate, frame.num_channels)
            if onset is not None:
                # onset is a per-channel SAMPLE index, not a byte offset.
                offset = onset * frame.num_channels * 2
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
