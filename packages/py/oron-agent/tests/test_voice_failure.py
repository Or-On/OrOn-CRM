import asyncio
from unittest.mock import AsyncMock

import pytest
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
    prepare, recovery = AsyncMock(return_value=True), AsyncMock()
    policy = VoiceFailurePolicy(
        control, cancel, announce, prepare_recovery=prepare, announce_recovery=recovery
    )
    frame = await failure_frame()
    await policy.handle(frame)
    await policy.handle(frame)
    assert order == ["fixed audio", "cancel"]
    assert policy.failed
    prepare.assert_not_awaited()
    recovery.assert_not_awaited()


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


async def test_transient_provider_error_checks_readiness_then_distinct_recovery_audio_once():
    from pipecat.utils.errors import ErrorCategory

    order = []

    async def interrupt():
        order.append("old reply discarded")

    async def prepare(frame):
        assert frame.processor is producer
        order.append("provider ready")
        return True

    async def recovery():
        order.append("recovery audio")

    async def announce():
        order.append("terminal audio")

    producer = FrameProcessor()
    read = AsyncMock(return_value=VoiceControlSnapshot(0, "ai"))
    control = VoiceController(read, AsyncMock(return_value=True))
    cancel = AsyncMock()
    policy = VoiceFailurePolicy(
        control,
        cancel,
        announce,
        interrupt,
        (producer,),
        prepare_recovery=prepare,
        announce_recovery=recovery,
    )
    frame = ErrorFrame(
        "synthetic provider unavailable", processor=producer, category=ErrorCategory.CONNECTIVITY
    )
    await policy.handle(frame)
    assert order == ["old reply discarded", "provider ready", "recovery audio"]
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
    assert order == [
        "old reply discarded",
        "provider ready",
        "recovery audio",
        "old reply discarded",
        "terminal audio",
    ]


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


async def test_terminal_announcement_cannot_leave_a_transient_call_running():
    from pipecat.utils.errors import ErrorCategory

    producer = FrameProcessor()
    cancel, announce, interrupt = AsyncMock(), AsyncMock(), AsyncMock()
    policy = VoiceFailurePolicy(None, cancel, announce, interrupt, (producer,))
    await policy.handle(
        ErrorFrame("synthetic timeout", processor=producer, category=ErrorCategory.CONNECTIVITY)
    )
    announce.assert_awaited_once()
    cancel.assert_awaited_once()
    assert policy.failed and policy.transient_recoveries == 0


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
    next_reply = asyncio.Event()
    model_turns, emitted = [], []

    class BlockingReply(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, LLMTextFrame):
                model_turns.append(frame.text)
                if frame.text == "synthetic old reply":
                    entered.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        cancelled.set()
            await self.push_frame(frame, direction)

    class Output(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, LLMTextFrame):
                emitted.append(frame.text)
                next_reply.set()
            await self.push_frame(frame, direction)

    model = BlockingReply()
    output = Output()
    worker = PipelineWorker(Pipeline([model, output]))
    bind_pipeline_readiness(worker, ready)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    task = asyncio.create_task(runner.run())
    control = VoiceController(
        AsyncMock(return_value=VoiceControlSnapshot(0, "ai")), AsyncMock(return_value=True)
    )
    control.attach([model, output])
    announced = []

    async def announce():
        assert cancelled.is_set()
        announced.append("truthful fixed audio")

    terminal = AsyncMock()
    policy = VoiceFailurePolicy(
        control,
        worker.cancel,
        terminal,
        control.interrupt_reply,
        (model,),
        prepare_recovery=AsyncMock(return_value=True),
        announce_recovery=announce,
    )
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
            await worker.queue_frame(LLMTextFrame("synthetic fresh reply"))
            await next_reply.wait()
        assert announced == ["truthful fixed audio"]
        assert not policy.failed and not control.paused
        terminal.assert_not_awaited()
        assert model_turns == ["synthetic old reply", "synthetic fresh reply"]
        assert emitted == ["synthetic fresh reply"]
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


