import asyncio
from unittest.mock import AsyncMock

from oron_agent.voice_control import VoiceController, VoiceControlSnapshot
from oron_agent.voice_failure import VoiceFailurePolicy
from pipecat.frames.frames import ErrorFrame
from pipecat.processors.frame_processor import FrameProcessor


async def failure_frame():
    producer = FrameProcessor()
    await producer.set_usable(False)
    return ErrorFrame("synthetic permanent provider failure", processor=producer)


async def test_permanent_ai_failure_announces_then_cancels_once():
    order = []

    async def announce():
        order.append("fixed audio")

    async def cancel():
        order.append("cancel")

    read = AsyncMock(return_value=VoiceControlSnapshot(0, "ai"))
    control = VoiceController(read, AsyncMock(return_value=True))
    policy = VoiceFailurePolicy(control, cancel, announce)
    frame = await failure_frame()
    await policy.handle(frame)
    await policy.handle(frame)
    assert order == ["fixed audio", "cancel"]
    assert policy.failed


async def test_late_old_provider_error_preserves_human_paused_leg():
    read = AsyncMock(return_value=VoiceControlSnapshot(0, "ai"))
    control = VoiceController(read, AsyncMock(return_value=True))
    await control.refresh()
    read.return_value = VoiceControlSnapshot(1, "paused")
    await control.refresh()
    cancel, announce = AsyncMock(), AsyncMock()
    policy = VoiceFailurePolicy(control, cancel, announce)
    await policy.handle(await failure_frame())
    cancel.assert_not_awaited()
    announce.assert_not_awaited()
    assert control.paused and not policy.failed


async def test_unknown_ownership_stops_ai_io_without_ending_leg():
    read = AsyncMock(return_value=VoiceControlSnapshot(0, "ai"))
    control = VoiceController(read, AsyncMock(return_value=True))
    await control.refresh()
    read.side_effect = RuntimeError("synthetic DB outage")
    cancel, announce = AsyncMock(), AsyncMock()
    policy = VoiceFailurePolicy(control, cancel, announce)
    await policy.handle(await failure_frame())
    cancel.assert_not_awaited()
    announce.assert_not_awaited()
    assert control.paused and not policy.failed
    read.side_effect = None
    assert await control.refresh()
    assert control.paused  # same command cannot reopen a failed capture


async def test_takeover_during_failure_announcement_never_hangs_up_human():
    read = AsyncMock(return_value=VoiceControlSnapshot(0, "ai"))
    control = VoiceController(read, AsyncMock(return_value=True))
    started, stopped = asyncio.Event(), asyncio.Event()

    async def announce():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    cancel = AsyncMock()
    policy = VoiceFailurePolicy(control, cancel, announce)
    task = asyncio.create_task(policy.handle(await failure_frame()))
    await started.wait()
    read.return_value = VoiceControlSnapshot(1, "paused")
    await control.refresh()
    await task
    assert stopped.is_set()
    cancel.assert_not_awaited()
    assert not policy.failed


async def test_concurrent_permanent_errors_reserve_one_failure_announcement():
    entered, release = asyncio.Event(), asyncio.Event()

    async def read():
        entered.set()
        await release.wait()
        return VoiceControlSnapshot(0, "ai")

    control = VoiceController(read, AsyncMock(return_value=True))
    cancel, announce = AsyncMock(), AsyncMock()
    policy = VoiceFailurePolicy(control, cancel, announce)
    frame = await failure_frame()
    first = asyncio.create_task(policy.handle(frame))
    await entered.wait()
    second = asyncio.create_task(policy.handle(frame))
    await second
    release.set()
    await first
    announce.assert_awaited_once()
    cancel.assert_awaited_once()


