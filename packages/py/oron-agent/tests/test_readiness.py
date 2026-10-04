import asyncio

from oron_agent.readiness import bind_pipeline_readiness
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.workers.runner import WorkerRunner


class DelayedStartup(FrameProcessor):
    def __init__(self, entered, release, *, fail=False):
        super().__init__()
        self.entered = entered
        self.release = release
        self.fail = fail

    async def setup(self, setup):
        await super().setup(setup)
        self.entered.set()
        await self.release.wait()
        if self.fail:
            raise RuntimeError("synthetic startup failure")

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


async def test_actual_pipeline_does_not_admit_before_setup_and_start_frame_complete():
    entered, release, ready = asyncio.Event(), asyncio.Event(), asyncio.Event()
    worker = PipelineWorker(Pipeline([DelayedStartup(entered, release)]))
    bind_pipeline_readiness(worker, ready)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    task = asyncio.create_task(runner.run())
    try:
        async with asyncio.timeout(2):
            await entered.wait()
        assert not ready.is_set()
        release.set()
        async with asyncio.timeout(2):
            await ready.wait()
        assert ready.is_set()
    finally:
        release.set()
        await worker.cancel()
        await task


async def test_actual_pipeline_failed_setup_never_admits():
    entered, release, ready = asyncio.Event(), asyncio.Event(), asyncio.Event()
    release.set()
    worker = PipelineWorker(
        Pipeline([DelayedStartup(entered, release, fail=True)]),
    )
    bind_pipeline_readiness(worker, ready)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    try:
        async with asyncio.timeout(2):
            await runner.run()
    except RuntimeError:
        pass
    assert entered.is_set()
    assert not ready.is_set()
