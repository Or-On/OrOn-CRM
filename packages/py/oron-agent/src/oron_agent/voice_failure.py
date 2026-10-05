"""Bounded provider recovery with distinct recoverable and terminal announcements."""

import asyncio
import logging
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from pipecat.frames.frames import ErrorFrame
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.utils.errors import ErrorCategory

from oron_agent.voice_control import VoiceController

logger = logging.getLogger(__name__)
_RECOVERY_TIMEOUT_SECONDS = 20.0
_PROVIDER_RECOVERY_TIMEOUT_SECONDS = 8.0


@dataclass
class VoiceFailurePolicy:
    control: VoiceController | None
    cancel_pipeline: Callable[[], Awaitable[None]]
    announce_failure: Callable[[], Awaitable[None]] | None = None
    interrupt_reply: Callable[[], Awaitable[None]] | None = None
    providers: tuple[FrameProcessor, ...] = ()
    announce_recovery: Callable[[], Awaitable[None]] | None = field(default=None, kw_only=True)
    prepare_recovery: Callable[[ErrorFrame], Awaitable[bool]] | None = field(
        default=None, kw_only=True
    )
    transient_recoveries: int = 0
    failed: bool = False
    _handled: bool = False
    _seen_errors: deque[int] = field(default_factory=lambda: deque(maxlen=128))
    _recovery_ready: bool = field(default=False, init=False)
    _recovery_invalidated: bool = field(default=False, init=False)

    async def _action[T](self, operation: Callable[[], Awaitable[T]]) -> T:
        if self.control is not None:
            return await self.control.recovery_action(operation)
        return await operation()

    async def handle(self, frame: ErrorFrame) -> None:
        if frame.processor is None or frame.id in self._seen_errors:
            return
        permanent = frame.fatal or not frame.processor.is_usable
        transient = (
            frame.processor in self.providers and frame.category is not ErrorCategory.APPLICATION
        )
        if not permanent and not transient:
            return
        self._seen_errors.append(frame.id)
        if self._handled:
            # STT and TTS can drop together. Before readiness, their transient
            # fallout belongs to the same bounded reset of both providers.
            # A permanent failure, or another drop AFTER readiness, cannot be
            # forgotten while the recovery announcement is playing.
            if permanent or self._recovery_ready:
                self._recovery_invalidated = True
            return
        # Reserve before the first await: concurrent error callbacks must not
        # send two failure announcements or race two shutdowns.
        self._handled = True
        self._recovery_ready = False
        self._recovery_invalidated = False
        # A permanent provider failure is not permission to end a human's leg.
        # Fresh ownership is checked again by action before fixed audio playback.
        if self.control is not None and (not await self.control.refresh() or self.control.paused):
            await self.control.suspend_for_failure()
            self._handled = False
            return
        recovery_epoch = self.control.epoch if self.control is not None else None

        def superseded() -> bool:
            return (
                self.control is not None
                and recovery_epoch is not None
                and self.control.epoch != recovery_epoch
            )

        recover = (
            not permanent
            and self.transient_recoveries < 1
            and self.interrupt_reply is not None
            and self.prepare_recovery is not None
            and self.announce_recovery is not None
        )
        try:
            async with asyncio.timeout(_RECOVERY_TIMEOUT_SECONDS):
                if self.control is not None and not await self.control.begin_recovery(
                    expected_epoch=recovery_epoch
                ):
                    if superseded():
                        self._handled = False
                        return
                    await self.control.suspend_for_failure()
                    self._handled = False
                    return
                if self.interrupt_reply is not None:
                    await self._action(self.interrupt_reply)
                if recover:

                    async def prepare() -> bool:
                        assert self.prepare_recovery is not None
                        # This port resets/waits for conversational providers
                        # only. It must never resend text or a business action.
                        return await self.prepare_recovery(frame)

                    try:
                        async with asyncio.timeout(_PROVIDER_RECOVERY_TIMEOUT_SECONDS):
                            recover = await self._action(prepare)
                            if recover and self.control is not None:
                                recover = await self.control.prepare_recovery_capture()
                    except Exception:
                        logger.warning("Voice provider recovery unavailable")
                        recover = False
                    recover = (
                        recover
                        and not self._recovery_invalidated
                        and all(provider.is_usable for provider in self.providers)
                    )
                    self._recovery_ready = recover
                if recover:
                    assert self.announce_recovery is not None
                    await self._action(self.announce_recovery)
                    recover = not self._recovery_invalidated
                if not recover and self.announce_failure is not None:
                    await self._action(self.announce_failure)
        except asyncio.CancelledError:
            # An explicit operator ownership change can cancel fixed audio.
            # Preserve that established human leg instead of hanging it up.
            if self.control is not None:
                fresh = await self.control.refresh()
                if superseded():
                    self._handled = False
                    return
                if not fresh or self.control.paused:
                    await self.control.suspend_for_failure()
                    self._handled = False
                    return
            raise
        except Exception:
            logger.warning("Fixed voice failure recovery unavailable")
            recover = False
        if self.control is not None:
            fresh = await self.control.refresh()
            if superseded():
                self._handled = False
                return
            if not fresh or self.control.paused:
                await self.control.suspend_for_failure()
                self._handled = False
                return

        def can_resume() -> bool:
            return not self._recovery_invalidated and all(
                provider.is_usable for provider in self.providers
            )

        if recover and can_resume():
            if self.control is not None and not await self.control.finish_recovery(
                can_resume=can_resume
            ):
                # Do not resume across a takeover or an unreadable ownership
                # boundary, and do not hang up the human's established leg.
                fresh = await self.control.refresh()
                if superseded():
                    self._handled = False
                    return
                if not fresh or self.control.paused:
                    await self.control.suspend_for_failure()
                    self._handled = False
                    return
                self.failed = True
                await self.cancel_pipeline()
                return
            # Recover only the conversational channel. Never replay a model
            # request or business tool with an unknown external outcome.
            self.transient_recoveries += 1
            self._handled = False
            return
        self.failed = True
        await self.cancel_pipeline()