async def test_transient_provider_error_interrupts_old_reply_then_fixed_audio_once():
    from pipecat.utils.errors import ErrorCategory

    order = []

    async def interrupt():
        order.append("old reply discarded")

    async def announce():
        order.append("fixed audio")

    producer = FrameProcessor()
    read = AsyncMock(return_value=VoiceControlSnapshot(0, "ai"))
    control = VoiceController(read, AsyncMock(return_value=True))
    cancel = AsyncMock()
    policy = VoiceFailurePolicy(control, cancel, announce, interrupt, (producer,))
    frame = ErrorFrame(
        "synthetic provider unavailable", processor=producer, category=ErrorCategory.CONNECTIVITY
    )
    await policy.handle(frame)
    assert order == ["old reply discarded", "fixed audio"]
    assert policy.transient_recoveries == 1 and not policy.failed
    cancel.assert_not_awaited()
    await policy.handle(frame)
    assert not policy.failed  # duplicate delivery does not spend the recovery budget
    await policy.handle(
        ErrorFrame(
            "second synthetic provider unavailable",
            processor=producer,
            category=ErrorCategory.CONNECTIVITY,
        )
    )
    assert policy.failed
    cancel.assert_awaited_once()
    assert order == ["old reply discarded", "fixed audio", "old reply discarded", "fixed audio"]


async def test_transient_provider_recovery_does_not_replay_business_application_failure():
    from pipecat.utils.errors import ErrorCategory

    producer = FrameProcessor()
    cancel, announce, interrupt = AsyncMock(), AsyncMock(), AsyncMock()
    policy = VoiceFailurePolicy(None, cancel, announce, interrupt, (producer,))
    await policy.handle(
        ErrorFrame(
            "synthetic business tool failure",
            processor=producer,
            category=ErrorCategory.APPLICATION,
        )
    )
    cancel.assert_not_awaited()
    announce.assert_not_awaited()
    interrupt.assert_not_awaited()


async def test_transient_error_with_unknown_ownership_cannot_speak_or_replay():
    from pipecat.utils.errors import ErrorCategory

    producer = FrameProcessor()
    control = VoiceController(
        AsyncMock(side_effect=RuntimeError("DB unavailable")), AsyncMock(return_value=True)
    )
    cancel, announce, interrupt = AsyncMock(), AsyncMock(), AsyncMock()
    policy = VoiceFailurePolicy(control, cancel, announce, interrupt, (producer,))
    await policy.handle(
        ErrorFrame("synthetic timeout", processor=producer, category=ErrorCategory.CONNECTIVITY)
    )
    cancel.assert_not_awaited()
    announce.assert_not_awaited()
    interrupt.assert_not_awaited()
    assert control.paused and policy.transient_recoveries == 0


async def test_actual_pipecat_transient_recovery_cancels_inflight_reply_before_fixed_audio():
    from oron_agent.readiness import bind_pipeline_readiness
    from pipecat.frames.frames import LLMTextFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.utils.errors import ErrorCategory
    from pipecat.workers.runner import WorkerRunner

    entered, cancelled, ready = asyncio.Event(), asyncio.Event(), asyncio.Event()

    class BlockingReply(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, LLMTextFrame):
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()
            await self.push_frame(frame, direction)

    model = BlockingReply()
    worker = PipelineWorker(Pipeline([model]))
    bind_pipeline_readiness(worker, ready)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    task = asyncio.create_task(runner.run())
    control = VoiceController(
        AsyncMock(return_value=VoiceControlSnapshot(0, "ai")), AsyncMock(return_value=True)
    )
    control.attach([model])
    announced = []

    async def announce():
        assert cancelled.is_set()
        announced.append("truthful fixed audio")

    policy = VoiceFailurePolicy(control, worker.cancel, announce, control.interrupt_reply, (model,))
    try:
        async with asyncio.timeout(3):
            await ready.wait()
            assert await control.refresh()
            await worker.queue_frame(LLMTextFrame("synthetic old reply"))
            await entered.wait()
            await policy.handle(
                ErrorFrame(
                    "synthetic timeout", processor=model, category=ErrorCategory.CONNECTIVITY
                )
            )
        assert announced == ["truthful fixed audio"]
        assert not policy.failed and not control.paused
    finally:
        await worker.cancel()
        await task


async def test_unresponsive_fixed_recovery_port_is_bounded_and_fails_truthfully(monkeypatch):
    from oron_agent import voice_failure

    monkeypatch.setattr(voice_failure, "_RECOVERY_TIMEOUT_SECONDS", 0.01)

    async def never_finishes():
        await asyncio.Event().wait()

    cancel = AsyncMock()
    policy = VoiceFailurePolicy(None, cancel, never_finishes)
    async with asyncio.timeout(1):
        await policy.handle(await failure_frame())
    assert policy.failed
    cancel.assert_awaited_once()
