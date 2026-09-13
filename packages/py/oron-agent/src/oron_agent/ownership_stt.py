"""Ownership-scoped Soniox capture, using the installed Pipecat lifecycle seam.

Pipecat's ordinary InterruptionFrame does not close the STT websocket or clear
its final-token buffer. An operator pause is different: discard that capture
and open a new stream only for an explicitly authorized ownership generation.
Provider/model/settings and ordinary caller barge-in remain unchanged.
"""

from contextvars import ContextVar

from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.soniox.stt import SonioxSTTService
from websockets.protocol import State


class OwnershipSonioxSTTService(SonioxSTTService):
    """No provider connection is made merely by constructing this adapter."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._ownership_enabled = False
        self._capture_paused = False
        self._capture_generation = -1
        self._capture_owner: ContextVar[int] = ContextVar(
            f"stt-capture-owner-{id(self)}", default=-1
        )

    def enable_ownership(self) -> None:
        """Called before pipeline setup; defer capture until ownership is confirmed."""
        self._ownership_enabled = True
        self._capture_paused = True

    async def pause_capture(self) -> None:
        self._capture_paused = True
        # Pipecat 1.8's Soniox protected lifecycle cancels/awaits the receive and
        # keepalive tasks before closing the socket. Keep its task bookkeeping.
        receive = self._receive_task
        await self._disconnect()
        if receive is not None and not receive.done():
            raise RuntimeError("STT capture did not stop")
        self._final_transcription_buffer = []
        self._user_turn_open = False
        self._last_tokens_received = 0

    async def resume_capture(self, generation: int) -> None:
        if self._receive_task is not None:
            raise RuntimeError("Previous STT capture is still present")
        self._capture_generation = generation
        self._capture_paused = False
        await self._connect()
        if (
            self._websocket is None
            or self._websocket.state is not State.OPEN
            or self._receive_task is None
            or self._receive_task.done()
        ):
            self._capture_paused = True
            raise RuntimeError("Fresh STT capture is unavailable")

    async def _connect(self):
        if not self._ownership_enabled or not self._capture_paused:
            await super()._connect()

    async def _connect_websocket(self):
        # Also cover the SDK's automatic-reconnect path while a pause drains.
        if not self._ownership_enabled or not self._capture_paused:
            await super()._connect_websocket()

    async def _receive_messages(self):
        # This value is captured once for this receive loop, NOT at callback
        # delivery. pause_capture must prove the old receive task terminated
        # before resume_capture may create another one.
        token = self._capture_owner.set(self._capture_generation)
        try:
            await super()._receive_messages()
        finally:
            self._capture_owner.reset(token)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        if (
            self._ownership_enabled
            and self._capture_paused
            and isinstance(
                frame,
                (InputAudioRawFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame),
            )
        ):
            return
        token = self._capture_owner.set(frame.metadata.get("ownership_generation", -1))
        try:
            await super().process_frame(frame, direction)
        finally:
            self._capture_owner.reset(token)

    async def push_frame(self, frame: Frame, direction=FrameDirection.DOWNSTREAM):
        if self._ownership_enabled and isinstance(
            frame,
            (
                TranscriptionFrame,
                InterimTranscriptionFrame,
                ProposedUserStartedSpeakingFrame,
                ProposedUserStoppedSpeakingFrame,
            ),
        ):
            owner = self._capture_owner.get()
            if self._capture_paused or owner != self._capture_generation:
                return
            frame.metadata["ownership_generation"] = owner
        await super().push_frame(frame, direction)
