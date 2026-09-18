"""Retire turn-scoped flow instructions once they have been fulfilled.

FlowManager appends node task messages with the APPEND strategy, so the
model-authored opener instruction ("OPENING TURN ONLY ... greet ... ask how you
can help") otherwise stays in every later request of the call, including after
node transitions. Replayed on each caller turn it produced re-greetings and
"how can I help?" in place of an answer.
"""

from __future__ import annotations

from pipecat.frames.frames import Frame, LLMContextFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from oron_agent.flows.greeting import OPENING_TURN_PREFIX


def _is_opening_instruction(message: object) -> bool:
    return (
        isinstance(message, dict)
        and message.get("role") == "system"
        and str(message.get("content", "")).startswith(OPENING_TURN_PREFIX)
    )


def _delivered_assistant_turn(message: object) -> bool:
    return (
        isinstance(message, dict)
        and message.get("role") == "assistant"
        and bool(str(message.get("content") or "").strip())
    )


class OpeningTurnContext(FrameProcessor):
    """Drop the opener instruction after an assistant turn was actually delivered.

    An opener that was interrupted before any speech reached history keeps its
    instruction, so the next inference can still open the call naturally.
    """

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction is FrameDirection.DOWNSTREAM and isinstance(frame, LLMContextFrame):
            messages = frame.context.get_messages()
            if any(map(_delivered_assistant_turn, messages)) and any(
                map(_is_opening_instruction, messages)
            ):
                frame.context.set_messages(
                    [message for message in messages if not _is_opening_instruction(message)]
                )
        await self.push_frame(frame, direction)
