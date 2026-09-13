from unittest.mock import AsyncMock

import pytest
from oron_agent.caller_gender import CallerGenderContextProcessor, CallerGenderState
from oron_agent.recognition import RecognitionAcceptanceProcessor
from pipecat.frames.frames import InterimTranscriptionFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection


@pytest.mark.asyncio
async def test_provisional_revision_never_changes_caller_preference():
    acceptance = RecognitionAcceptanceProcessor()
    state = CallerGenderState()
    caller = CallerGenderContextProcessor(state, session_id="fixture")
    caller.push_frame = AsyncMock()
    acceptance.push_frame = caller.process_frame
    provisional = TranscriptionFrame("אני גבר", "fixture", "2026-09-12", finalized=False)
    await acceptance.process_frame(provisional, FrameDirection.DOWNSTREAM)
    assert state.gender is None
    frame = caller.push_frame.call_args.args[0]
    assert isinstance(frame, InterimTranscriptionFrame)
    assert frame.metadata["recognition_state"] == "provisional"


@pytest.mark.asyncio
async def test_final_record_keeps_raw_tokens_timestamp_and_meaning():
    acceptance = RecognitionAcceptanceProcessor()
    acceptance.push_frame = AsyncMock()
    tokens = [
        {"text": "לא ביום ראשון — ביום שני", "start_ms": 100, "end_ms": 800, "is_final": True}
    ]
    final = TranscriptionFrame(
        tokens[0]["text"], "fixture", "2026-09-12", result=tokens, finalized=True
    )
    await acceptance.process_frame(final, FrameDirection.DOWNSTREAM)
    await acceptance.process_frame(final, FrameDirection.DOWNSTREAM)
    assert acceptance.push_frame.call_count == 1
    assert final.text == final.metadata["recognition_raw_text"] == final.metadata["accepted_text"]
    assert final.result is tokens
    assert final.timestamp == "2026-09-12"
    assert final.metadata["accepted_utterance_id"] == 1
    assert final.metadata["recognition_finalized_ns"] >= final.metadata["recognition_received_ns"]


@pytest.mark.asyncio
async def test_identical_words_in_two_distinct_turns_are_not_dropped():
    acceptance = RecognitionAcceptanceProcessor()
    acceptance.push_frame = AsyncMock()
    for _ in range(2):
        await acceptance.process_frame(
            TranscriptionFrame("כן", "fixture", "", finalized=True), FrameDirection.DOWNSTREAM
        )
    assert acceptance.accepted_utterances == 2
