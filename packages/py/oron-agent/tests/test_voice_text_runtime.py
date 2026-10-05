"""Speech still works in the final image without NLTK or provider access."""

import asyncio
import json
import random
import sys
import time
from pathlib import Path

import pytest
from oron_agent.tts_clause import (
    SentenceAggregator,
    SentenceFrameSequencer,
    _RuntimeParallelAggregator,
    sentence_boundary,
)
from pipecat.frames.frames import AggregatedTextFrame, TTSTextFrame
from pipecat.utils.text.base_text_aggregator import AggregationType


async def _sentences(chunks):
    aggregator = SentenceAggregator()
    results = []
    for chunk in chunks:
        results.extend([item.text async for item in aggregator.aggregate(chunk)])
    pending = await aggregator.flush()
    if pending:
        results.append(pending.text)
    return results


@pytest.mark.parametrize(
    "sentences",
    [
        ["המחיר 29.90 ש״ח בגרסה v1.2.3.", "הכול תקין."],
        ["Contact Dr. A. B. Smith at a@b.co.il.", "Next sentence."],
        ["See e.g. https://or-on.io/x?y=1.2 or /tmp/v1.2/file.", "All done."],
        ["ד״ר כהן בודק את מס׳ הקריאה.", "תודה רבה."],
        ["הוא אמר ״שלום.״", "היא השיבה ״תודה!״"],
        ["באמת?!", "אולי...", "כן בהחלט."],
        ["مرحبا؟", "שלום לכולם."],
    ],
)
async def test_sentence_boundaries_preserve_entities_across_arbitrary_chunking(sentences):
    text = " ".join(sentences)
    assert await _sentences([text]) == sentences
    assert await _sentences(text) == sentences
    assert (
        await _sentences(text[index : index + 3] for index in range(0, len(text), 3)) == sentences
    )


async def test_lookahead_keeps_decimal_and_closing_quotes_until_next_word_or_flush():
    aggregator = SentenceAggregator()
    assert [item async for item in aggregator.aggregate("המחיר 29.")] == []
    assert [item async for item in aggregator.aggregate("90.״ \n ")] == []
    confirmed = [item.text async for item in aggregator.aggregate("ב")]
    assert confirmed == ["המחיר 29.90.״"]
    assert (await aggregator.flush()).text == "\n ב"
    assert await aggregator.flush() is None


def test_long_punctuation_without_separator_does_not_backtrack_quadratically():
    started = time.monotonic()
    assert sentence_boundary("." * 20000 + "x") == 0
    # Generous allowance for a loaded runner; the linear match takes milliseconds.
    assert time.monotonic() - started < 2


async def test_repeated_abbreviations_are_not_rescanned_on_every_lookahead():
    text = "A. " * 2000 + "ending. Next."
    started = time.monotonic()
    assert await _sentences([text]) == ["A. " * 2000 + "ending.", "Next."]
    assert time.monotonic() - started < 2


async def test_parallel_channels_preserve_every_character_after_length_changing_transform():
    text = "שלום וברכה. המחיר 29.90 ש״ח! אפשר לעזור? שלום שוב."
    for seed in range(20):
        rng = random.Random(seed)  # noqa: S311 - reproducible chunk partitions
        chunks = []
        offset = 0
        while offset < len(text):
            width = rng.randint(1, 12)
            chunks.append(text[offset : offset + width])
            offset += width
        aggregator = _RuntimeParallelAggregator()
        results = []
        for chunk in chunks:
            results.extend(
                [
                    item
                    async for item in aggregator.aggregate(
                        chunk.replace("ש", "שָׁ"), chunk.replace("ש", "[ש]"), chunk
                    )
                ]
            )
        pending = await aggregator.flush()
        if pending:
            results.append(pending)
        assert "".join(item.tts_text for item in results) == text.replace("ש", "שָׁ")
        assert "".join(item.llm_text for item in results) == text.replace("ש", "[ש]")
        assert "".join(item.user_facing_text for item in results) == text


