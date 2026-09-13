"""Real installed Soniox parser/lifecycle with fake sockets only."""

import asyncio
import json
from contextlib import suppress
from unittest.mock import AsyncMock, Mock

from oron_agent.ownership_stt import OwnershipSonioxSTTService
from pipecat.frames.frames import InterimTranscriptionFrame, TranscriptionFrame
from pipecat.services.soniox.stt import SonioxSTTService
from websockets.protocol import State


class FakeSocket:
    def __init__(self):
        self.state = State.OPEN
        self.messages = asyncio.Queue()

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.messages.get()

    async def close(self):
        self.state = State.CLOSED

    def tokens(self, *text):
        self.messages.put_nowait(
            json.dumps({"tokens": [{"text": item, "is_final": True} for item in text]})
        )


async def test_ownership_defers_initial_connection_until_explicit_resume(monkeypatch):
    stt = OwnershipSonioxSTTService(api_key="offline-fixture")
    connect = AsyncMock()
    monkeypatch.setattr(SonioxSTTService, "_connect", connect)
    stt.enable_ownership()
    await stt._connect()
    connect.assert_not_awaited()


async def test_pause_discards_partial_stream_and_old_endpoint_after_resume(monkeypatch):
    stt = OwnershipSonioxSTTService(api_key="offline-fixture", vad_force_turn_endpoint=True)
    stt.enable_ownership()
    sockets = []
    emitted = []
    interim, final = asyncio.Event(), asyncio.Event()
    late_release = asyncio.Event()
    late_callbacks = []

    async def connect_socket():
        socket = FakeSocket()
        sockets.append(socket)
        stt._websocket = socket

    async def cancel_task(task):
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    async def delivered(frame, direction):
        emitted.append(frame)
        if isinstance(frame, InterimTranscriptionFrame):
            interim.set()
            if not late_callbacks:
                # Emulate an already-scheduled provider callback. It inherits
                # the OLD receive-loop identity even if delivered after resume.
                async def late_callback():
                    await late_release.wait()
                    await stt.push_frame(
                        TranscriptionFrame("obsolete callback", "fixture", "", finalized=True)
                    )

                late_callbacks.append(asyncio.create_task(late_callback()))
        if isinstance(frame, TranscriptionFrame):
            final.set()

    monkeypatch.setattr(stt, "_connect_websocket", connect_socket)
    monkeypatch.setattr(stt, "create_task", asyncio.create_task)
    monkeypatch.setattr(stt, "cancel_task", cancel_task)
    monkeypatch.setattr(stt, "_create_keepalive_task", Mock())
    monkeypatch.setattr(stt, "emit_stt_usage_metrics", AsyncMock())
    monkeypatch.setattr(stt, "_handle_transcription", AsyncMock())
    monkeypatch.setattr(SonioxSTTService, "push_frame", AsyncMock(side_effect=delivered))
    await stt.resume_capture(1)
    try:
        sockets[0].tokens("obsolete partial")
        async with asyncio.timeout(1):
            await interim.wait()
        assert stt._final_transcription_buffer
        old_receive = stt._receive_task
        await stt.pause_capture()
        assert old_receive.done()
        assert sockets[0].state is State.CLOSED
        assert not stt._final_transcription_buffer
        await stt.resume_capture(3)
        sockets[0].tokens("<end>")
        late_release.set()
        await asyncio.gather(*late_callbacks)
        sockets[1].tokens("fresh words", "<end>")
        async with asyncio.timeout(1):
            await final.wait()
        finals = [frame for frame in emitted if isinstance(frame, TranscriptionFrame)]
        assert [frame.text for frame in finals] == ["fresh words"]
        assert finals[0].metadata["ownership_generation"] == 3
    finally:
        late_release.set()
        await stt.pause_capture()
        await asyncio.gather(*late_callbacks)