@pytest.mark.parametrize("readiness", ["refused", "error", "timeout"])
async def test_unready_provider_never_plays_recovery_or_leaves_dead_air(readiness, monkeypatch):
    from oron_agent import voice_failure
    from pipecat.utils.errors import ErrorCategory

    monkeypatch.setattr(voice_failure, "_PROVIDER_RECOVERY_TIMEOUT_SECONDS", 0.01)
    producer = FrameProcessor()
    order = []

    async def prepare(_frame):
        order.append("reset without replay")
        if readiness == "error":
            raise ConnectionError("synthetic reset failure")
        if readiness == "timeout":
            await asyncio.Event().wait()
        return False

    async def terminal():
        order.append("terminal")

    async def cancel():
        order.append("cancel")

    recovery = AsyncMock()
    policy = VoiceFailurePolicy(
        None,
        cancel,
        terminal,
        AsyncMock(),
        (producer,),
        prepare_recovery=prepare,
        announce_recovery=recovery,
    )
    async with asyncio.timeout(1):
        await policy.handle(
            ErrorFrame("synthetic drop", processor=producer, category=ErrorCategory.CONNECTIVITY)
        )
    assert order == ["reset without replay", "terminal", "cancel"]
    assert policy.failed and policy.transient_recoveries == 0
    recovery.assert_not_awaited()


@pytest.mark.parametrize("concurrent_permanent", [False, True])
async def test_simultaneous_provider_drops_share_reset_but_permanent_error_wins(
    concurrent_permanent,
):
    from pipecat.utils.errors import ErrorCategory

    stt, tts = FrameProcessor(), FrameProcessor()
    entered, release = asyncio.Event(), asyncio.Event()

    async def prepare(_frame):
        entered.set()
        await release.wait()
        return True

    prepare_mock = AsyncMock(side_effect=prepare)
    cancel, terminal, recovery = AsyncMock(), AsyncMock(), AsyncMock()
    policy = VoiceFailurePolicy(
        None,
        cancel,
        terminal,
        AsyncMock(),
        (stt, tts),
        prepare_recovery=prepare_mock,
        announce_recovery=recovery,
    )
    first = asyncio.create_task(
        policy.handle(
            ErrorFrame("synthetic TTS drop", processor=tts, category=ErrorCategory.CONNECTIVITY)
        )
    )
    try:
        async with asyncio.timeout(1):
            await entered.wait()
            if concurrent_permanent:
                await stt.set_usable(False)
            await policy.handle(
                ErrorFrame("synthetic STT drop", processor=stt, category=ErrorCategory.CONNECTIVITY)
            )
            release.set()
            await first
    finally:
        release.set()
        await first
    prepare_mock.assert_awaited_once()
    if concurrent_permanent:
        terminal.assert_awaited_once()
        cancel.assert_awaited_once()
        recovery.assert_not_awaited()
        assert policy.failed
    else:
        terminal.assert_not_awaited()
        cancel.assert_not_awaited()
        recovery.assert_awaited_once()
        assert policy.transient_recoveries == 1 and not policy.failed


async def test_new_drop_during_recovery_audio_cannot_be_lost_or_start_second_reset():
    from pipecat.utils.errors import ErrorCategory

    producer = FrameProcessor()
    entered, release = asyncio.Event(), asyncio.Event()
    order = []

    async def recovery():
        order.append("recovery")
        entered.set()
        await release.wait()

    async def terminal():
        order.append("terminal")

    async def cancel():
        order.append("cancel")

    prepare = AsyncMock(return_value=True)
    policy = VoiceFailurePolicy(
        None,
        cancel,
        terminal,
        AsyncMock(),
        (producer,),
        prepare_recovery=prepare,
        announce_recovery=recovery,
    )
    first = asyncio.create_task(
        policy.handle(
            ErrorFrame("synthetic first drop", processor=producer, category=ErrorCategory.UNKNOWN)
        )
    )
    try:
        async with asyncio.timeout(1):
            await entered.wait()
            await policy.handle(
                ErrorFrame(
                    "synthetic later drop", processor=producer, category=ErrorCategory.CONNECTIVITY
                )
            )
            release.set()
            await first
    finally:
        release.set()
        await first
    prepare.assert_awaited_once()
    assert order == ["recovery", "terminal", "cancel"]
    assert policy.failed