async def test_aligned_token_channels_split_multiple_sentences_inside_one_chunk():
    text = "שלום לכולם. המחיר 29.90 ש״ח. אפשר לעזור?"
    aggregator = _RuntimeParallelAggregator()
    results = [item async for item in aggregator.aggregate(text, text, text)]
    assert [item.tts_text for item in results] == ["שלום לכולם.", " המחיר 29.90 ש״ח."]
    results.append(await aggregator.flush())
    for channel in ("tts_text", "llm_text", "user_facing_text"):
        assert "".join(getattr(item, channel) for item in results) == text


async def test_interruption_discards_old_channels_before_a_fresh_sentence():
    aggregator = _RuntimeParallelAggregator()
    assert [item async for item in aggregator.aggregate("קודם", "ישן", "בוטל")] == []
    await aggregator.handle_interruption()
    text = "תשובה חדשה. הכול תקין."
    results = [item async for item in aggregator.aggregate(text, text, text)]
    results.append(await aggregator.flush())
    assert "".join(item.user_facing_text for item in results) == text


def _token(text, raw_text=None):
    return AggregatedTextFrame(text, AggregationType.TOKEN, raw_text=raw_text)


async def test_token_contexts_keep_identity_context_flags_and_stale_word_fencing():
    sequencer = SentenceFrameSequencer(streaming=True)
    assert (
        await sequencer.register_spoken(_token("שלום"), "old", "שָׁלוֹם", True, build_tracker=False)
        == []
    )
    sequencer.clear()
    assert sequencer.process_word("שלום", 10, "old") == []
    assert await sequencer.finalize("old") == []

    await sequencer.register_spoken(
        _token("תשובה חדשה", "[raw] תשובה חדשה"),
        "fresh",
        "תְּשׁוּבָה חדשה",
        True,
        build_tracker=False,
    )
    await sequencer.register_spoken(
        _token("הודעה נפרדת"), "other", "הודעה נפרדת", False, build_tracker=False
    )
    fresh = await sequencer.finalize("fresh")
    other = await sequencer.finalize("other")
    fresh_text = [frame for frame in fresh if isinstance(frame, TTSTextFrame)]
    other_text = [frame for frame in other if isinstance(frame, TTSTextFrame)]
    assert [
        (frame.text, frame.raw_text, frame.context_id, frame.append_to_context)
        for frame in fresh_text
    ] == [("תשובה חדשה", "[raw] תשובה חדשה", "fresh", True)]
    assert [(frame.text, frame.context_id, frame.append_to_context) for frame in other_text] == [
        ("הודעה נפרדת", "other", False)
    ]
    sequencer.force_complete("fresh", 20)
    assert sequencer.process_word("חדשה", 30, "fresh") == []


async def test_word_timestamps_before_sentence_promotion_retain_context_and_pts():
    sequencer = SentenceFrameSequencer(streaming=True)
    assert await sequencer.register_spoken(_token("שלום "), "current", "שלום ", True) == []
    assert sequencer.process_word("שלום", 1234, "current") == []
    frames = await sequencer.register_spoken(_token("עולם. הבא"), "current", "עולם. הבא", True)
    spoken = [frame for frame in frames if isinstance(frame, TTSTextFrame)]
    assert len(spoken) == 1
    assert spoken[0].text == "שלום"
    assert spoken[0].pts == 1234
    assert spoken[0].context_id == "current"
    assert spoken[0].append_to_context


async def test_installed_runtime_in_fresh_process_cannot_import_nltk():
    script = Path(__file__).resolve().parents[4] / "scripts" / "check_voice_text_runtime.py"
    process = await asyncio.create_subprocess_exec(
        sys.executable, str(script), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=60)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise
    assert process.returncode == 0, stderr.decode(errors="replace")
    result = json.loads(stdout)
    assert result["nltk_import_blocked"]
    assert result["passed"] == 16
    assert {case["provider"] for case in result["cases"]} == {"soniox", "gemini"}
    assert {case["mode"] for case in result["cases"]} == {"sentence", "token"}
