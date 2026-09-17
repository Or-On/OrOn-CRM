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
async def test_oversized_turn_preserves_only_the_accepted_prefix_without_a_canned_reply():
    chunker = NaturalTurnChunker(max_chunk_chars=16, min_clause_chars=8, max_turn_chars=32)
    chunker.push_frame = AsyncMock()
    await chunker.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(LLMTextFrame("accepted prefix. "), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(LLMTextFrame("excess model output"), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)
    spoken = [
        call.args[0]
        for call in chunker.push_frame.call_args_list
        if isinstance(call.args[0], AggregatedTextFrame)
    ]
    assert [frame.text for frame in spoken] == ["accepted prefix."]
    assert all("too long" not in frame.text.lower() for frame in spoken)


@pytest.mark.asyncio
async def test_empty_turn_does_not_emit_english_recovery_during_a_hebrew_call():
    chunker = NaturalTurnChunker()
    chunker.push_frame = AsyncMock()
    await chunker.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)

    assert not any(
        isinstance(call.args[0], AggregatedTextFrame) for call in chunker.push_frame.call_args_list
    )


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


# A mark inside a token must not become a speech boundary: each of these was a
# spoken fragment ("twenty-nine" — pause — "ninety") before the chunker learned
# to look at what follows the mark.
@pytest.mark.parametrize(
    "text",
    [
        "The total is 29.90 shekels.",
        "המחיר הוא 29.90 שקלים.",
        "It costs about 29,90 in the local format, roughly.",
        "The outstanding balance is 1,250.50 including tax.",
        "The outstanding balance is 1.250,50 including tax.",
        "It takes about 0.5 hours.",
        "It takes about 0,5 hours.",
        "The constant is 3.14 exactly.",
        "The price is ₪29.90 today.",
        "The price is 29.90 ₪ today.",
        "Please install version 2.1 first.",
        "Please install version 1.2.3 first.",
        "Our website is example.com and it has the form.",
        "We open at 12:30 tomorrow.",
        "The appointment is 16.09.2026 at noon.",
        "The appointment is 16/09/2026 at noon.",
        "Visit www.example.com for details.",
        "Send it to email@example.com instead.",
        "A.B. is on the line right now.",
    ],
    ids=lambda value: value[:28],
)
@pytest.mark.asyncio
async def test_a_mark_inside_a_token_is_never_a_speech_boundary(monkeypatch, text):
    pushed = await _stream(monkeypatch, [text])
    spoken = [frame.text for frame in pushed if isinstance(frame, AggregatedTextFrame)]
    assert spoken == [text]


# Real sentence and clause boundaries must survive the guard.
@pytest.mark.parametrize(
    ("pieces", "expected"),
    [
        (
            ["Our number is 03-1234567. ", "Call anytime."],
            ["Our number is 03-1234567.", "Call anytime."],
        ),
        (["All good here. ", "What else can I do?"], ["All good here.", "What else can I do?"]),
        (["First line here\nSecond line here"], ["First line here", "Second line here"]),
        (
            ["I checked the account and everything looks fine, nothing to worry about."],
            [
                "I checked the account and everything looks fine,",
                "nothing to worry about.",
            ],
        ),
        (["Let me think... ", "yes, that works."], ["Let me think...", "yes, that works."]),
        (["Really?! ", "That is great news."], ["Really?!", "That is great news."]),
    ],
    ids=[
        "digits-then-sentence",
        "two-sentences",
        "line-break",
        "long-clause",
        "ellipsis",
        "mark-run",
    ],
)
@pytest.mark.asyncio
async def test_real_boundaries_still_split(monkeypatch, pieces, expected):
    pushed = await _stream(monkeypatch, pieces)
    spoken = [frame.text for frame in pushed if isinstance(frame, AggregatedTextFrame)]
    assert spoken == expected


# The same amount, arriving at three different token boundaries.
@pytest.mark.parametrize(
    "pieces",
    [
        ["The total is ", "29", ".", "90", " shekels", "."],
        ["The total is ", "29.", "90 shekels."],
        ["The total is 29.90 shekels."],
    ],
    ids=["mark-alone", "mark-ends-token", "single-token"],
)
@pytest.mark.asyncio
async def test_streaming_token_boundaries_cannot_split_an_amount(monkeypatch, pieces):
    pushed = await _stream(monkeypatch, pieces)
    spoken = [frame.text for frame in pushed if isinstance(frame, AggregatedTextFrame)]
    assert spoken == ["The total is 29.90 shekels."]


