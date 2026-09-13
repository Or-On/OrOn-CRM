"""Bounded, explicit TTS-only preview using the retained installed provider adapter.

Imported lazily by control-api[voice]; never constructs a provider at API startup.
No recording storage, STT, LLM, telephony transport, or tracing participates.
"""

from __future__ import annotations

import asyncio
import io
import logging
import unicodedata
import wave
from collections.abc import Callable
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from loguru import Record

from loguru import logger
from pipecat.clocks.system_clock import SystemClock
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    ErrorFrame,
    Frame,
    StartFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor, FrameProcessorSetup
from pipecat.services.tts_service import TextAggregationMode, TTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.asyncio.task_manager import TaskManager

from oron_agent.config import Settings
from oron_agent.tts import TtsProvider, build_tts
from oron_agent.voice_quality import VoiceQualityConfig, make_speech_transformer

_PRIVATE_PREVIEW: ContextVar[bool] = ContextVar("private_audio_preview", default=False)


def redact_private_preview(record: Record) -> None:
    """Loguru context is inherited by provider tasks, without hiding other requests."""
    if record["extra"].get("private_audio_preview"):
        record["message"] = "private audio preview runtime event"
        record["exception"] = None
        record["extra"] = {"private_audio_preview": True}


class _PrivateLogPatcher:
    def __init__(self, previous: Callable[[Record], None] | None) -> None:
        self.previous = previous

    def __call__(self, record: Record) -> None:
        private = bool(record["extra"].get("private_audio_preview"))
        if self.previous is not None:
            self.previous(record)
        if private:
            record["extra"]["private_audio_preview"] = True
            redact_private_preview(record)


class _PrivateRecordFactory:
    def __init__(self, previous: Callable[..., logging.LogRecord]) -> None:
        self.previous = previous

    def __call__(self, *args: Any, **kwargs: Any) -> logging.LogRecord:
        record = self.previous(*args, **kwargs)
        if _PRIVATE_PREVIEW.get():
            record.msg = "private audio preview SDK event"
            record.args = ()
            record.exc_info = None
            record.exc_text = None
            record.stack_info = None
        return record


def install_private_provider_logging() -> None:
    # Loguru 0.7 exposes no configured-patcher getter. Preserve its installed
    # process patcher at this one composition seam rather than replacing it.
    prior = cast(Any, logger)._core.patcher  # noqa: SLF001
    if not isinstance(prior, _PrivateLogPatcher):
        logger.configure(patcher=_PrivateLogPatcher(prior))
    factory = logging.getLogRecordFactory()
    if not isinstance(factory, _PrivateRecordFactory):
        logging.setLogRecordFactory(_PrivateRecordFactory(factory))


@contextmanager
def private_provider_logging():
    token = _PRIVATE_PREVIEW.set(True)
    try:
        with logger.contextualize(private_audio_preview=True):
            yield
    finally:
        _PRIVATE_PREVIEW.reset(token)


@dataclass
class SynthesizedPreview:
    audio: bytes
    provider: str
    model: str
    voice: str
    duration_seconds: float
    canonical_text: str
    speech_normalized_text: str


class _PreviewCapture(FrameProcessor):
    def __init__(self) -> None:
        super().__init__()
        self.pcm = bytearray()
        self.failed = False
        self.finished = asyncio.Event()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame):
            if (
                frame.sample_rate != 24000
                or frame.num_channels != 1
                or len(frame.audio) % 2
                or len(self.pcm) + len(frame.audio) > 1_440_000
            ):
                self.failed = True
                self.finished.set()
                return
            self.pcm.extend(frame.audio)
        elif isinstance(frame, ErrorFrame):
            self.failed = True
            self.finished.set()
        elif isinstance(frame, EndFrame):
            self.finished.set()
        await self.push_frame(frame, direction)


class PreviewCleanupIncomplete(RuntimeError):
    provider_work_may_continue = True


class _PreviewPipeline(Pipeline):
    def __init__(self, tts: TTSService, capture: _PreviewCapture) -> None:
        super().__init__([tts, capture])
        self.capture = capture

    async def push_frame(
        self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM
    ) -> None:
        if isinstance(frame, ErrorFrame):
            self.capture.failed = True
            self.capture.finished.set()


