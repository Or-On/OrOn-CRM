"""Run the real bot callbacks against deterministic, provider-free call lifecycles."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from oron_agent import bot
from oron_agent.config import Settings
from oron_agent.llm import LlmProvider
from oron_agent.voice_control import VoiceController, VoiceControlSnapshot
from oron_agent.voice_failure import VoiceFailurePolicy
from oron_common import CallContext, Direction
from oron_flows import EXAMPLE_EN, expand
from oron_sessions import SessionStatus
from pipecat.frames.frames import ErrorFrame
from pipecat.utils.errors import ErrorCategory
from pydantic import SecretStr


class Events:
    def __init__(self):
        self.handlers = {}

    def event_handler(self, name):
        def register(handler):
            self.handlers[name] = handler
            return handler

        return register


@pytest.fixture
def call_runtime(monkeypatch, tmp_path):
    """Only replace external processors/runner; persistence and bot callbacks run."""
    transport = Events()
    transport.input = Mock()
    transport.output = Mock()
    participant = SimpleNamespace(attributes={"sip.callStatus": "dialing"})
    transport._client = SimpleNamespace(
        room=SimpleNamespace(remote_participants={"caller": participant})
    )
    ctx = CallContext(
        call_id="fictional-pickup", direction="outbound", flow_id=uuid4(), tenant_id=uuid4()
    )
    sessions = SimpleNamespace(
        get_voice_bundle=AsyncMock(return_value=(expand(EXAMPLE_EN), {})),
        create=AsyncMock(return_value=ctx.session_id),
        finalize=AsyncMock(return_value=True),
        checkpoint_usage=AsyncMock(return_value=True),
        record_voice_quality=AsyncMock(),
        aclose=AsyncMock(),
    )
    settings = Settings(
        _env_file=None,
        artifacts_local_root=str(tmp_path),
        gender_detection_enabled=False,
        tts_niqqud=False,
        llm_warmup=False,
        answer_timeout_secs=30,
    )
    worker = Events()
    worker.pipeline = SimpleNamespace(is_usable=True, processors=[])
    worker.cancel = AsyncMock()
    # These scenarios never need the duration-budget task to run.
    worker.create_task = Mock(side_effect=lambda coroutine: coroutine.close())
    user, assistant = Events(), Events()
    aggregator = SimpleNamespace(user=lambda: user, assistant=lambda: assistant)
    audio = Events()
    audio.start_recording = AsyncMock()
    audio.stop_recording = AsyncMock()
    flow = SimpleNamespace(register_action=Mock(), initialize=AsyncMock(), current_node=None)
    runner = SimpleNamespace(add_workers=AsyncMock(), run=AsyncMock())
    idle = SimpleNamespace(arm=Mock())
    waiting = asyncio.Event()
    original_wait = bot.wait_until_answered

    async def observe_wait(*args, **kwargs):
        waiting.set()
        return await original_wait(*args, **kwargs)

    monkeypatch.setattr(bot, "wait_until_answered", observe_wait)
    monkeypatch.setattr(bot, "OwnershipSonioxSTTService", Mock())
    monkeypatch.setattr(bot, "build_llm", Mock())
    monkeypatch.setattr(bot, "build_tts", Mock())
    monkeypatch.setattr(bot, "build_user_aggregator_params", Mock())
    monkeypatch.setattr(bot, "LLMContextAggregatorPair", Mock(return_value=aggregator))
    monkeypatch.setattr(bot, "AlignedAudioBufferProcessor", Mock(return_value=audio))
    monkeypatch.setattr(bot, "build_agent_processors", Mock(return_value=[]))
    monkeypatch.setattr(bot, "Pipeline", Mock())
    monkeypatch.setattr(bot, "PipelineWorker", Mock(return_value=worker))
    monkeypatch.setattr(bot, "FlowManager", Mock(return_value=flow))
    monkeypatch.setattr(bot, "WorkerRunner", Mock(return_value=runner))
    monkeypatch.setattr(bot, "UserIdlePoker", Mock(return_value=idle))
    monkeypatch.setattr(bot, "hangup_room", AsyncMock())
    monotonic = Mock(return_value=100.0)
    monkeypatch.setattr(bot, "time", SimpleNamespace(monotonic=monotonic))

    async def run(scenario, **kwargs):
        runner.run.side_effect = scenario
        await bot.run_bot(
            transport, ctx, settings, room="fictional-room", g2p=None, sessions=sessions, **kwargs
        )

    return SimpleNamespace(
        run=run,
        transport=transport,
        worker=worker,
        sessions=sessions,
        settings=settings,
        ctx=ctx,
        flow=flow,
        audio=audio,
        idle=idle,
        runner=runner,
        waiting=waiting,
        participant=participant,
        monotonic=monotonic,
        artifact_root=tmp_path,
        user=user,
        assistant=assistant,
    )


async def test_early_departure_before_answer_persists_without_greeting(call_runtime):
    runtime = call_runtime

    async def scenario():
        join = asyncio.create_task(
            runtime.transport.handlers["on_first_participant_joined"](runtime.transport, "caller")
        )
        try:
            await runtime.waiting.wait()
            # Ring time must never become talk time, even when teardown takes time.
            runtime.monotonic.return_value = 900.0
            runtime.transport._client.room.remote_participants.clear()
            await runtime.transport.handlers["on_participant_left"](
                runtime.transport, "caller", "SIP rejection"
            )
            async with asyncio.timeout(0.5):
                await join
        finally:
            join.cancel()
            await asyncio.gather(join, return_exceptions=True)

    await runtime.run(scenario)
    runtime.sessions.create.assert_awaited_once_with(runtime.ctx, room="fictional-room")
    runtime.sessions.finalize.assert_awaited_once()
    persisted = runtime.sessions.finalize.await_args.kwargs
    assert persisted["status"] is SessionStatus.ENDED
    assert persisted["answered"] is False
    assert persisted["usage"].call_seconds == 0
    assert persisted["outcome"] is None
    assert persisted["transcript_uri"] and persisted["recording_uri"]
    transcript = (
        runtime.artifact_root
        / "conversations"
        / str(runtime.ctx.session_id)
        / "transcripts"
        / "transcript.txt"
    )
    assert transcript.read_text(encoding="utf-8") == ""
    runtime.flow.initialize.assert_not_awaited()
    runtime.audio.start_recording.assert_not_awaited()
    runtime.idle.arm.assert_not_called()
    runtime.sessions.checkpoint_usage.assert_not_awaited()
    runtime.sessions.aclose.assert_awaited_once()


@pytest.mark.parametrize(
    ("direction", "sip_status", "answered"),
    [("outbound", "active", True), ("outbound", "", False), ("inbound", "active", None)],
)
async def test_answer_starts_greeting_and_clock_only_after_pickup(
    call_runtime, direction, sip_status, answered
):
    runtime = call_runtime
    runtime.ctx.direction = Direction(direction)
    if not sip_status:
        # Keep the existing fallback for a carrier that omits pickup attributes.
        runtime.settings.answer_timeout_secs = 0.01

    async def scenario():
        runtime.sessions.create.assert_awaited_once()
        runtime.participant.attributes["sip.callStatus"] = sip_status
        runtime.monotonic.return_value = 200.0
        await runtime.transport.handlers["on_first_participant_joined"](runtime.transport, "caller")
        runtime.flow.initialize.assert_awaited_once()
        runtime.monotonic.return_value = 207.0
        await runtime.transport.handlers["on_participant_left"](
            runtime.transport, "caller", "normal"
        )

    await runtime.run(scenario)
    persisted = runtime.sessions.finalize.await_args.kwargs
    assert persisted["answered"] is answered
    assert persisted["usage"].call_seconds == 7.0
    runtime.audio.start_recording.assert_awaited_once()
    runtime.idle.arm.assert_called_once()


async def test_departure_after_pickup_during_recording_setup_never_greets(call_runtime):
    runtime = call_runtime
    recording_entered, release_recording = asyncio.Event(), asyncio.Event()

    async def delayed_recording():
        recording_entered.set()
        await release_recording.wait()

    runtime.audio.start_recording.side_effect = delayed_recording

    async def scenario():
        runtime.participant.attributes["sip.callStatus"] = "active"
        join = asyncio.create_task(
            runtime.transport.handlers["on_first_participant_joined"](runtime.transport, "caller")
        )
        try:
            await recording_entered.wait()
            await runtime.transport.handlers["on_participant_left"](
                runtime.transport, "caller", "normal"
            )
            release_recording.set()
            await join
        finally:
            join.cancel()
            await asyncio.gather(join, return_exceptions=True)

    await runtime.run(scenario)
    assert runtime.sessions.finalize.await_args.kwargs["answered"] is True
    runtime.flow.initialize.assert_not_awaited()
    runtime.idle.arm.assert_not_called()
    runtime.worker.create_task.assert_not_called()


async def test_recovery_audio_departure_keeps_caller_active(call_runtime):
    runtime = call_runtime

    async def scenario():
        await runtime.transport.handlers["on_participant_left"](
            runtime.transport, "oron-recovery", "normal"
        )
        runtime.worker.cancel.assert_not_awaited()
        runtime.sessions.finalize.assert_not_awaited()
        # The announcement's short-lived room leg cannot close the call before
        # the caller's next turn or inhibit startup of the actual caller.
        runtime.participant.attributes["sip.callStatus"] = "active"
        await runtime.transport.handlers["on_first_participant_joined"](runtime.transport, "caller")
        runtime.flow.initialize.assert_awaited_once()
        await runtime.transport.handlers["on_participant_left"](
            runtime.transport, "caller", "normal"
        )

    await runtime.run(scenario)
    runtime.worker.cancel.assert_awaited_once()
    runtime.sessions.finalize.assert_awaited_once()


async def test_cancelled_runner_interrupts_pickup_but_retains_unconfirmed_staging(call_runtime):
    runtime = call_runtime
    joined = []

    async def scenario():
        joined.append(
            asyncio.create_task(
                runtime.transport.handlers["on_first_participant_joined"](
                    runtime.transport, "caller"
                )
            )
        )
        await runtime.waiting.wait()
        raise asyncio.CancelledError

    try:
        with pytest.raises(asyncio.CancelledError):
            await runtime.run(scenario)
        async with asyncio.timeout(0.5):
            await joined[0]
    finally:
        for task in joined:
            task.cancel()
        await asyncio.gather(*joined, return_exceptions=True)
    runtime.sessions.finalize.assert_not_awaited()
    assert (runtime.artifact_root / ".staging" / str(runtime.ctx.session_id)).exists()
    runtime.flow.initialize.assert_not_awaited()
    runtime.sessions.aclose.assert_awaited_once()


async def test_runner_setup_failure_does_not_remove_files_of_undrained_writers(call_runtime):
    runtime = call_runtime
    release_turn = asyncio.Event()
    pending = []

    async def late_turn():
        await release_turn.wait()
        await runtime.user.handlers["on_user_turn_stopped"](
            runtime.user,
            None,
            SimpleNamespace(content="Captured before failed cleanup", timestamp=None),
        )

    async def scenario():
        # WorkerRunner setup/on_ready can fail with workers already launched.
        pending.append(asyncio.create_task(late_turn()))
        raise RuntimeError("fictional runner startup error")

    try:
        with pytest.raises(RuntimeError, match="fictional runner startup error"):
            await runtime.run(scenario)
        runtime.sessions.finalize.assert_not_awaited()
    finally:
        release_turn.set()
        await asyncio.gather(*pending)
    staging = runtime.artifact_root / ".staging" / str(runtime.ctx.session_id)
    assert "Captured before failed cleanup" in (
        staging / "transcripts" / "transcript.txt"
    ).read_text(encoding="utf-8")
    assert not (runtime.artifact_root / "conversations" / str(runtime.ctx.session_id)).exists()


async def test_departure_during_flow_initialization_prevents_model_warmup(
    call_runtime, monkeypatch
):
    runtime = call_runtime
    runtime.settings.llm_provider = LlmProvider.OPENAI_COMPAT
    runtime.settings.llm_warmup = True
    runtime.settings.llm_api_key = SecretStr("fictional-unused-key")
    runtime.settings.llm_base_url = "https://model.example.invalid"
    runtime.settings.llm_model = "fictional-model"
    warmup = AsyncMock()
    monkeypatch.setattr(bot, "warm_prompt_cache", warmup)

    async def leave_during_initialization(_entry):
        await runtime.transport.handlers["on_participant_left"](
            runtime.transport, "caller", "normal"
        )

    runtime.flow.initialize.side_effect = leave_during_initialization

    async def scenario():
        runtime.participant.attributes["sip.callStatus"] = "active"
        await runtime.transport.handlers["on_first_participant_joined"](runtime.transport, "caller")

    await runtime.run(scenario)
    assert runtime.sessions.finalize.await_args.kwargs["answered"] is True
    runtime.flow.initialize.assert_awaited_once()
    warmup.assert_not_called()
    runtime.worker.create_task.assert_not_called()


async def test_session_start_error_never_runs_pipeline_or_admits_caller(call_runtime):
    runtime = call_runtime
    runtime.sessions.create.side_effect = RuntimeError("fictional persistence failure")
    with pytest.raises(RuntimeError, match="fictional persistence failure"):
        await runtime.run(AsyncMock())
    runtime.runner.run.assert_not_awaited()
    runtime.flow.initialize.assert_not_awaited()
    runtime.sessions.finalize.assert_not_awaited()
    runtime.sessions.aclose.assert_awaited_once()


@pytest.mark.parametrize("ending", ["participant_left", "pipeline_finished"])
async def test_final_aggregator_turns_are_uploaded_after_pipeline_cleanup(call_runtime, ending):
    runtime = call_runtime
    flush_started, release_flush = asyncio.Event(), asyncio.Event()
    pending = []

    async def final_turns():
        flush_started.set()
        await release_flush.wait()
        # Emitted during CancelFrame/EndFrame handling, as asynchronous Pipecat
        # callbacks. Event timestamps, rather than callback order, are canonical.
        await runtime.assistant.handlers["on_assistant_turn_stopped"](
            runtime.assistant,
            SimpleNamespace(
                content="Final answer", timestamp="2026-10-05T12:00:03Z", interrupted=True
            ),
        )
        await runtime.user.handlers["on_user_turn_stopped"](
            runtime.user,
            None,
            SimpleNamespace(content="Final caller turn", timestamp="2026-10-05T12:00:02Z"),
        )

    async def queue_cancel():
        # cancel() schedules shutdown; it does not wait for aggregator cleanup.
        pending.append(asyncio.create_task(final_turns()))
        await flush_started.wait()

    runtime.worker.cancel.side_effect = queue_cancel

    async def scenario():
        runtime.participant.attributes["sip.callStatus"] = "active"
        await runtime.transport.handlers["on_first_participant_joined"](runtime.transport, "caller")
        await runtime.user.handlers["on_user_turn_stopped"](
            runtime.user,
            None,
            SimpleNamespace(content="Opening turn", timestamp="2026-10-05T12:00:01Z"),
        )
        try:
            if ending == "participant_left":
                await runtime.transport.handlers["on_participant_left"](
                    runtime.transport, "caller", "normal"
                )
            else:
                await queue_cancel()
            await runtime.worker.handlers["on_pipeline_finished"](runtime.worker, None)
            # Publishing at either callback races callbacks still being drained.
            runtime.sessions.finalize.assert_not_awaited()
        finally:
            release_flush.set()
            await asyncio.gather(*pending)
        # Real WorkerRunner returns only after the processors await event tasks.

    await runtime.run(scenario)
    transcript = (
        runtime.artifact_root
        / "conversations"
        / str(runtime.ctx.session_id)
        / "transcripts"
        / "transcript.txt"
    )
    assert transcript.read_text(encoding="utf-8").splitlines() == [
        "[2026-10-05T12:00:01Z] user: Opening turn",
        "[2026-10-05T12:00:02Z] user: Final caller turn",
        "[2026-10-05T12:00:03Z] assistant [interrupted]: Final answer",
    ]
    runtime.sessions.finalize.assert_awaited_once()
    assert not (runtime.artifact_root / ".staging" / str(runtime.ctx.session_id)).exists()


async def test_call_owner_cancellation_waits_for_last_transcript_callback(call_runtime):
    runtime = call_runtime
    running, cancel_requested, release_flush = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def cancel_pipeline():
        cancel_requested.set()

    runtime.worker.cancel.side_effect = cancel_pipeline

    async def scenario():
        running.set()
        await cancel_requested.wait()
        await release_flush.wait()
        await runtime.user.handlers["on_user_turn_stopped"](
            runtime.user,
            None,
            SimpleNamespace(
                content="Last turn during disconnect", timestamp="2026-10-05T12:00:01Z"
            ),
        )

    call = asyncio.create_task(runtime.run(scenario))
    try:
        await running.wait()
        call.cancel()
        await cancel_requested.wait()
        runtime.sessions.finalize.assert_not_awaited()
        assert not call.done()
        call.cancel()  # Repeated room-finished cancellation cannot cut the flush short.
        release_flush.set()
        with pytest.raises(asyncio.CancelledError):
            await call
    finally:
        release_flush.set()
        if not call.done():
            call.cancel()
        await asyncio.gather(call, return_exceptions=True)
    transcript = (
        runtime.artifact_root
        / "conversations"
        / str(runtime.ctx.session_id)
        / "transcripts"
        / "transcript.txt"
    )
    assert "Last turn during disconnect" in transcript.read_text(encoding="utf-8")
    runtime.sessions.finalize.assert_awaited_once()
    runtime.sessions.aclose.assert_awaited_once()


async def test_caller_leaving_during_recovery_keeps_gates_shut_and_saves_final_turn(
    call_runtime, monkeypatch
):
    runtime = call_runtime
    control = VoiceController(
        AsyncMock(return_value=VoiceControlSnapshot(0, "ai")), AsyncMock(return_value=True)
    )
    policies = []
    entered, release = asyncio.Event(), asyncio.Event()
    terminal = AsyncMock()

    def capture_policy(_control, *args, **kwargs):
        # Exercise the real ownership/policy state machine with deterministic
        # provider ports and the real bot's announcement/liveness wrappers.
        kwargs["interrupt_reply"] = AsyncMock()
        policy = VoiceFailurePolicy(control, *args, **kwargs)
        policies.append(policy)
        return policy

    monkeypatch.setattr(bot, "VoiceFailurePolicy", capture_policy)

    async def recovery_audio():
        entered.set()
        await release.wait()

    async def scenario():
        runtime.participant.attributes["sip.callStatus"] = "active"
        await runtime.transport.handlers["on_first_participant_joined"](runtime.transport, "caller")
        policy = policies[0]
        recovery = asyncio.create_task(
            runtime.worker.handlers["on_pipeline_error"](
                runtime.worker,
                ErrorFrame(
                    "synthetic provider drop",
                    processor=policy.providers[0],
                    category=ErrorCategory.CONNECTIVITY,
                ),
            )
        )
        try:
            async with asyncio.timeout(1):
                await entered.wait()
            assert control.recovering
            await runtime.transport.handlers["on_participant_left"](
                runtime.transport, "caller", "normal"
            )
            await runtime.user.handlers["on_user_turn_stopped"](
                runtime.user,
                None,
                SimpleNamespace(content="Final caller turn during recovery", timestamp=None),
            )
            release.set()
            await recovery
            assert control.recovering and policy.transient_recoveries == 0
            business_action = AsyncMock()
            with pytest.raises(asyncio.CancelledError):
                await control.action(business_action)
            business_action.assert_not_awaited()
            # Even a terminal fallback requested after this point cannot mint
            # another announcement leg in the departed caller's room.
            await policy.announce_failure()
            terminal.assert_not_awaited()
            runtime.sessions.finalize.assert_not_awaited()
        finally:
            release.set()
            await asyncio.gather(recovery, return_exceptions=True)

    with pytest.raises(RuntimeError, match="voice pipeline lost a required processor"):
        await runtime.run(scenario, on_recovery=recovery_audio, on_failure=terminal)
    transcript = (
        runtime.artifact_root
        / "conversations"
        / str(runtime.ctx.session_id)
        / "transcripts"
        / "transcript.txt"
    )
    assert "Final caller turn during recovery" in transcript.read_text(encoding="utf-8")
    runtime.sessions.finalize.assert_awaited_once()
    assert not (runtime.artifact_root / ".staging" / str(runtime.ctx.session_id)).exists()