@pytest.mark.asyncio
async def test_a_turn_ending_on_a_digit_stop_still_flushes(monkeypatch):
    """Nothing more is coming at the end of a turn, so the mark is a real
    boundary and the text must not be held back waiting for a digit."""

    pushed = await _stream(monkeypatch, ["It costs 29."])
    spoken = [frame.text for frame in pushed if isinstance(frame, AggregatedTextFrame)]
    assert spoken == ["It costs 29."]


@pytest.mark.asyncio
async def test_a_pending_amount_is_not_lost_when_the_response_ends(monkeypatch):
    """The mark arrives with nothing after it and the turn then ends — the
    deferred boundary must be flushed, not dropped."""

    pushed = await _stream(monkeypatch, ["The total is ", "29", "."])
    spoken = [frame.text for frame in pushed if isinstance(frame, AggregatedTextFrame)]
    assert spoken == ["The total is 29."]


@pytest.mark.asyncio
async def test_a_mark_inside_a_token_is_never_a_speech_boundary_when_it_is_streamed(
    monkeypatch,
):
    """The user's currency case, tokenized the way an LLM actually emits it:
    "29" arrives, then ".", then "90". The dot lands with nothing after it, so
    the digit before it is the only thing standing between the caller hearing
    "twenty-nine — pause — ninety" and one amount."""

    pushed = await _stream(monkeypatch, ["The total is ", "29", ".", "90", " shekels", "."])
    spoken = [frame.text for frame in pushed if isinstance(frame, AggregatedTextFrame)]
    assert spoken == ["The total is 29.90 shekels."]


# The deliberate edge of the same design: a dot that follows a LETTER with
# nothing after it yet is treated as a sentence end. Deferring those too would
# make every ordinary sentence wait a token for lookahead — the trade the
# `_continues_a_token` docstring already rejects. These pin the cost where it
# shows up, so it stays a documented decision rather than an accident.
@pytest.mark.parametrize(
    ("pieces", "expected"),
    [
        # "Mr." is period-plus-space after eight characters: an abbreviation the
        # chunker cannot know, so it chunks as a sentence and the name gets a
        # small pause after the title.
        (["Call Mr. Smith today."], ["Call Mr.", "Smith today."]),
        # A host name whose dot streams in its own token has the same shape
        # from the buffer's point of view.
        (["example", ".", "com"], ["example.", "com"]),
    ],
    ids=["abbreviation-title", "fragmented-host-name"],
)
@pytest.mark.asyncio
async def test_a_dot_after_a_letter_still_chunks_naturally_at_stream_end(
    monkeypatch, pieces, expected
):
    pushed = await _stream(monkeypatch, pieces)
    spoken = [frame.text for frame in pushed if isinstance(frame, AggregatedTextFrame)]
    assert spoken == expected


@pytest.mark.asyncio
async def test_a_new_turn_owns_playback_after_a_barge_in(monkeypatch):
    """The interruption race, at the planner: response A is cut off, B starts,
    and a late A token arrives. B must be the only thing spoken, and its chunks
    must carry a generation the cancelled turn cannot claim."""

    chunker = NaturalTurnChunker()
    pushed = []

    async def capture(frame, _direction):
        pushed.append(frame)

    monkeypatch.setattr(chunker, "push_frame", capture)
    monkeypatch.setattr(chunker, "_start_interruption", AsyncMock())

    await chunker.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(
        LLMTextFrame("Your balance is currently "), FrameDirection.DOWNSTREAM
    )
    await chunker.process_frame(InterruptionFrame(), FrameDirection.DOWNSTREAM)
    # Everything the cancelled generation still had in flight.
    await chunker.process_frame(LLMTextFrame("four hundred shekels."), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)
    # The answer to what the caller actually said.
    await chunker.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await chunker.process_frame(
        LLMTextFrame("Sure, I can close the ticket instead."), FrameDirection.DOWNSTREAM
    )
    await chunker.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)

    spoken = [frame for frame in pushed if isinstance(frame, AggregatedTextFrame)]
    assert [frame.text for frame in spoken] == ["Sure, I can close the ticket instead."]
    assert all("balance" not in frame.text for frame in spoken)
    assert all("four hundred" not in frame.text for frame in spoken)

    starts = [frame for frame in pushed if isinstance(frame, LLMFullResponseStartFrame)]
    assert spoken[0].metadata["voice_generation"] == starts[-1].metadata["voice_generation"]
    assert spoken[0].metadata["voice_generation"] > starts[0].metadata["voice_generation"]