@pytest.mark.parametrize("takeover_during", ["prepare", "announcement"])
async def test_takeover_during_recovery_preserves_human_and_cancels_provider_work(takeover_during):
    from pipecat.utils.errors import ErrorCategory

    producer = FrameProcessor()
    read = AsyncMock(return_value=VoiceControlSnapshot(0, "ai"))
    control = VoiceController(read, AsyncMock(return_value=True))
    entered, stopped = asyncio.Event(), asyncio.Event()

    async def hold():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    async def prepare(_frame):
        if takeover_during == "prepare":
            await hold()
        return True

    async def recovery():
        await hold()

    cancel, terminal = AsyncMock(), AsyncMock()
    recovery_mock = AsyncMock(side_effect=recovery)
    policy = VoiceFailurePolicy(
        control,
        cancel,
        terminal,
        AsyncMock(),
        (producer,),
        prepare_recovery=prepare,
        announce_recovery=recovery_mock,
    )
    task = asyncio.create_task(
        policy.handle(
            ErrorFrame("synthetic drop", processor=producer, category=ErrorCategory.CONNECTIVITY)
        )
    )
    async with asyncio.timeout(1):
        await entered.wait()
        read.return_value = VoiceControlSnapshot(1, "paused")
        await control.refresh()
        await task
    assert stopped.is_set() and control.paused and not policy.failed
    assert policy.transient_recoveries == 0
    terminal.assert_not_awaited()
    cancel.assert_not_awaited()
    if takeover_during == "prepare":
        recovery_mock.assert_not_awaited()


async def test_ownership_read_failure_after_provider_readiness_blocks_recovery_audio():
    from pipecat.utils.errors import ErrorCategory

    producer = FrameProcessor()
    read = AsyncMock(return_value=VoiceControlSnapshot(0, "ai"))
    control = VoiceController(read, AsyncMock(return_value=True))

    async def prepare(_frame):
        read.side_effect = ConnectionError("synthetic ownership database outage")
        return True

    cancel, terminal, recovery = AsyncMock(), AsyncMock(), AsyncMock()
    policy = VoiceFailurePolicy(
        control,
        cancel,
        terminal,
        AsyncMock(),
        (producer,),
        prepare_recovery=prepare,
        announce_recovery=recovery,
    )
    await policy.handle(
        ErrorFrame("synthetic drop", processor=producer, category=ErrorCategory.CONNECTIVITY)
    )
    assert control.paused and not policy.failed and policy.transient_recoveries == 0
    recovery.assert_not_awaited()
    terminal.assert_not_awaited()
    cancel.assert_not_awaited()


async def test_slow_business_cancellation_cannot_leave_recovery_gates_stuck_open():
    from pipecat.utils.errors import ErrorCategory

    producer = FrameProcessor()
    control = VoiceController(
        AsyncMock(return_value=VoiceControlSnapshot(0, "ai")), AsyncMock(return_value=True)
    )
    entered, release = asyncio.Event(), asyncio.Event()

    async def tool():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            # Simulate slow provider cleanup after the external outcome became
            # ambiguous. Recovery must not wait forever or replay this action.
            await release.wait()

    pending = asyncio.create_task(control.action(tool))
    await entered.wait()
    cancel, prepare, recovery = AsyncMock(), AsyncMock(return_value=True), AsyncMock()
    policy = VoiceFailurePolicy(
        control,
        cancel,
        AsyncMock(),
        AsyncMock(),
        (producer,),
        prepare_recovery=prepare,
        announce_recovery=recovery,
    )
    try:
        async with asyncio.timeout(3):
            await policy.handle(
                ErrorFrame(
                    "synthetic drop", processor=producer, category=ErrorCategory.CONNECTIVITY
                )
            )
        assert policy.failed and control.recovering
        cancel.assert_awaited_once()
        prepare.assert_not_awaited()
        recovery.assert_not_awaited()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await pending


async def test_new_ai_epoch_during_recovery_is_not_cancelled_by_old_error_handler():
    from pipecat.utils.errors import ErrorCategory

    producer = FrameProcessor()
    read = AsyncMock(return_value=VoiceControlSnapshot(0, "ai"))
    control = VoiceController(read, AsyncMock(return_value=True))
    entered = asyncio.Event()

    async def prepare(_frame):
        entered.set()
        await asyncio.Event().wait()
        return True

    cancel, terminal, recovery = AsyncMock(), AsyncMock(), AsyncMock()
    policy = VoiceFailurePolicy(
        control,
        cancel,
        terminal,
        AsyncMock(),
        (producer,),
        prepare_recovery=prepare,
        announce_recovery=recovery,
    )
    task = asyncio.create_task(
        policy.handle(
            ErrorFrame("synthetic drop", processor=producer, category=ErrorCategory.CONNECTIVITY)
        )
    )
    async with asyncio.timeout(1):
        await entered.wait()
        read.return_value = VoiceControlSnapshot(1, "ai")
        await control.refresh()
        await task
    assert not policy.failed and not control.paused and not control.recovering
    assert control.epoch == 1
    cancel.assert_not_awaited()
    terminal.assert_not_awaited()
    recovery.assert_not_awaited()
