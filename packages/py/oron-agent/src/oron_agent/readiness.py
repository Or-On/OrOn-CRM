"""Admission readiness follows the installed pipeline startup acknowledgement."""

import asyncio
from collections.abc import Callable

from pipecat.frames.frames import StartFrame
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor


def bind_pipeline_readiness(
    worker: PipelineWorker,
    ready: asyncio.Event | None,
    *,
    on_failure: Callable[[], None] | None = None,
) -> None:
    """Do not authorize SIP admission merely because processor constructors ran.

    Pipecat acknowledges StartFrame at the sink after setup and every processor's
    startup path. This proves local pipeline startup, not remote provider quality
    or caller playback; paused capture is still authorized separately.
    """

    def usable(processor: FrameProcessor) -> bool:
        return processor.is_usable and all(usable(child) for child in processor.processors)

    @worker.event_handler("on_pipeline_started")
    async def started(_worker: PipelineWorker, _frame: StartFrame) -> None:
        if usable(worker.pipeline):
            if ready is not None:
                ready.set()
        else:
            if on_failure is not None:
                on_failure()
            await worker.cancel()
