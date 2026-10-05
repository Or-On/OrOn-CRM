"""Exercise installed speech text paths with NLTK unavailable and provider I/O replaced.

Runs from /tmp inside final images. Only stdlib and installed application/runtime
dependencies are needed. Synthetic PCM stays in memory; no speaker, room, socket,
provider API, credential discovery, model download, or real message is used.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.abc
import importlib.metadata
import importlib.util
import json
import sys
from types import MethodType
from unittest.mock import patch


class _NoNLTK(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "nltk" or fullname.startswith("nltk."):
            raise ModuleNotFoundError("NLTK is unavailable in the voice runtime")
        return None


def _deny_nltk(*, require_absent: bool) -> None:
    if require_absent:
        try:
            importlib.metadata.distribution("nltk")
        except importlib.metadata.PackageNotFoundError:
            pass
        else:
            raise RuntimeError("NLTK distribution remains in the final image")
        if importlib.util.find_spec("nltk") is not None:
            raise RuntimeError("NLTK remains importable in the final image")
    if any(name == "nltk" or name.startswith("nltk.") for name in sys.modules):
        raise RuntimeError("NLTK was loaded before the runtime check")
    sys.meta_path.insert(0, _NoNLTK())


async def _run_case(provider, mode, first_clause: bool, transformed: bool) -> dict:
    from oron_agent.tts import SonioxUnpointedContextTTSService, build_tts
    from pipecat.frames.frames import (
        EndFrame,
        LLMFullResponseEndFrame,
        LLMFullResponseStartFrame,
        LLMTextFrame,
        TTSAudioRawFrame,
        TTSTextFrame,
    )
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
    from pipecat.processors.frameworks.rtvi import RTVIObserver, RTVIObserverParams, RTVIProcessor
    from pipecat.services.google.tts import GeminiTTSService
    from pipecat.transcriptions.language import Language
    from pipecat.workers.runner import WorkerRunner

    class Sink(FrameProcessor):
        def __init__(self):
            super().__init__()
            self.text = []
            self.audio_contexts = set()

        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if direction is FrameDirection.DOWNSTREAM:
                if isinstance(frame, TTSTextFrame) and frame.append_to_context:
                    self.text.append(frame.text)
                    assert frame.context_id
                elif isinstance(frame, TTSAudioRawFrame):
                    assert frame.audio == b"\x01\x00" * 240
                    assert frame.context_id
                    self.audio_contexts.add(frame.context_id)
            await self.push_frame(frame, direction)

    # The actual Gemini constructor is exercised, but its credential/client
    # creation seam is replaced before it could discover ADC or use the network.
    with patch.object(GeminiTTSService, "_create_client", return_value=object()):
        tts = build_tts(
            provider,
            language=Language.HE,
            voice="Leda",
            text_filters=[],
            text_aggregation_mode=mode,
            first_clause=first_clause,
            speed=1.0,
            reduce_silence=False,
            soniox_api_key="offline-fixture",
            soniox_model="tts-rt-v2",
            gemini_model="gemini-2.5-flash-preview-tts",
            google_credentials_path=None,
        )
    requests = []

    async def synthesize(_self, text, context_id):
        requests.append(text)
        yield TTSAudioRawFrame(b"\x01\x00" * 240, 24000, 1, context_id=context_id)

    async def forbid_connection(*_args, **_kwargs):
        raise AssertionError("The runtime text check attempted provider I/O")

    tts.run_tts = MethodType(synthesize, tts)
    # Soniox normally connects lazily. Keep a failing fence on that seam as
    # well, so a lifecycle change cannot accidentally make this a live test.
    if isinstance(tts, SonioxUnpointedContextTTSService):
        tts._websocket_connect = forbid_connection
    if transformed:

        async def point_hebrew(text, _aggregation):
            return text.replace("ש", "שָׁ")

        tts.add_text_transformer(point_hebrew)
    sink = Sink()
    # Match the production observer pair. Its raw-LLM feature is deliberately
    # disabled because that optional SDK feature has its own NLTK dependency.
    rtvi = RTVIProcessor()
    observer = RTVIObserver(
        rtvi, params=RTVIObserverParams(metrics_enabled=True, bot_llm_enabled=False)
    )
    worker = PipelineWorker(Pipeline([rtvi, tts, sink]), observers=[observer])
    errors = []

    @worker.event_handler("on_pipeline_error")
    async def on_error(_worker, frame):
        errors.append(type(frame).__name__)

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    text = "שלום לכל המתקשרים, שמחים לעזור. המחיר 29.90 ש״ח. יש שאלה? שלום שוב."
    # Multiple sentences in one coarse TOKEN chunk covers the sequencer's
    # aligned split; short chunks cover its cross-chunk and transformed paths.
    chunks = (
        [text] if not transformed else [text[index : index + 3] for index in range(0, len(text), 3)]
    )
    await worker.queue_frame(LLMFullResponseStartFrame())
    for chunk in chunks:
        await worker.queue_frame(LLMTextFrame(chunk))
    await worker.queue_frame(LLMFullResponseEndFrame())
    await worker.queue_frame(EndFrame())
    async with asyncio.timeout(10):
        await runner.run()
    assert not errors, errors
    assert requests and sink.audio_contexts
    if mode.value == "sentence":
        assert requests[0].endswith(",") is first_clause
    # Sentence chunks trim their separating whitespace; no words, numbers, or
    # punctuation may disappear and niqqud must stay out of assistant context.
    assert "".join("".join(sink.text).split()) == "".join(text.split())
    assert all("ָ" not in part and "ׁ" not in part for part in sink.text)
    assert (any("ָ" in part for part in requests)) is transformed
    return {
        "provider": provider.value,
        "mode": mode.value,
        "first_clause": first_clause,
        "transformed": transformed,
        "speech_requests": len(requests),
        "context_frames": len(sink.text),
    }


async def check_runtime() -> list[dict]:
    from oron_flows import TtsProvider
    from pipecat.services.tts_service import TextAggregationMode

    results = []
    for provider in (TtsProvider.SONIOX, TtsProvider.GEMINI):
        for mode in (TextAggregationMode.SENTENCE, TextAggregationMode.TOKEN):
            for first_clause in (False, True):
                for transformed in (False, True):
                    results.append(await _run_case(provider, mode, first_clause, transformed))
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-nltk-absent", action="store_true")
    arguments = parser.parse_args()
    _deny_nltk(require_absent=arguments.require_nltk_absent)
    from loguru import logger

    # Observer failures can be logged outside on_pipeline_error. They must fail
    # this check too; a successful runner exit alone does not prove delivery.
    background_errors = []
    logger.remove()
    logger.add(sys.stderr, level="ERROR")
    logger.add(lambda message: background_errors.append(str(message)), level="ERROR")
    results = asyncio.run(check_runtime())
    assert not background_errors, background_errors
    print(json.dumps({"nltk_import_blocked": True, "cases": results, "passed": len(results)}))


if __name__ == "__main__":
    main()