async def _close_preview(
    pipeline: Pipeline, tts: TTSService, manager: TaskManager, driver: asyncio.Task[None]
) -> None:
    async def close() -> None:
        await tts.cancel(CancelFrame())
        await pipeline.cleanup()

    driver.cancel()
    cleanup = asyncio.create_task(close())
    # asyncio.wait never waits indefinitely for cancellation acknowledgement.
    # WorkerRunner.run is deliberately absent: its cancellation handler swallows
    # CancelledError and can wait forever after partially emitted audio.
    await asyncio.wait({cleanup}, timeout=1)
    pending = {task for task in [*manager.current_tasks(), driver, cleanup] if not task.done()}
    for task in pending:
        task.cancel()
    if pending:
        _, pending = await asyncio.wait(pending, timeout=0.5)
    for task in pending:
        task.cancel()
    if pending:
        _, pending = await asyncio.wait(pending, timeout=0.5)
    if pending or (cleanup.done() and not cleanup.cancelled() and cleanup.exception() is not None):
        raise PreviewCleanupIncomplete("preview cleanup incomplete; restart required")


class RealPreviewProvider:
    def __init__(
        self,
        *,
        settings_factory: Callable[[], Settings] | None = None,
        tts_factory: Callable[..., TTSService] = build_tts,
    ) -> None:
        # Installed once by the process-owned preview service, before provider
        # construction. Context-local marking avoids a per-request logger race.
        install_private_provider_logging()
        self._settings_factory = settings_factory or (lambda: Settings(_env_file=None))
        self._tts_factory = tts_factory

    async def synthesize(
        self, text: str, quality: dict[str, Any], *, confirmed: bool
    ) -> SynthesizedPreview:
        with private_provider_logging():
            return await self._synthesize(text, quality, confirmed=confirmed)

    async def _synthesize(
        self, text: str, quality: dict[str, Any], *, confirmed: bool
    ) -> SynthesizedPreview:
        if confirmed is not True or not text.strip() or len(text) > 300:
            raise ValueError("explicit bounded preview is required")
        if any(unicodedata.category(c).startswith("C") or c in "<>{}[]" for c in text):
            raise ValueError("preview text must be plain text")
        settings = self._settings_factory()
        # Lowest paid boundary: neither dependency injection nor an HTTP flag
        # can bypass the existing real-provider kill switch.
        if not settings.enable_real_voice_providers:
            raise PermissionError("real voice providers are disabled")
        config = VoiceQualityConfig.model_validate(quality)
        speech_text = await make_speech_transformer(config, lambda: None)(text, "*")
        if not speech_text.strip() or len(speech_text) > 2000:
            raise ValueError("speech-normalized preview exceeds its bound")
        voice = config.voiceId or (
            settings.soniox_tts_voice_default
            if settings.tts_provider is TtsProvider.SONIOX
            else settings.gemini_tts_voice_default
        )
        tts = self._tts_factory(
            settings.tts_provider,
            language=Language.HE if config.language == "he" else Language.EN,
            voice=voice,
            text_filters=[],
            text_aggregation_mode=TextAggregationMode.SENTENCE,
            first_clause=False,
            speed=config.speakingPace,
            soniox_api_key=settings.soniox_api_key.get_secret_value(),
            soniox_model=settings.soniox_tts_model,
            gemini_model=settings.gemini_tts_model,
            google_credentials_path=settings.google_application_credentials,
        )
        capture = _PreviewCapture()
        pipeline = _PreviewPipeline(tts, capture)
        manager = TaskManager()
        worker = PipelineWorker(
            pipeline,
            params=PipelineParams(
                audio_out_sample_rate=24000, enable_metrics=False, enable_usage_metrics=False
            ),
            enable_tracing=False,
            enable_turn_tracking=False,
            enable_rtvi=False,
            idle_timeout_secs=15,
            cancel_timeout_secs=2,
            task_manager=manager,
        )
        clock = SystemClock()
        clock.start()

        async def drive() -> None:
            await pipeline.setup(
                FrameProcessorSetup(
                    clock=clock,
                    task_manager=manager,
                    pipeline_worker=worker,
                    audio_out_sample_rate=24000,
                )
            )
            for frame in (StartFrame(), TTSSpeakFrame(speech_text), EndFrame()):
                await pipeline.queue_frame(frame)
            await capture.finished.wait()

        driver = asyncio.create_task(drive())
        try:
            # Keep provider-owned cancellation handlers away from the request
            # deadline; explicit teardown below owns every preview task.
            await asyncio.shield(driver)
        finally:
            await _close_preview(pipeline, tts, manager, driver)
        if capture.failed or not capture.pcm:
            raise RuntimeError("audio preview synthesis failed")
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(24000)
            output.writeframes(capture.pcm)
        return SynthesizedPreview(
            audio=buffer.getvalue(),
            provider=settings.tts_provider.value,
            model=(
                settings.soniox_tts_model
                if settings.tts_provider is TtsProvider.SONIOX
                else settings.gemini_tts_model
            ),
            voice=voice,
            duration_seconds=len(capture.pcm) / 48000,
            canonical_text=text,
            speech_normalized_text=speech_text,
        )
