"""Offline ownership/cancellation tests; fake transport is not remote playback."""

import asyncio
from unittest.mock import AsyncMock

import pytest
from oron_agent.voice_control import VoiceControlGate, VoiceController, VoiceControlSnapshot
from pipecat.frames.frames import (
    InputAudioRawFrame,
    InterruptionFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


def controller():
    read = AsyncMock(return_value=VoiceControlSnapshot(0, "ai"))
    ack = AsyncMock(return_value=True)
    return VoiceController(read, ack), read, ack


async def test_pause_waits_for_local_cancellation_before_acknowledging():
    control, read, ack = controller()
    await control.refresh()
    running, cancelled = asyncio.Event(), asyncio.Event()

    async def pending_tool():
        running.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    pending = asyncio.create_task(control.action(pending_tool))
    await running.wait()
    read.return_value = VoiceControlSnapshot(1, "paused")
    await control.refresh()

    assert control.paused
    assert cancelled.is_set()
    with pytest.raises(asyncio.CancelledError):
        await pending
    ack.assert_awaited_with(1, "paused")


async def test_resume_requires_new_explicit_epoch_after_database_outage():
    control, read, ack = controller()
    await control.refresh()
    assert not control.paused
    old_generation = control.generation
    read.side_effect = RuntimeError("fixture outage")
    await control.refresh()
    assert control.paused
    read.side_effect = None
    await control.refresh()
    assert control.paused
    ack.assert_awaited_with(0, "paused")
    read.return_value = VoiceControlSnapshot(1, "ai")
    await control.refresh()
    assert not control.paused
    assert control.generation > old_generation


async def test_revoked_resume_and_stale_ack_never_enable_ai():
    control, read, ack = controller()
    read.return_value = VoiceControlSnapshot(4, "ai", resume_authorized=False)
    await control.refresh()
    assert control.paused
    read.return_value = VoiceControlSnapshot(4, "ai")
    await control.refresh()
    assert control.paused
    read.return_value = VoiceControlSnapshot(5, "ai")
    ack.return_value = False
    await control.refresh()
    assert control.paused


async def test_paused_action_is_not_invoked():
    control, read, _ = controller()
    read.return_value = VoiceControlSnapshot(1, "paused")
    operation = AsyncMock()
    with pytest.raises(asyncio.CancelledError):
        await control.action(operation)
    operation.assert_not_awaited()


async def test_gates_drop_audio_and_stale_synthesis_context_after_resume(monkeypatch):
    control, read, _ = controller()
    gate = VoiceControlGate(control, audio=True)
    push = AsyncMock()
    monkeypatch.setattr(gate, "push_frame", push)
    await control.refresh()
    await gate.process_frame(TTSStartedFrame(context_id="old"), FrameDirection.DOWNSTREAM)
    old_text = LLMTextFrame("old reply")
    await gate.process_frame(old_text, FrameDirection.DOWNSTREAM)
    push.reset_mock()
    read.return_value = VoiceControlSnapshot(1, "paused")
    await control.refresh()
    for frame in [
        InputAudioRawFrame(audio=b"\x00\x00", sample_rate=16000, num_channels=1),
        LLMTextFrame("should not speak"),
    ]:
        await gate.process_frame(frame, FrameDirection.DOWNSTREAM)
    push.assert_not_awaited()
    read.return_value = VoiceControlSnapshot(2, "ai")
    await control.refresh()
    await gate.process_frame(old_text, FrameDirection.DOWNSTREAM)
    await gate.process_frame(
        TTSAudioRawFrame(audio=b"\x00\x00", sample_rate=16000, num_channels=1, context_id="old"),
        FrameDirection.DOWNSTREAM,
    )
    push.assert_not_awaited()
    await gate.process_frame(TTSStartedFrame(context_id="new"), FrameDirection.DOWNSTREAM)
    assert push.await_count == 1


@pytest.mark.parametrize("context_id", [None, "unknown", "delayed-old"])
async def test_unknown_audio_is_not_relabeled_as_resumed_generation(monkeypatch, context_id):
    control, read, _ = controller()
    gate = VoiceControlGate(control, audio=True)
    push = AsyncMock()
    monkeypatch.setattr(gate, "push_frame", push)
    await control.refresh()
    read.return_value = VoiceControlSnapshot(1, "paused")
    await control.refresh()
    read.return_value = VoiceControlSnapshot(2, "ai")
    await control.refresh()
    await gate.process_frame(
        TTSAudioRawFrame(
            audio=b"\x00\x00", sample_rate=16000, num_channels=1, context_id=context_id
        ),
        FrameDirection.DOWNSTREAM,
    )
    push.assert_not_awaited()


async def test_old_llm_callback_keeps_producer_generation_after_resume(monkeypatch):
    control, read, _ = controller()
    producer = FrameProcessor()
    control.track_producer(producer)
    gate = VoiceControlGate(control, generated=True)
    push = AsyncMock()
    monkeypatch.setattr(gate, "push_frame", push)
    await control.refresh()
    entered, release = asyncio.Event(), asyncio.Event()

    async def delayed_producer():
        request = LLMTextFrame("fixture request")
        request.metadata["ownership_generation"] = control.generation
        await producer._call_event_handler("on_before_process_frame", request)
        entered.set()
        await release.wait()
        frame = LLMFullResponseStartFrame()
        await producer._call_event_handler("on_before_push_frame", frame)
        await gate.process_frame(frame, FrameDirection.DOWNSTREAM)

    task = asyncio.create_task(delayed_producer())
    await entered.wait()
    read.return_value = VoiceControlSnapshot(1, "paused")
    await control.refresh()
    read.return_value = VoiceControlSnapshot(2, "ai")
    await control.refresh()
    release.set()
    await task
    push.assert_not_awaited()
    await gate.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    push.assert_not_awaited()


async def test_audio_generation_comes_from_original_synthesis_request(monkeypatch):
    control, read, _ = controller()
    producer = FrameProcessor()
    producer._register_event_handler("on_tts_request")
    control.track_producer(producer, synthesis=True)
    gate = VoiceControlGate(control, audio=True)
    push = AsyncMock()
    monkeypatch.setattr(gate, "push_frame", push)
    await control.refresh()
    request = LLMTextFrame("not retained")
    request.metadata["ownership_generation"] = control.generation
    await producer._call_event_handler("on_before_process_frame", request)
    await producer._call_event_handler("on_tts_request", "old", "not retained")
    await producer.cleanup()  # Drain asynchronous SDK event callbacks.
    read.return_value = VoiceControlSnapshot(1, "paused")
    await control.refresh()
    read.return_value = VoiceControlSnapshot(2, "ai")
    await control.refresh()
    frame = TTSAudioRawFrame(audio=b"\x00\x00", sample_rate=16000, num_channels=1, context_id="old")
    await producer._call_event_handler("on_before_push_frame", frame)
    await gate.process_frame(frame, FrameDirection.DOWNSTREAM)
    push.assert_not_awaited()
    request.metadata["ownership_generation"] = control.generation
    await producer._call_event_handler("on_before_process_frame", request)
    await producer._call_event_handler("on_tts_request", "new", "not retained")
    await producer.cleanup()
    frame = TTSAudioRawFrame(audio=b"\x00\x00", sample_rate=16000, num_channels=1, context_id="new")
    await producer._call_event_handler("on_before_push_frame", frame)
    await gate.process_frame(frame, FrameDirection.DOWNSTREAM)
    push.assert_awaited_once()


class FakeTransport(FrameProcessor):
    """Emulates the SDK after-process contract and delayed buffer cancellation."""

    def __init__(self):
        super().__init__()
        self.release = asyncio.Event()
        self.entered = asyncio.Event()
        self.buffer = [b"fixture audio"]
        self.pending = []
        self.next_processor = None

    async def queue_frame(self, frame, direction=FrameDirection.DOWNSTREAM, callback=None):
        async def process():
            assert isinstance(frame, InterruptionFrame)
            self.entered.set()
            if self.next_processor is not None:
                await self.next_processor.queue_frame(frame, direction)
            await self.release.wait()
            self.buffer.clear()
            await self._call_event_handler("on_after_process_frame", frame)

        self.pending.append(asyncio.create_task(process()))


async def test_acknowledgement_waits_for_after_process_not_enqueue():
    control, _, ack = controller()
    transport = FakeTransport()
    control.attach([transport])
    refresh = asyncio.create_task(control.refresh())
    await transport.entered.wait()
    assert control.paused
    ack.assert_not_awaited()
    assert transport.buffer
    transport.release.set()
    await refresh
    await asyncio.gather(*transport.pending)
    assert not transport.buffer
    ack.assert_awaited_once_with(0, "ai")
    assert not control.paused


async def test_single_barrier_waits_for_all_processors_without_late_duplicates():
    control, _, ack = controller()
    first, model, output = FakeTransport(), FakeTransport(), FakeTransport()
    first.next_processor = model
    model.next_processor = output
    control.attach([first, model, output])
    refresh = asyncio.create_task(control.refresh())
    await output.entered.wait()
    output.release.set()
    first.release.set()
    await asyncio.gather(*output.pending, *first.pending)
    ack.assert_not_awaited()
    assert control.paused
    model.release.set()
    await refresh
    await asyncio.gather(*model.pending)
    assert [len(processor.pending) for processor in [first, model, output]] == [1, 1, 1]
    assert not control.paused


class FakeParallel(FrameProcessor):
    def __init__(self, children):
        super().__init__()
        self.children = children

    @property
    def processors(self):
        return self.children

    async def queue_frame(self, frame, direction=FrameDirection.DOWNSTREAM, callback=None):
        for child in self.children:
            await child.queue_frame(frame, direction)
        await self._call_event_handler("on_after_process_frame", frame)


async def test_pause_waits_for_slow_stt_inside_parallel_pipeline():
    control, _, ack = controller()
    first, fast, slow, output = (FakeTransport() for _ in range(4))
    branches = FakeParallel([fast, slow])
    first.next_processor = branches
    fast.next_processor = output
    control.attach([first, branches, output])
    refresh = asyncio.create_task(control.refresh())
    await slow.entered.wait()
    await output.entered.wait()
    for processor in [first, fast, output]:
        processor.release.set()
    await asyncio.gather(*first.pending, *fast.pending, *output.pending)
    ack.assert_not_awaited()
    assert control.paused
    slow.release.set()
    await refresh
    await asyncio.gather(*slow.pending)
    assert not control.paused


async def test_fresh_capture_and_cleared_utterance_precede_durable_resume_ack():
    control, _, ack = controller()
    transport = FakeTransport()
    transport.release.set()
    pause, reset, resume = AsyncMock(), AsyncMock(), AsyncMock()
    control.attach([transport], pause_capture=pause, reset_utterance=reset, resume_capture=resume)

    async def acknowledge(epoch, mode):
        assert control.paused
        pause.assert_awaited_once()
        reset.assert_awaited_once()
        resume.assert_awaited_once_with(control.generation)
        assert not transport.buffer
        return True

    ack.side_effect = acknowledge
    await control.refresh()
    assert not control.paused


async def test_failed_capture_restart_keeps_ai_paused_without_ai_ack():
    control, _, ack = controller()
    transport = FakeTransport()
    transport.release.set()
    control.attach(
        [transport], resume_capture=AsyncMock(side_effect=RuntimeError("fixture reconnect"))
    )
    await control.refresh()
    assert control.paused
    ack.assert_not_awaited()


@pytest.mark.parametrize("generation", [None, 1])
async def test_untagged_or_old_final_transcript_is_not_a_new_instruction(monkeypatch, generation):
    control, read, _ = controller()
    await control.refresh()
    read.return_value = VoiceControlSnapshot(1, "paused")
    await control.refresh()
    read.return_value = VoiceControlSnapshot(2, "ai")
    await control.refresh()
    gate = VoiceControlGate(control, recognition=True)
    push = AsyncMock()
    monkeypatch.setattr(gate, "push_frame", push)
    frame = TranscriptionFrame("obsolete instruction", "fixture", "", finalized=True)
    if generation is not None:
        frame.metadata["ownership_generation"] = generation
    await gate.process_frame(frame, FrameDirection.DOWNSTREAM)
    push.assert_not_awaited()
    frame.metadata["ownership_generation"] = control.generation
    await gate.process_frame(frame, FrameDirection.DOWNSTREAM)
    push.assert_awaited_once()


async def test_old_model_callback_cannot_start_an_action_after_resume():
    control, read, _ = controller()
    producer = FrameProcessor()
    control.track_producer(producer)
    await control.refresh()
    entered, release = asyncio.Event(), asyncio.Event()
    operation = AsyncMock()

    async def old_model():
        request = LLMTextFrame("fixture")
        request.metadata["ownership_generation"] = control.generation
        await producer._call_event_handler("on_before_process_frame", request)
        entered.set()
        await release.wait()
        await control.action(operation)

    task = asyncio.create_task(old_model())
    await entered.wait()
    read.return_value = VoiceControlSnapshot(1, "paused")
    await control.refresh()
    read.return_value = VoiceControlSnapshot(2, "ai")
    await control.refresh()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    operation.assert_not_awaited()
