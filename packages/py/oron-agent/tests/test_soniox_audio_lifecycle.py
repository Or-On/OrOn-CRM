"""Installed Soniox SDK serialization and cancellation with private fake sockets."""

import asyncio
import base64
import json
from contextlib import suppress
from unittest.mock import AsyncMock

from oron_agent.tts import SonioxUnpointedContextTTSService
from pipecat.frames.frames import InterruptionFrame, TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection
from websockets.protocol import State


class Socket:
    state = State.OPEN

    def __init__(self, messages=()):
        self.messages = iter(messages)
        self.sent = []

    async def send(self, payload):
        self.sent.append(json.loads(payload))

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return json.dumps(next(self.messages))
        except StopIteration:
            raise StopAsyncIteration from None


def audio(context, payload):
    return {"stream_id": context, "audio": base64.b64encode(payload).decode()}


async def test_actual_soniox_barge_in_discards_old_queue_and_late_audio(monkeypatch):
    tts = SonioxUnpointedContextTTSService(api_key="offline-fixture", sample_rate=24000)
    tts._sample_rate = 24000
    tts._websocket = Socket()
    monkeypatch.setattr(tts, "create_task", asyncio.create_task)
    monkeypatch.setattr(tts, "stop_all_metrics", AsyncMock())
    monkeypatch.setattr(tts, "stop_ttfb_metrics", AsyncMock())
    await tts.create_audio_context("old")
    tts._configured_contexts.add("old")
    old_queue = tts._audio_contexts["old"]
    await tts.append_to_audio_context(
        "old", TTSAudioRawFrame(b"\x01\x00", 24000, 1, context_id="old")
    )
    try:
        await tts._handle_interruption(InterruptionFrame(), FrameDirection.DOWNSTREAM)
        assert {"stream_id": "old", "cancel": True} in tts._websocket.sent
        assert not tts.audio_context_available("old")
        await tts.create_audio_context("new")
        fresh_audio = b"\x02\x00" * 320
        tts._websocket.messages = iter([audio("old", b"\x03\x00"), audio("new", fresh_audio)])
        await tts._receive_messages()
        fresh_queue = tts._audio_contexts["new"]
        frames = []
        while not fresh_queue.empty():
            frames.append(fresh_queue.get_nowait())
        emitted = [frame for frame in frames if isinstance(frame, TTSAudioRawFrame)]
        assert [
            (frame.context_id, frame.sample_rate, frame.num_channels, frame.audio)
            for frame in emitted
        ] == [("new", 24000, 1, fresh_audio)]
        assert old_queue.qsize() == 1  # obsolete buffered audio never consumed into the new queue
    finally:
        for task in (tts._audio_context_task,):
            if task is not None:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task


async def test_actual_livekit_output_clears_native_buffer_after_local_interruption(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock

    from pipecat.transports.base_output import BaseOutputTransport
    from pipecat.transports.livekit.transport import LiveKitOutputTransport, LiveKitParams

    order = []
    buffered = [b"old audio submitted but not yet played"]

    async def cancel_local_tasks(_self, _frame, _direction):
        order.append("local producers stopped")

    def clear():
        order.append("native buffer cleared")
        buffered.clear()

    monkeypatch.setattr(BaseOutputTransport, "process_frame", cancel_local_tasks)
    output = LiveKitOutputTransport(
        Mock(),
        SimpleNamespace(_audio_source=SimpleNamespace(clear_queue=clear)),
        LiveKitParams(audio_out_enabled=True),
    )
    await output.process_frame(InterruptionFrame(), FrameDirection.DOWNSTREAM)
    assert order == ["local producers stopped", "native buffer cleared"]
    assert buffered == []


async def test_identical_provider_stream_ids_stay_isolated_between_call_instances(monkeypatch):
    calls = [SonioxUnpointedContextTTSService(api_key="offline-fixture") for _ in range(2)]
    expected = [b"\x01\x00" * 320, b"\x02\x00" * 320]
    for index, tts in enumerate(calls):
        tts._sample_rate = 24000
        monkeypatch.setattr(tts, "stop_ttfb_metrics", AsyncMock())
        await tts.create_audio_context("same-provider-stream-id")
        tts._websocket = Socket([audio("same-provider-stream-id", expected[index])])
    await asyncio.gather(*(tts._receive_messages() for tts in calls))
    for index, tts in enumerate(calls):
        frame = tts._audio_contexts["same-provider-stream-id"].get_nowait()
        assert isinstance(frame, TTSAudioRawFrame) and frame.audio == expected[index]
        assert tts._audio_contexts["same-provider-stream-id"].empty()
