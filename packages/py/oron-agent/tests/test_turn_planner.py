from unittest.mock import AsyncMock

import pytest
from oron_agent.turn_planner import HebrewTurnPlanner
from oron_hebrew.filters import HebrewNormalizeFilter
from pipecat.frames.frames import (
    AggregatedTextFrame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection


async def _planned_frames(monkeypatch, text: str):
    planner = HebrewTurnPlanner()
    pushed = []

    async def capture(frame, direction):
        pushed.append((frame, direction))

    monkeypatch.setattr(planner, "push_frame", capture)
    await planner.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    # Real LLM output is arbitrarily chunked. Character-sized chunks prove the
    # repair does not accidentally depend on a provider's token boundaries.
    for char in text:
        await planner.process_frame(LLMTextFrame(char), FrameDirection.DOWNSTREAM)
    await planner.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)
    return [frame for frame, _ in pushed]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("recorded", "expected", "spoken_expected"),
    [
        (
            "תודה שעדכנת אותי איך אוכל לעזור לך היום?",
            "תודה שעדכנת אותי. איך אוכל לעזור לך היום?",
            "תודה שעדכנת אותי. איך אוכל לעזור לך היום?",
        ),
        (
            "אני מבינה כדי שאוכל לעזור לך בצורה הטובה ביותר, אצטרך לדעת איזה דגם "
            "של ממיר יש לך תוכל לבדוק זאת?",
            "אני מבינה כדי שאוכל לעזור לך בצורה הטובה ביותר, אצטרך לדעת איזה דגם "
            "של ממיר יש לך. תוכל לבדוק זאת?",
            "כדי שאוכל לעזור לך בצורה הטובה ביותר, אצטרך לדעת איזה דגם של ממיר "
            "יש לך. תוכל לבדוק זאת?",
        ),
        (
            "ברוך השם, מצוין תודה ששאלת רציתי לברר אם קיבלת את המייל ששלחתי לך "
            "בנוגע לשירות החדש שלנו?",
            "ברוך השם, מצוין תודה ששאלת. רציתי לברר אם קיבלת את המייל ששלחתי לך "
            "בנוגע לשירות החדש שלנו?",
            "ברוך השם, מצוין תודה ששאלת. רציתי לברר אם קיבלת את המייל ששלחתי לך "
            "בנוגע לשירות החדש שלנו?",
        ),
    ],
)
async def test_latest_call_run_ons_reach_tts_as_one_repaired_turn(
    monkeypatch, recorded, expected, spoken_expected
):
    frames = await _planned_frames(monkeypatch, recorded)

    assert isinstance(frames[0], LLMFullResponseStartFrame)
    assert isinstance(frames[1], AggregatedTextFrame)
    assert frames[1].text == expected
    assert frames[1].raw_text == expected
    assert isinstance(frames[2], LLMFullResponseEndFrame)
    assert len(frames) == 3
    # Exercise the real post-aggregation TTS filter too. The planner's one whole
    # turn keeps the answer's full stop internal, so Soniox's terminal-period
    # safeguard cannot remove it.
    assert await HebrewNormalizeFilter(lambda: "male").filter(frames[1].text) == spoken_expected


@pytest.mark.asyncio
async def test_missing_question_mark_is_added_before_tts(monkeypatch):
    frames = await _planned_frames(
        monkeypatch,
        "תודה שעדכנת אותי איך אוכל לעזור לך היום",
    )

    assert frames[1].text == "תודה שעדכנת אותי. איך אוכל לעזור לך היום?"


@pytest.mark.asyncio
async def test_interruption_discards_the_unspoken_buffer(monkeypatch):
    planner = HebrewTurnPlanner()
    pushed = []

    async def capture(frame, direction):
        pushed.append(frame)

    monkeypatch.setattr(planner, "push_frame", capture)
    # Pipeline setup owns Pipecat's priority interruption task. This unit test
    # exercises only the planner's buffer reset and therefore stubs that
    # lifecycle hook instead of leaking a setup-less coroutine.
    monkeypatch.setattr(planner, "_start_interruption", AsyncMock())
    await planner.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await planner.process_frame(
        LLMTextFrame("התחלה של משפט"),
        FrameDirection.DOWNSTREAM,
    )
    await planner.process_frame(InterruptionFrame(), FrameDirection.DOWNSTREAM)
    await planner.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)

    assert not any(isinstance(frame, AggregatedTextFrame) for frame in pushed)
    await planner.cleanup()


