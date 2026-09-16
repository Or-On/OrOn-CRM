from unittest.mock import AsyncMock

import pytest
from oron_agent.turn_planner import NaturalTurnChunker
from pipecat.frames.frames import (
    AggregatedTextFrame,
    FunctionCallFromLLM,
    FunctionCallsStartedFrame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection


async def _stream(monkeypatch, pieces):
    chunker = NaturalTurnChunker()
    pushed = []

    async def capture(frame, _direction):
        pushed.append(frame)

    monkeypatch.setattr(chunker, "push_frame", capture)
    await chunker.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    for piece in pieces:
        await chunker.process_frame(LLMTextFrame(piece), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)
    return pushed


@pytest.mark.asyncio
async def test_first_complete_sentence_streams_before_response_end(monkeypatch):
    chunker = NaturalTurnChunker()
    pushed = []

    async def capture(frame, _direction):
        pushed.append(frame)

    monkeypatch.setattr(chunker, "push_frame", capture)
    await chunker.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(LLMTextFrame("I'm doing well, thanks. "), FrameDirection.DOWNSTREAM)

    spoken = [frame for frame in pushed if isinstance(frame, AggregatedTextFrame)]
    assert [frame.text for frame in spoken] == ["I'm doing well, thanks."]
    assert spoken[0].metadata["voice_delivery_state"] == "streaming_chunk"


@pytest.mark.asyncio
async def test_tokens_are_buffered_into_natural_chunks(monkeypatch):
    pushed = await _stream(
        monkeypatch,
        ["About ", "the ", "printer", "—does it lose Wi-Fi, ", "or show offline?"],
    )
    spoken = [frame.text for frame in pushed if isinstance(frame, AggregatedTextFrame)]
    assert spoken == ["About the printer—does it lose Wi-Fi, or show offline?"]
    assert all(piece not in spoken for piece in ["About ", "the ", "printer"])


@pytest.mark.asyncio
async def test_substantial_opening_clause_can_start_tts_early(monkeypatch):
    pushed = await _stream(
        monkeypatch,
        [
            "That sounds like the Wi-Fi connection is dropping repeatedly, ",
            "so let's check the network first.",
        ],
    )
    spoken = [frame.text for frame in pushed if isinstance(frame, AggregatedTextFrame)]
    assert len(spoken) == 2
    assert spoken[0].endswith(",")
    assert spoken[1].endswith(".")


@pytest.mark.asyncio
async def test_interruption_discards_buffer_and_late_tokens(monkeypatch):
    chunker = NaturalTurnChunker()
    chunker.push_frame = AsyncMock()
    monkeypatch.setattr(chunker, "_start_interruption", AsyncMock())
    await chunker.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(LLMTextFrame("Unfinished old reply"), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(InterruptionFrame(), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(LLMTextFrame(" late stale text."), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)

    assert not any(
        isinstance(call.args[0], AggregatedTextFrame) for call in chunker.push_frame.call_args_list
    )


@pytest.mark.asyncio
async def test_fact_selector_stays_whole_for_validation(monkeypatch):
    selector = '{"kind":"fact","sourceId":"s","documentId":"d","version":1,"factKey":"hours"}'
    pushed = await _stream(monkeypatch, list(selector))
    spoken = [frame.text for frame in pushed if isinstance(frame, AggregatedTextFrame)]
    assert spoken == [selector]


@pytest.mark.asyncio
async def test_oversized_turn_is_bounded_and_recovers_with_one_voice_prompt():
    chunker = NaturalTurnChunker(max_chunk_chars=16, min_clause_chars=8, max_turn_chars=32)
    chunker.push_frame = AsyncMock()
    await chunker.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(LLMTextFrame("x" * 100), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)
    spoken = [
        call.args[0]
        for call in chunker.push_frame.call_args_list
        if isinstance(call.args[0], AggregatedTextFrame)
    ]
    assert spoken
    assert sum(len(frame.text) for frame in spoken) < 120


@pytest.mark.asyncio
async def test_tool_only_completion_remains_silent(monkeypatch):
    chunker = NaturalTurnChunker()
    chunker.push_frame = AsyncMock()
    call = FunctionCallFromLLM(
        function_name="support_done",
        tool_call_id="call-1",
        arguments={},
        context=None,
    )
    await chunker.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(
        FunctionCallsStartedFrame(function_calls=[call]), FrameDirection.DOWNSTREAM
    )
    await chunker.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)

    assert not any(
        isinstance(entry.args[0], AggregatedTextFrame)
        for entry in chunker.push_frame.call_args_list
    )
