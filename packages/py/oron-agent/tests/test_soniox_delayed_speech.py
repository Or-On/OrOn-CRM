"""Real loopback websockets exercise pickup latency and provider socket expiry."""

import asyncio
import base64
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from oron_agent.tts import SonioxUnpointedContextTTSService
from pipecat.clocks.system_clock import SystemClock
from pipecat.frames.frames import (
    CancelFrame,
    ErrorFrame,
    StartFrame,
    TTSAudioRawFrame,
    TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameProcessorSetup
from pipecat.utils.asyncio.task_manager import TaskManager
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed
from websockets.protocol import State

PCM = b"\x31\x00" * 320


class Provider:
    def __init__(self):
        self.connections = []
        self.messages = []
        self.timeouts = 0

    async def handle(self, socket):
        self.connections.append(socket)
        configured = set()
        try:
            # Accelerated version of the documented ~10s authentication timer.
            async with asyncio.timeout(0.1):
                config = json.loads(await socket.recv())
            assert config["api_key"] == "offline-fixture"
            assert config["return_timestamps"] is False
            self.messages.append(config)
            configured.add(config["stream_id"])
            async for payload in socket:
                msg = json.loads(payload)
                self.messages.append(msg)
                if "api_key" in msg:
                    configured.add(msg["stream_id"])
                elif "text" in msg:
                    assert msg["stream_id"] in configured, "text without authenticated config"
                    if msg["text"]:
                        await socket.send(
                            json.dumps(
                                {
                                    "stream_id": msg["stream_id"],
                                    "audio": base64.b64encode(PCM).decode(),
                                }
                            )
                        )
                    if msg["text_end"]:
                        await socket.send(
                            json.dumps({"stream_id": msg["stream_id"], "terminated": True})
                        )
                        configured.remove(msg["stream_id"])
        except TimeoutError:
            self.timeouts += 1
            await socket.close(1001, "Timeout")
        except ConnectionClosed:
            pass


@asynccontextmanager
async def service(monkeypatch):
    provider = Provider()
    async with serve(provider.handle, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        tts = SonioxUnpointedContextTTSService(
            api_key="offline-fixture", url=f"ws://127.0.0.1:{port}", sample_rate=24000
        )
        manager = TaskManager()
        errors = AsyncMock()
        monkeypatch.setattr(tts, "_report_error", errors)
        await tts.setup(
            FrameProcessorSetup(
                clock=SystemClock(), task_manager=manager, pipeline_worker=SimpleNamespace()
            )
        )
        try:
            yield tts, provider, errors
        finally:
            await tts.cleanup()
            assert tts._websocket is None
            assert tts._receive_task is None and tts._keepalive_task is None
            assert not manager.current_tasks()


async def speak(tts, context, text="שלום, זו בדיקת קול."):
    await tts.create_audio_context(context)
    queue = tts._audio_contexts[context]
    frames = [frame async for frame in tts.run_tts(text, context)]
    assert not any(isinstance(frame, ErrorFrame) for frame in frames)
    await tts.flush_audio(context)
    received = []
    async with asyncio.timeout(3):
        while (frame := await queue.get()) is not None:
            received.append(frame)
    assert any(isinstance(frame, TTSStoppedFrame) for frame in received)
    assert b"".join(frame.audio for frame in received if isinstance(frame, TTSAudioRawFrame)) == PCM
    return queue


async def test_pickup_and_empty_turn_can_exceed_provider_auth_deadline(monkeypatch):
    async with service(monkeypatch) as (tts, provider, errors):
        await tts.on_turn_context_created("tool-only")
        await tts.flush_audio("tool-only")
        await asyncio.sleep(0.15)
        assert provider.connections == []
        assert tts._websocket is None
        await tts.on_turn_context_created("greeting")
        await asyncio.sleep(0.15)
        await speak(tts, "greeting")
        assert provider.timeouts == 0
        assert [msg["stream_id"] for msg in provider.messages] == ["greeting"] * 3
        errors.assert_not_awaited()


async def test_idle_close_reconnects_without_losing_new_context(monkeypatch):
    async with service(monkeypatch) as (tts, provider, errors):
        await speak(tts, "first")
        await provider.connections[0].close(1001, "idle expiry")
        await tts._receive_task
        await tts.create_audio_context("second")
        queue = tts._audio_contexts["second"]
        frames = [frame async for frame in tts.run_tts("שיחה שנייה.", "second")]
        assert frames == [None]
        assert tts._audio_contexts["second"] is queue
        async with asyncio.timeout(3):
            frame = await queue.get()
        assert isinstance(frame, TTSAudioRawFrame) and frame.audio == PCM
        assert len(provider.connections) == 2
        await tts.flush_audio("second")
        async with asyncio.timeout(3):
            while await queue.get() is not None:
                pass
        errors.assert_not_awaited()


async def test_idle_socket_closing_during_config_gets_one_safe_retry(monkeypatch):
    async with service(monkeypatch) as (tts, provider, errors):
        await speak(tts, "first")
        original = tts._send_config
        raced = False

        async def config_after_expiry(context):
            nonlocal raced
            if not raced:
                raced = True
                await provider.connections[0].close(1001, "idle expiry")
                await tts._websocket.wait_closed()
            await original(context)

        monkeypatch.setattr(tts, "_send_config", config_after_expiry)
        await speak(tts, "second")
        assert len(provider.connections) == 2
        assert [m["text"] for m in provider.messages if m.get("text")] == [
            "שלום, זו בדיקת קול.",
            "שלום, זו בדיקת קול.",
        ]
        errors.assert_not_awaited()


async def test_active_connection_loss_stops_audio_without_replaying_speech(monkeypatch):
    async with service(monkeypatch) as (tts, provider, errors):
        await tts.create_audio_context("active")
        queue = tts._audio_contexts["active"]
        assert [f async for f in tts.run_tts("כבר נשמע.", "active")] == [None]
        async with asyncio.timeout(3):
            assert isinstance(await queue.get(), TTSAudioRawFrame)
        await provider.connections[0].close(1001, "lost while speaking")
        await tts._receive_task
        assert isinstance(await queue.get(), TTSStoppedFrame)
        assert await queue.get() is None
        errors.assert_awaited_once()
        frames = [f async for f in tts.run_tts("אסור להשמיע מחדש.", "active")]
        assert frames == [None]
        assert errors.await_count == 2
        assert len(provider.connections) == 1
        assert [m["text"] for m in provider.messages if m.get("text")] == ["כבר נשמע."]
        await speak(tts, "fresh-recovery")
        assert len(provider.connections) == 2
        assert not tts._stopping


async def test_ambiguous_send_is_not_replayed_but_a_new_turn_can_recover(monkeypatch):
    async with service(monkeypatch) as (tts, provider, errors):
        await speak(tts, "first")
        original = tts._websocket.send
        await tts.create_audio_context("ambiguous")
        queue = tts._audio_contexts["ambiguous"]

        async def send_then_fail(payload):
            await original(payload)
            if json.loads(payload).get("text"):
                # Peer accepted the text and generated audio, but the caller
                # sees a send failure. Replaying would duplicate real speech.
                async with asyncio.timeout(3):
                    assert isinstance(await queue.get(), TTSAudioRawFrame)
                raise ConnectionError("synthetic ambiguous write")

        monkeypatch.setattr(tts._websocket, "send", send_then_fail)
        await tts.tts_process_generator("ambiguous", tts.run_tts("נשלח פעם אחת.", "ambiguous"))
        errors.assert_awaited_once()
        assert isinstance(errors.await_args.args[0], ErrorFrame)
        assert isinstance(await queue.get(), TTSStoppedFrame)
        assert await queue.get() is None
        assert queue.empty()  # error was reported directly, not lost after the sentinel
        await speak(tts, "fresh")
        assert [m["text"] for m in provider.messages if m.get("text")] == [
            "שלום, זו בדיקת קול.",
            "נשלח פעם אחת.",
            "שלום, זו בדיקת קול.",
        ]
        assert len(provider.connections) == 2
        errors.assert_awaited_once()


@pytest.mark.parametrize("already_connected", [False, True])
async def test_cancel_closes_resources_and_prevents_late_speech(monkeypatch, already_connected):
    async with service(monkeypatch) as (tts, provider, errors):
        if already_connected:
            await speak(tts, "first")
        await tts.cancel(CancelFrame())
        await tts.create_audio_context("late")
        assert [f async for f in tts.run_tts("לא לשלוח.", "late")] == []
        assert tts._websocket is None
        assert all(socket.state is State.CLOSED for socket in provider.connections)
        assert len(provider.connections) == int(already_connected)
        errors.assert_not_awaited()


async def test_cancel_during_connect_does_not_authenticate_or_send_text(monkeypatch):
    async with service(monkeypatch) as (tts, provider, errors):
        connecting, release = asyncio.Event(), asyncio.Event()
        original = tts._websocket_connect

        async def connect(url):
            connecting.set()
            await release.wait()
            return await original(url)

        monkeypatch.setattr(tts, "_websocket_connect", connect)
        await tts.create_audio_context("cancelled")

        async def run():
            return [frame async for frame in tts.run_tts("לא לשלוח.", "cancelled")]

        sender = asyncio.create_task(run())
        await connecting.wait()
        cancel = asyncio.create_task(tts.cancel(CancelFrame()))
        await asyncio.sleep(0)
        release.set()
        async with asyncio.timeout(3):
            assert await sender == []
            await cancel
        assert provider.messages == []
        errors.assert_not_awaited()


@pytest.mark.parametrize("action", ["cancel", "cleanup"])
async def test_terminal_teardown_fences_sends_before_audio_task_stops(monkeypatch, action):
    async with service(monkeypatch) as (tts, provider, errors):
        await tts.start(StartFrame())
        assert tts._audio_context_task is not None
        entered, release = asyncio.Event(), asyncio.Event()
        original = tts._stop_audio_context_task

        async def delayed_audio_stop():
            entered.set()
            await release.wait()
            await original()

        monkeypatch.setattr(tts, "_stop_audio_context_task", delayed_audio_stop)
        terminal = asyncio.create_task(
            tts.cancel(CancelFrame()) if action == "cancel" else tts.cleanup()
        )
        await entered.wait()
        await tts.create_audio_context("late")
        assert [frame async for frame in tts.run_tts("לא לשלוח.", "late")] == []
        assert provider.connections == []
        release.set()
        async with asyncio.timeout(3):
            await terminal
        errors.assert_not_awaited()