@pytest.mark.asyncio
async def test_late_tokens_after_interruption_do_not_reach_tts(monkeypatch):
    planner = HebrewTurnPlanner()
    planner.push_frame = AsyncMock()
    monkeypatch.setattr(planner, "_start_interruption", AsyncMock())
    await planner.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await planner.process_frame(InterruptionFrame(), FrameDirection.DOWNSTREAM)
    await planner.process_frame(LLMTextFrame("תשובה ישנה"), FrameDirection.DOWNSTREAM)
    assert not any(
        isinstance(call.args[0], LLMTextFrame) for call in planner.push_frame.call_args_list
    )


@pytest.mark.asyncio
async def test_oversized_turn_recovers_with_complete_sentence_and_bounded_buffer():
    planner = HebrewTurnPlanner(max_chars=16)
    planner.push_frame = AsyncMock()
    await planner.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await planner.process_frame(LLMTextFrame("x" * 10000), FrameDirection.DOWNSTREAM)
    assert planner._parts == []
    await planner.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)
    output = planner.push_frame.call_args_list[-2].args[0]
    assert output.text == "התשובה ארוכה מדי למסירה בטוחה. אפשר להתמקד בשאלה אחת?"
    assert output.metadata["voice_delivery_state"] == "generated"
    assert output.metadata["model_first_token_ms"] >= 0


@pytest.mark.asyncio
async def test_structured_evidence_selector_is_preserved_verbatim(monkeypatch):
    text = '{"kind":"conversation","message":"תודה שעדכנת אותי איך אוכל לעזור לך היום?"}'
    frames = await _planned_frames(monkeypatch, text)
    assert frames[1].text == text


@pytest.mark.asyncio
async def test_character_budget_is_per_turn_and_overflow_does_not_poison_later_turn(monkeypatch):
    planner = HebrewTurnPlanner(max_chars=8)
    planner.push_frame = AsyncMock()
    clock = iter(range(0, 100_000_000, 1_000_000))
    monkeypatch.setattr("oron_agent.turn_planner.time.monotonic_ns", lambda: next(clock))
    for text in ["שלום", "תודה", "x" * 9, "בסדר"]:
        await planner.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
        await planner.process_frame(LLMTextFrame(text), FrameDirection.DOWNSTREAM)
        await planner.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)
    utterances = [
        call.args[0]
        for call in planner.push_frame.call_args_list
        if isinstance(call.args[0], AggregatedTextFrame)
    ]
    assert [frame.text for frame in utterances] == [
        "שלום",
        "תודה",
        "התשובה ארוכה מדי למסירה בטוחה. אפשר להתמקד בשאלה אחת?",
        "בסדר",
    ]
    assert all(frame.metadata["model_first_token_ms"] == 1 for frame in utterances)


@pytest.mark.asyncio
async def test_interruption_resets_overflow_budget_for_next_generation(monkeypatch):
    planner = HebrewTurnPlanner(max_chars=4)
    planner.push_frame = AsyncMock()
    monkeypatch.setattr(planner, "_start_interruption", AsyncMock())
    await planner.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await planner.process_frame(LLMTextFrame("old overflow"), FrameDirection.DOWNSTREAM)
    await planner.process_frame(InterruptionFrame(), FrameDirection.DOWNSTREAM)
    await planner.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await planner.process_frame(LLMTextFrame("שלום"), FrameDirection.DOWNSTREAM)
    await planner.process_frame(LLMFullResponseEndFrame(), FrameDirection.DOWNSTREAM)
    utterances = [
        call.args[0]
        for call in planner.push_frame.call_args_list
        if isinstance(call.args[0], AggregatedTextFrame)
    ]
    assert len(utterances) == 1 and utterances[0].text == "שלום"
