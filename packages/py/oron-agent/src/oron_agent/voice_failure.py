"""Ownership-aware handling of permanently unusable voice processors."""

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


@dataclass
class VoiceFailurePolicy:
    control: VoiceController | None
    cancel_pipeline: Callable[[], Awaitable[None]]
    announce_failure: Callable[[], Awaitable[None]] | None = None
    interrupt_reply: Callable[[], Awaitable[None]] | None = None
    providers: tuple[FrameProcessor, ...] = ()
    transient_recoveries: int = 0
    failed: bool = False
    _handled: bool = False
    _seen_errors: deque[int] = field(default_factory=lambda: deque(maxlen=128))

    async def handle(self, frame: ErrorFrame) -> None:
        if frame.processor is None or self._handled or frame.id in self._seen_errors:
            return
        permanent = frame.fatal or not frame.processor.is_usable
        transient = (
            frame.processor in self.providers and frame.category is not ErrorCategory.APPLICATION
        )
        if not permanent and not transient:
            return
        # Reserve before the first await: concurrent error callbacks must not
        # send two failure announcements or race two shutdowns.
        self._handled = True
        self._seen_errors.append(frame.id)
        # A permanent provider failure is not permission to end a human's leg.
        # Fresh ownership is checked again by action before fixed audio playback.
        if self.control is not None and (not await self.control.refresh() or self.control.paused):
            await self.control.suspend_for_failure()
            self._handled = False
            return
        recover = (
            not permanent and self.transient_recoveries < 1 and self.interrupt_reply is not None
        )
        try:
            async with asyncio.timeout(_RECOVERY_TIMEOUT_SECONDS):
                if self.interrupt_reply is not None:
                    if self.control is not None:
                        await self.control.action(self.interrupt_reply)
                    else:
                        await self.interrupt_reply()
                if self.announce_failure is not None:
                    if self.control is not None:
                        await self.control.action(self.announce_failure)
                    else:
                        await self.announce_failure()
        except asyncio.CancelledError:
            # An explicit operator ownership change can cancel fixed audio.
            # Preserve that established human leg instead of hanging it up.
            if self.control is not None and (
                not await self.control.refresh() or self.control.paused
            ):
                await self.control.suspend_for_failure()
                self._handled = False
                return
            raise
        except Exception:
            logger.warning("Fixed voice failure recovery unavailable")
            recover = False
        if self.control is not None and (not await self.control.refresh() or self.control.paused):
            await self.control.suspend_for_failure()
            self._handled = False
            return
        if recover:
            # Recover only the conversational channel. Never replay a model
            # request or business tool with an unknown external outcome.
            self.transient_recoveries += 1
            self._handled = False
            return
        self.failed = True
        await self.cancel_pipeline()
