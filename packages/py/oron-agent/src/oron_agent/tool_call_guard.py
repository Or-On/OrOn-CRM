"""Keep hallucinated LLM tool calls out of the spoken-call pipeline.

Pipecat broadcasts ``FunctionCallsStartedFrame`` before it resolves whether a
named function is actually available.  A tool-only model turn is deliberately
silent in :class:`HebrewTurnPlanner`, because a real flow transition owns the
next spoken line.  Those two behaviours are correct independently, but an LLM
that emits an intent label as a made-up function (for example
``person_help``) would otherwise be mistaken for a real transition and leave
the caller in silence.

This processor is deliberately downstream of the LLM and immediately
upstream of the turn planner.  It admits only functions advertised by the
trusted current ``LLMContext``.  Unknown lifecycle frames are consumed so the
assistant context is not polluted, while the planner sees an ordinary empty
completion and emits its typed, locale-aware clarification.  Legitimate tools
remain byte-for-byte unchanged.
"""

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    FunctionCallInProgressFrame,
    FunctionCallResultFrame,
    FunctionCallsStartedFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


def _advertised_tool_names(context: object) -> set[str]:
    """Read standardized tool names from a Pipecat context defensively."""

    tools = getattr(context, "tools", None)
    standard_tools = getattr(tools, "standard_tools", ())
    return {
        name
        for tool in standard_tools
        if isinstance((name := getattr(tool, "name", None)), str) and name
    }


class HallucinatedToolCallGuard(FrameProcessor):
    """Suppress lifecycle frames for functions absent from the current node.

    The provider-owned missing-function runner still settles its task.  We
    only keep that untrusted call out of the downstream planner and assistant
    context.  The unknown ID is retained until its terminal result arrives so
    neither an in-progress nor result frame can leak through later.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._unsupported_call_ids: set[str] = set()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction is not FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, FunctionCallsStartedFrame):
            supported = []
            for function_call in frame.function_calls:
                if function_call.function_name in _advertised_tool_names(function_call.context):
                    supported.append(function_call)
                    continue
                self._unsupported_call_ids.add(function_call.tool_call_id)
                logger.warning(
                    "Ignoring unadvertised LLM tool call '{}' (tool_call_id={})",
                    function_call.function_name,
                    function_call.tool_call_id,
                )

            if supported:
                # Broadcast siblings share the original sequence. Reassignment
                # changes only this downstream frame and cannot alter the
                # upstream copy already travelling toward the user aggregator.
                frame.function_calls = supported
                await self.push_frame(frame, direction)
            return

        if isinstance(frame, FunctionCallInProgressFrame) and (
            frame.tool_call_id in self._unsupported_call_ids
        ):
            return

        if isinstance(frame, FunctionCallResultFrame) and (
            frame.tool_call_id in self._unsupported_call_ids
        ):
            self._unsupported_call_ids.discard(frame.tool_call_id)
            return

        await self.push_frame(frame, direction)
