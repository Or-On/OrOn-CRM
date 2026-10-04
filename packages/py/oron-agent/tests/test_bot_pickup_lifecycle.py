"""Run the real bot callbacks against deterministic, provider-free call lifecycles."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from oron_agent import bot
from oron_agent.config import Settings
from oron_agent.llm import LlmProvider
from oron_common import CallContext, Direction
from oron_flows import EXAMPLE_EN, expand
from oron_sessions import SessionStatus
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

    async def run(scenario):
        runner.run.side_effect = scenario
        await bot.run_bot(
            transport, ctx, settings, room="fictional-room", g2p=None, sessions=sessions
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


async def test_room_finished_cancellation_interrupts_pickup_and_finalizes(call_runtime):
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
    runtime.sessions.finalize.assert_awaited_once()
    persisted = runtime.sessions.finalize.await_args.kwargs
    assert persisted["answered"] is False
    assert persisted["usage"].call_seconds == 0
    runtime.flow.initialize.assert_not_awaited()
    runtime.sessions.aclose.assert_awaited_once()


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
