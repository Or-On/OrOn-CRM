"""Per-call fail-closed AI ownership with bounded PostgreSQL polling.

Pausing cancels local work and waits for processing barriers. It cannot recall
already transmitted audio or prove a human connected to a telephone leg.
"""

import asyncio
from collections import deque
from collections.abc import Awaitable, Callable
from contextlib import suppress
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Literal

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    OutputAudioRawFrame,
    ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame,
    StartFrame,
    SystemFrame,
    TranscriptionFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSTextFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

Mode = Literal["ai", "paused"]


@dataclass(frozen=True)
class VoiceControlSnapshot:
    epoch: int
    mode: Mode
    active: bool = True
    resume_authorized: bool = True


class VoiceControlGate(FrameProcessor):
    """Drop work at model/synthesis/transport boundaries during ownership loss."""

    def __init__(
        self,
        control: VoiceController,
        *,
        audio: bool = False,
        generated: bool = False,
        recognition: bool = False,
    ):
        super().__init__()
        self.control = control
        self.audio = audio
        self.generated = generated
        self.recognition = recognition
        self._contexts: deque[tuple[str, int]] = deque(maxlen=256)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, (StartFrame, EndFrame, CancelFrame, InterruptionFrame)):
            await self.push_frame(frame, direction)
            return
        if direction == FrameDirection.UPSTREAM:
            await self.push_frame(frame, direction)
            return
        # System lifecycle/metrics still propagate, but all media, context,
        # utterances and generation text stop at every affected boundary.
        if self.control.paused and (
            not isinstance(frame, SystemFrame)
            or isinstance(
                frame,
                (
                    InputAudioRawFrame,
                    UserStartedSpeakingFrame,
                    UserStoppedSpeakingFrame,
                    VADUserStartedSpeakingFrame,
                    VADUserStoppedSpeakingFrame,
                    ProposedUserStartedSpeakingFrame,
                ),
            )
        ):
            return
        context_id = getattr(frame, "context_id", None)
        if (
            (self.audio and isinstance(frame, (OutputAudioRawFrame, TTSTextFrame)))
            or (
                self.generated
                and isinstance(
                    frame, (LLMTextFrame, LLMFullResponseStartFrame, LLMFullResponseEndFrame)
                )
            )
            or (
                self.recognition
                and isinstance(
                    frame,
                    (
                        TranscriptionFrame,
                        InterimTranscriptionFrame,
                        ProposedUserStartedSpeakingFrame,
                        ProposedUserStoppedSpeakingFrame,
                    ),
                )
            )
        ):
            # Unknown producer identity is not the current generation. Never
            # relabel a late callback merely because the operator resumed AI.
            if frame.metadata.get("ownership_generation") != self.control.generation:
                return
            if self.audio and not context_id:
                return
        if self.audio and context_id:
            prior = next((epoch for key, epoch in self._contexts if key == context_id), None)
            if prior is not None and prior != self.control.generation:
                return
            if isinstance(frame, TTSStartedFrame) and prior is None:
                self._contexts.append((context_id, self.control.generation))
        if not isinstance(frame, SystemFrame) or isinstance(frame, InputAudioRawFrame):
            if (
                frame.metadata.get("ownership_generation", self.control.generation)
                != self.control.generation
            ):
                return
            frame.metadata["ownership_generation"] = self.control.generation
        await self.push_frame(frame, direction)


