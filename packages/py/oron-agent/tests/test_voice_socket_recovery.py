"""Abrupt loopback socket loss reaches the real worker's recovery policy.

Only the Soniox wire is simulated. Pipecat owns the receiver, audio queues,
upstream ErrorFrame dispatch, interruption barrier, and terminal teardown.
"""

import asyncio
import base64
import json
from unittest.mock import AsyncMock

import pytest
from oron_agent.readiness import bind_pipeline_readiness
from oron_agent.tts import SonioxUnpointedContextTTSService
from oron_agent.voice_control import VoiceController, VoiceControlSnapshot
from oron_agent.voice_failure import VoiceFailurePolicy
from pipecat.frames.frames import TTSAudioRawFrame, TTSSpeakFrame, TTSStoppedFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.utils.errors import ErrorCategory
from pipecat.workers.runner import WorkerRunner
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

PCM = b"\x41\x00" * 480


class FaultProvider:
    """Leave selected speech incomplete until the test aborts its actual TCP socket."""

    def __init__(self):
        self.connections = []
        self.messages = []

    async def handle(self, socket):
        self.connections.append(socket)
        configured, incomplete = set(), set()
        try:
            async for payload in socket:
                message = json.loads(payload)
                self.messages.append(message)
                context = message.get("stream_id")
                if "api_key" in message:
                    assert message["api_key"] == "offline-fixture"
                    assert message["return_timestamps"] is False
                    configured.add(context)
                elif "text" in message:
                    assert context in configured
                    if text := message["text"]:
                        if text.startswith("Partial"):
                            incomplete.add(context)
                        await socket.send(
                            json.dumps(
                                {
                                    "stream_id": context,
                                    "audio": base64.b64encode(PCM).decode(),
                                }
                            )
                        )
                    if message["text_end"] and context not in incomplete:
                        await socket.send(json.dumps({"stream_id": context, "terminated": True}))
        except ConnectionClosed:
            pass


class AudioSink(FrameProcessor):
    def __init__(self):
        super().__init__()
        self.audio = asyncio.Queue()
        self.stopped = asyncio.Queue()

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction is FrameDirection.DOWNSTREAM:
            if isinstance(frame, TTSAudioRawFrame):
                self.audio.put_nowait(frame)
            elif isinstance(frame, TTSStoppedFrame):
                self.stopped.put_nowait(frame)
        await self.push_frame(frame, direction)


class CaptureStage(FrameProcessor):
    """A provider stage that can report a simultaneous capture outage upstream."""

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


@pytest.mark.parametrize("simultaneous_capture_drop", [False, True])
async def test_abrupt_speech_loss_recovers_new_turn_once_then_ends_on_second_loss(
    simultaneous_capture_drop,
):
    provider = FaultProvider()
    async with serve(provider.handle, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        tts = SonioxUnpointedContextTTSService(
            api_key="offline-fixture", url=f"ws://127.0.0.1:{port}", sample_rate=24000
        )
        capture, sink = CaptureStage(), AudioSink()
        worker = PipelineWorker(Pipeline([capture, tts, sink]))
        ready, capture_error_handled = asyncio.Event(), asyncio.Event()
        bind_pipeline_readiness(worker, ready)
        control = VoiceController(
            AsyncMock(return_value=VoiceControlSnapshot(0, "ai")),
            AsyncMock(return_value=True),
        )
        control.attach([capture, tts, sink])
        announcements, errors = [], []
        handled = asyncio.Queue()

        async def prepare(frame):
            assert frame.processor is tts
            if simultaneous_capture_drop:
                # Actual worker dispatch while the first provider reset is
                # pending. This second frame belongs to the same outage.
                await capture.push_error(
                    "Synthetic concurrent capture outage", category=ErrorCategory.CONNECTIVITY
                )
                await capture_error_handled.wait()
            await tts.prepare_recovery()
            return True

        async def recovery_audio():
            assert tts._websocket is None
            assert not tts._stopping
            announcements.append("recovery")

        async def terminal_audio():
            announcements.append("terminal")

        policy = VoiceFailurePolicy(
            control,
            worker.cancel,
            terminal_audio,
            control.interrupt_reply,
            (capture, tts),
            prepare_recovery=prepare,
            announce_recovery=recovery_audio,
        )

        @worker.event_handler("on_pipeline_error")
        async def on_error(_worker, frame):
            errors.append(frame)
            await policy.handle(frame)
            if frame.processor is capture:
                capture_error_handled.set()
            else:
                handled.put_nowait(frame)

        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        running = asyncio.create_task(runner.run())
        try:
            async with asyncio.timeout(10):
                await ready.wait()
                assert await control.refresh()
                await worker.queue_frame(TTSSpeakFrame("Partial first reply."))
                first_audio = await sink.audio.get()
                assert first_audio.audio == PCM
                # An abrupt TCP close, not a graceful 1001 idle-expiry frame.
                # The caller has already received a real synthesized prefix.
                provider.connections[0].transport.abort()
                first_error = await handled.get()
                assert first_error.processor is tts
                assert first_error.category is ErrorCategory.CONNECTIVITY
                assert announcements == ["recovery"]
                assert policy.transient_recoveries == 1 and not policy.failed
                assert not running.done()
                assert len(provider.connections) == 1  # reset opens no idle socket

                await worker.queue_frame(TTSSpeakFrame("Fresh caller turn."))
                fresh_audio = await sink.audio.get()
                assert fresh_audio.audio == PCM
                assert fresh_audio.context_id != first_audio.context_id
                while (await sink.stopped.get()).context_id != fresh_audio.context_id:
                    pass
                assert len(provider.connections) == 2

                await worker.queue_frame(TTSSpeakFrame("Partial second reply."))
                second_audio = await sink.audio.get()
                assert second_audio.audio == PCM
                provider.connections[1].transport.abort()
                await handled.get()
                await running
            assert policy.failed and policy.transient_recoveries == 1
            assert announcements == ["recovery", "terminal"]
            assert len(errors) == (3 if simultaneous_capture_drop else 2)
            assert [message["text"] for message in provider.messages if message.get("text")] == [
                "Partial first reply.",
                "Fresh caller turn.",
                "Partial second reply.",
            ]
            assert len(provider.connections) == 2  # no replay or third reconnect
            assert tts._websocket is None
            assert tts._receive_task is None and tts._keepalive_task is None
        finally:
            if not running.done():
                await worker.cancel()
            async with asyncio.timeout(5):
                await running
