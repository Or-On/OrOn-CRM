"""Per-call usage capture.

Usage comes from pipecat's own `MetricsFrame`, not from service callbacks:
`GoogleVertexLLMService` never fires `on_llm_usage`, so a callback-based tracker
reports LLM cost as zero and looks healthy doing it.

Latency is NOT here and is no longer on the row at all: pipecat's turn spans
carry it per turn, attached to the text that produced it.
"""

from oron_common import CallUsage
from pipecat.frames.frames import MetricsFrame, TTSAudioRawFrame
from pipecat.metrics.metrics import LLMUsageMetricsData, STTUsageMetricsData, TTSUsageMetricsData
from pipecat.observers.base_observer import BaseObserver, FramePushed


class UsageObserver(BaseObserver):
    """Accumulates one call's usage. Register via `PipelineWorker(observers=[...])`."""

    def __init__(self, usage: CallUsage):
        super().__init__()
        self._usage = usage
        # One frame is pushed across several processor links, so it is observed
        # once per hop downstream of whatever emitted it; without deduping, every
        # column inflates silently by a factor that just tracks pipeline position.
        # Keyed by frame.id — not id(frame), whose address CPython recycles onto
        # the next frame, erasing it as "already seen".
        self._counted: set[int] = set()

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        if not isinstance(frame, MetricsFrame | TTSAudioRawFrame) or frame.id in self._counted:
            return
        self._counted.add(frame.id)

        if isinstance(frame, MetricsFrame):
            for metric in frame.data:
                # The model is taken from the frame, not from config: it is
                # env-configurable, so only the frame says what actually billed.
                if isinstance(metric, TTSUsageMetricsData):
                    self._usage.tts_model = metric.model or self._usage.tts_model
                    self._usage.tts_characters += int(metric.value or 0)
                elif isinstance(metric, STTUsageMetricsData):
                    # Reported incrementally since the last report, so this
                    # accumulates like the token counts rather than replacing.
                    self._usage.stt_audio_seconds += metric.value.audio_seconds
                elif isinstance(metric, LLMUsageMetricsData):
                    self._usage.llm_model = metric.model or self._usage.llm_model
                    tokens = metric.value
                    self._usage.llm_prompt_tokens += tokens.prompt_tokens or 0
                    self._usage.llm_cached_prompt_tokens += tokens.cache_read_input_tokens or 0
                    self._usage.llm_completion_tokens += tokens.completion_tokens or 0
        else:
            # 16-bit PCM
            self._usage.tts_audio_seconds += len(frame.audio) / (
                frame.sample_rate * frame.num_channels * 2
            )