class VoiceController:
    """One injected controller per active call; no process-global owner state."""

    def __init__(
        self,
        read: Callable[[], Awaitable[VoiceControlSnapshot]],
        acknowledge: Callable[[int, Mode], Awaitable[bool]],
        *,
        poll_seconds: float = 0.5,
    ):
        self.read = read
        self.acknowledge = acknowledge
        self.poll_seconds = max(0.1, min(2.0, poll_seconds))
        self.epoch = -1
        self.generation = 0
        self.paused = True
        self._blocked_epoch = -1
        self._lock = asyncio.Lock()
        self._barrier: Callable[[], Awaitable[None]] | None = None
        self._on_mode: Callable[[bool], None] | None = None
        self._pause_capture: Callable[[], Awaitable[None]] | None = None
        self._reset_utterance: Callable[[], Awaitable[None]] | None = None
        self._resume_capture: Callable[[int], Awaitable[None]] | None = None
        self._actions: set[asyncio.Task] = set()
        self._action_owner: ContextVar[int | None] = ContextVar(
            f"voice-action-owner-{id(self)}", default=None
        )

    def track_producer(self, processor: FrameProcessor, *, synthesis: bool = False) -> None:
        """Bind producer task generations and explicit SDK synthesis contexts.

        Soniox's receive task lives across turns, so audio uses the context ID
        from on_tts_request rather than the receive task's generation. Provider
        text is never retained by these callbacks.
        """
        generation: ContextVar[int | None] = ContextVar(
            f"voice-owner-{id(self)}-{id(processor)}", default=None
        )
        contexts: dict[str, int] = {}

        async def before_process(_processor, frame):
            if not isinstance(frame, SystemFrame):
                generation.set(frame.metadata.get("ownership_generation"))
                if not synthesis:
                    self._action_owner.set(frame.metadata.get("ownership_generation"))

        async def requested(_processor, context_id, _text):
            owner = generation.get()
            if isinstance(owner, int):
                if len(contexts) >= 256:
                    contexts.pop(next(iter(contexts)))
                contexts[context_id] = owner

        async def before_push(_processor, frame):
            if synthesis and isinstance(
                frame, (OutputAudioRawFrame, TTSStartedFrame, TTSStoppedFrame, TTSTextFrame)
            ):
                context_id = getattr(frame, "context_id", None)
                owner = contexts.get(context_id) if isinstance(context_id, str) else None
                frame.metadata["ownership_generation"] = owner if owner is not None else -1
            elif not synthesis and isinstance(
                frame, (LLMTextFrame, LLMFullResponseStartFrame, LLMFullResponseEndFrame)
            ):
                owner = generation.get()
                frame.metadata["ownership_generation"] = owner if owner is not None else -1

        processor.add_event_handler("on_before_process_frame", before_process)
        processor.add_event_handler("on_before_push_frame", before_push)
        if synthesis:
            processor.add_event_handler("on_tts_request", requested)
            # Pipecat registers on_tts_request as a background event. Soniox
            # can return the first WebSocket audio frame before that task has
            # recorded the request's ownership, so the fail-closed output gate
            # correctly—but invisibly—drops the whole utterance. This pinned
            # SDK seam makes request ownership part of the awaited TTS request
            # boundary. All handlers are still awaited and no stale generation
            # is ever relabelled as current.
            event = processor._event_handlers.get("on_tts_request")  # noqa: SLF001
            if event is None:
                raise RuntimeError("TTS processor does not expose on_tts_request")
            event.is_sync = True

    def attach(
        self,
        processors: list[FrameProcessor],
        *,
        on_mode: Callable[[bool], None] | None = None,
        pause_capture: Callable[[], Awaitable[None]] | None = None,
        reset_utterance: Callable[[], Awaitable[None]] | None = None,
        resume_capture: Callable[[int], Awaitable[None]] | None = None,
    ) -> None:
        """Use documented processing callbacks, not transport enqueue as acknowledgement."""
        self._on_mode = on_mode
        self._pause_capture = pause_capture
        self._reset_utterance = reset_utterance
        self._resume_capture = resume_capture
        observed: list[FrameProcessor] = []

        def observe_leaves(processor: FrameProcessor) -> None:
            children = processor.processors
            if children:
                for child in children:
                    observe_leaves(child)
            elif processor not in observed:
                observed.append(processor)

        for processor in processors:
            observe_leaves(processor)

        async def barrier() -> None:
            events = [asyncio.Event() for _ in observed]
            marker = f"ownership:{self.generation}"
            handlers = []
            for processor, done in zip(observed, events, strict=True):

                async def processed(_processor, frame, *, signal=done):
                    if frame.metadata.get("ownership_barrier") == marker:
                        signal.set()

                handlers.append((processor, processed))
                processor.add_event_handler("on_after_process_frame", processed)
            try:
                # One frame traverses the chain. Injecting a copy into EVERY
                # processor creates late duplicate interruptions that could
                # cancel the first resumed turn after the barrier acknowledged.
                frame = InterruptionFrame()
                frame.metadata["ownership_barrier"] = marker
                await processors[0].queue_frame(frame, FrameDirection.DOWNSTREAM)
                async with asyncio.timeout(2.0):
                    await asyncio.gather(*(event.wait() for event in events))
            finally:
                for processor, handler in handlers:
                    processor.remove_event_handler("on_after_process_frame", handler)

        self._barrier = barrier

    async def _stop(self) -> None:
        self.paused = True
        self.generation += 1
        if self._on_mode:
            self._on_mode(True)
        active = [task for task in self._actions if task is not asyncio.current_task()]
        for task in active:
            task.cancel()
        if active:
            async with asyncio.timeout(2.0):
                await asyncio.gather(*active, return_exceptions=True)
        if self._pause_capture is not None:
            async with asyncio.timeout(2.0):
                await self._pause_capture()
        if self._barrier is not None:
            await self._barrier()
        if self._reset_utterance is not None:
            await self._reset_utterance()

    async def refresh(self) -> None:
        async with self._lock:
            try:
                async with asyncio.timeout(1.5):
                    state = await self.read()
                changed = state.epoch != self.epoch
                permitted = state.active and state.resume_authorized
                should_pause = state.mode == "paused" or not permitted
                # Any loss of control needs a NEW explicit command, never an
                # automatic reopen when the same old command becomes readable.
                resume = changed and state.epoch > self._blocked_epoch and not should_pause
                if changed or (should_pause and not self.paused):
                    await self._stop()
                self.epoch = state.epoch
                if not permitted:
                    self._blocked_epoch = max(self._blocked_epoch, state.epoch)
                mode: Mode = "ai" if resume or (not self.paused and not should_pause) else "paused"
                if resume and self._resume_capture is not None:
                    # Input/model/output gates remain closed until fresh capture
                    # succeeds AND the exact durable command is acknowledged.
                    async with asyncio.timeout(2.0):
                        await self._resume_capture(self.generation)
                async with asyncio.timeout(1.5):
                    acknowledged = await self.acknowledge(state.epoch, mode)
                if not acknowledged:
                    await self._stop()
                    return
                if mode == "ai":
                    self.paused = False
                    if self._on_mode:
                        self._on_mode(False)
            except asyncio.CancelledError:
                raise
            except Exception:
                self._blocked_epoch = max(self._blocked_epoch, self.epoch)
                with suppress(Exception):
                    await self._stop()

    async def run(self) -> None:
        while True:
            await self.refresh()
            await asyncio.sleep(self.poll_seconds)

    async def action(self, operation: Callable[..., Awaitable[Any]], *args: Any) -> Any:
        """Recheck durable ownership before existing flow work and invalidate its result."""
        owner = self._action_owner.get()
        await self.refresh()
        if self.paused or (owner is not None and owner != self.generation):
            raise asyncio.CancelledError("voice AI is paused")
        generation = self.generation

        async def execute():
            return await operation(*args)

        task = asyncio.create_task(execute())
        self._actions.add(task)
        try:
            result = await task
            if self.paused or generation != self.generation:
                raise asyncio.CancelledError("voice action generation is obsolete")
            return result
        finally:
            self._actions.discard(task)
