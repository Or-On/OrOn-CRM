"""Observe committed caller text before inference, not a later turn-stop event."""

from pipecat.frames.frames import Frame, LLMContextFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from oron_agent.service_intake import VoiceServiceIntake


class ServiceIntakeContext(FrameProcessor):
    def __init__(self, intake: VoiceServiceIntake):
        super().__init__()
        self._intake = intake
        self._intake.context_authoritative = True
        self._last_user: tuple[int, str] | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if (
            direction is FrameDirection.DOWNSTREAM
            and isinstance(frame, LLMContextFrame)
            and not frame.speculation
        ):
            # Evidence and flow processors append system instructions after the
            # caller text. They must neither hide nor advance a caller turn.
            messages = [
                message
                for message in frame.context.get_messages()
                if isinstance(message, dict) and message.get("role") != "system"
            ]
            last = messages[-1] if messages else None
            if isinstance(last, dict) and last.get("role") == "user":
                text = last.get("content")
                if isinstance(text, str) and text.strip():
                    key = (sum(message.get("role") == "user" for message in messages), text)
                    if key != self._last_user:
                        self._last_user = key
                        self._intake.record_committed_context(text)
        await self.push_frame(frame, direction)
