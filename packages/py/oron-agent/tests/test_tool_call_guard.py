from unittest.mock import AsyncMock

import pytest
from oron_agent.tool_call_guard import HallucinatedToolCallGuard
from oron_agent.turn_planner import HebrewTurnPlanner
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.frames.frames import (
    AggregatedTextFrame,
    FunctionCallFromLLM,
    FunctionCallInProgressFrame,
    FunctionCallResultFrame,
    FunctionCallsStartedFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection


def _tool_call(name: str, call_id: str, *, advertised: tuple[str, ...] = ()):
    tools = [
        FunctionSchema(
            name=tool_name,
            description="Trusted flow transition",
            properties={},
            required=[],
        )
        for tool_name in advertised
    ]
    return FunctionCallFromLLM(
        function_name=name,
        tool_call_id=call_id,
        arguments={},
        context=LLMContext(tools=tools),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["person_help", "handoff_available", "progress"])
async def test_unadvertised_intent_tool_is_removed_and_empty_turn_recovers(name):
    guard = HallucinatedToolCallGuard()
    planner = HebrewTurnPlanner()
    planned = []

    async def forward_to_planner(frame, direction):
        await planner.process_frame(frame, direction)

    async def capture(frame, _direction):
        planned.append(frame)

    guard.push_frame = forward_to_planner
    planner.push_frame = capture
    await guard.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await guard.process_frame(
        FunctionCallsStartedFrame(function_calls=[_tool_call(name, "unknown-1")]),
        FrameDirection.DOWNSTREAM,
    )
    await guard.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)

    recoveries = [frame for frame in planned if isinstance(frame, AggregatedTextFrame)]
    assert [frame.text for frame in recoveries] == [
        "Sorry, I lost the thread for a moment.",
        "Could you say that again?",
    ]
    assert not any(isinstance(frame, FunctionCallsStartedFrame) for frame in planned)


@pytest.mark.asyncio
async def test_legitimate_current_flow_tool_remains_silent_and_unchanged():
    guard = HallucinatedToolCallGuard()
    planner = HebrewTurnPlanner()
    planned = []

    async def forward_to_planner(frame, direction):
        await planner.process_frame(frame, direction)

    async def capture(frame, _direction):
        planned.append(frame)

    guard.push_frame = forward_to_planner
    planner.push_frame = capture
    call = _tool_call("support_done", "valid-1", advertised=("support_done",))

    await guard.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await guard.process_frame(
        FunctionCallsStartedFrame(function_calls=[call]), FrameDirection.DOWNSTREAM
    )
    await guard.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)

    forwarded = [frame for frame in planned if isinstance(frame, FunctionCallsStartedFrame)]
    assert len(forwarded) == 1
    assert forwarded[0].function_calls == [call]
    assert not any(isinstance(frame, AggregatedTextFrame) for frame in planned)


@pytest.mark.asyncio
async def test_mixed_batch_keeps_only_advertised_tool_and_drops_unknown_lifecycle():
    guard = HallucinatedToolCallGuard()
    guard.push_frame = AsyncMock()
    valid = _tool_call("support_done", "valid-1", advertised=("support_done",))
    unknown = _tool_call("person_help", "unknown-1", advertised=("support_done",))

    await guard.process_frame(
        FunctionCallsStartedFrame(function_calls=[unknown, valid]),
        FrameDirection.DOWNSTREAM,
    )
    await guard.process_frame(
        FunctionCallInProgressFrame(
            function_name="person_help",
            tool_call_id="unknown-1",
            arguments={},
        ),
        FrameDirection.DOWNSTREAM,
    )
    await guard.process_frame(
        FunctionCallResultFrame(
            function_name="person_help",
            tool_call_id="unknown-1",
            arguments={},
            result={"error": "not available"},
        ),
        FrameDirection.DOWNSTREAM,
    )

    forwarded = [call.args[0] for call in guard.push_frame.call_args_list]
    assert len(forwarded) == 1
    assert isinstance(forwarded[0], FunctionCallsStartedFrame)
    assert forwarded[0].function_calls == [valid]
    assert guard._unsupported_call_ids == set()


@pytest.mark.asyncio
async def test_upstream_frames_are_never_filtered():
    guard = HallucinatedToolCallGuard()
    guard.push_frame = AsyncMock()
    frame = FunctionCallsStartedFrame(function_calls=[_tool_call("person_help", "unknown-1")])

    await guard.process_frame(frame, FrameDirection.UPSTREAM)

    guard.push_frame.assert_awaited_once_with(frame, FrameDirection.UPSTREAM)
