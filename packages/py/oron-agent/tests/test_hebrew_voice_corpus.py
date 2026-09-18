"""The Hebrew regression gate for what a caller actually hears.

Ordinary word error rate hides the failures that matter on a support call: a
flipped negation, a wrong amount, a mis-read phone digit, a date that moved.
Those are tracked here as CRITICAL errors and the target is zero, separately
from anything about pronunciation or naturalness.

Everything here runs the real seam — `make_speech_transformer`, which is what
`bot.py` registers on the TTS service — over the shared corpus in
`scripts/voice_quality/corpus.py`. The offline benchmark reads the same corpus,
so a case added for a live-call bug is measured and gated by one edit.

What this file cannot do: it cannot hear. Voice naturalness, prosody and
recognition accuracy need a provider and a listener.
"""

from __future__ import annotations

import pytest
from oron_agent.tts_clause import FirstClauseAggregator
from oron_agent.voice_quality import VoiceQualityConfig, make_speech_transformer
from pipecat.utils.text.base_text_aggregator import AggregationType
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

from scripts.voice_quality.corpus import SPOKEN_CORPUS, TURN_STREAMS, SpokenCase, TurnStream


async def _spoken(case: SpokenCase) -> str:
    transform = make_speech_transformer(
        VoiceQualityConfig(language=case.language),
        lambda: None,
        get_language=lambda: case.language,
    )
    return await transform(case.authored, None)


@pytest.mark.parametrize("case", SPOKEN_CORPUS, ids=lambda case: case.name)
async def test_no_critical_semantic_error_reaches_the_synthesizer(case: SpokenCase):
    spoken = await _spoken(case)

    missing = [fragment for fragment in case.must_keep if fragment not in spoken]
    leaked = [fragment for fragment in case.must_lose if fragment in spoken]
    assert not missing, f"{case.category}: lost {missing} from {case.authored!r} -> {spoken!r}"
    assert not leaked, f"{case.category}: kept {leaked} in {case.authored!r} -> {spoken!r}"


async def test_the_corpus_still_covers_every_critical_field_class():
    """A corpus that quietly loses a category stops being a gate. These are the
    classes where a single wrong token changes what the customer is told."""
    covered = {case.category for case in SPOKEN_CORPUS}

    assert {
        "negation",
        "money",
        "percent",
        "time",
        "date",
        "identifier",
        "address",
        "mixed_language",
        "name",
        "punctuation",
        "dense_numeric",
    } <= covered


def _squashed(segments: list[str]) -> str:
    return "".join("".join(segment.split()) for segment in segments)


async def _segments(aggregator, stream: TurnStream) -> list[str]:
    out: list[str] = []
    for chunk in stream.chunks:
        async for aggregation in aggregator.aggregate(chunk):
            if aggregation is not None and aggregation.text.strip():
                out.append(aggregation.text)
    flushed = await aggregator.flush()
    if flushed is not None and flushed.text.strip():
        out.append(flushed.text)
    return out


@pytest.mark.parametrize("stream", TURN_STREAMS, ids=lambda stream: stream.name)
async def test_sentence_aggregation_never_splits_a_price_time_or_product_name(
    stream: TurnStream,
):
    """Each segment opens its own Soniox stream. A price, a clock time, a phone
    number or a Hebrew-plus-English product name cut across two of them is
    synthesized without shared prosodic context and heard as a stumble."""
    for arm in (
        SimpleTextAggregator(aggregation_type=AggregationType.SENTENCE),
        FirstClauseAggregator(aggregation_type=AggregationType.SENTENCE),
    ):
        segments = await _segments(arm, stream)

        for atom in stream.atomic:
            assert any(atom in segment for segment in segments), (
                f"{type(arm).__name__} split {atom!r} across {segments}"
            )


@pytest.mark.parametrize(
    "turn", ["price_answer", "mixed_language_troubleshooting", "phone_readback"]
)
async def test_the_opening_clause_reaches_the_synthesizer_before_the_sentence_ends(turn: str):
    """What the first-clause fast path is for, and it still earns its place.

    On these turns the opener leaves at a clause mark instead of waiting for a
    full stop, which is the largest slice of the wait after the first LLM
    token. Nothing is lost or reordered — the same text is spoken, in one more
    piece — and no price, time or product name is cut in half doing it.
    """
    stream = next(s for s in TURN_STREAMS if s.name == turn)

    plain = await _segments(SimpleTextAggregator(aggregation_type=AggregationType.SENTENCE), stream)
    clause = await _segments(
        FirstClauseAggregator(aggregation_type=AggregationType.SENTENCE), stream
    )

    assert len(clause[0]) < len(plain[0]), "the opener did not leave early"
    assert clause[0].rstrip().endswith((",", ";"))
    assert len(clause) == len(plain) + 1, "only the opener may be split"
    # Whitespace-insensitive: each segment is stripped, so the space that used
    # to sit at the split point is gone by construction, not by rewriting.
    assert _squashed(clause) == _squashed(plain)
    for atom in stream.atomic:
        assert any(atom in segment for segment in clause)


@pytest.mark.parametrize("turn", ["opener_then_question", "short_confirmation"])
async def test_a_bare_connective_is_never_shipped_as_the_opener(turn: str):
    """ "שלום," and "כן," are below `min_chars`, so they wait for the sentence.
    Shipped alone they sound clipped and spend a whole Soniox stream on two
    syllables, which costs more than the head start is worth."""
    stream = next(s for s in TURN_STREAMS if s.name == turn)

    plain = await _segments(SimpleTextAggregator(aggregation_type=AggregationType.SENTENCE), stream)
    clause = await _segments(
        FirstClauseAggregator(aggregation_type=AggregationType.SENTENCE), stream
    )

    assert clause == plain


async def test_token_aggregation_cuts_through_the_values_a_caller_must_act_on():
    """Recorded so `TTS_TEXT_AGGREGATION=token` is rejected on evidence rather
    than taste. It starts sooner, but it hands Soniox one fragment at a time:
    an amount arrives as "129" / " " / "₪" and a date as "17" / " בספטמבר",
    each synthesized by a separate stream with no shared prosodic context."""
    for turn, atom in (("price_answer", "129 ₪"), ("appointment_with_numbers", "17 בספטמבר")):
        stream = next(s for s in TURN_STREAMS if s.name == turn)

        sentence = await _segments(
            FirstClauseAggregator(aggregation_type=AggregationType.SENTENCE), stream
        )
        token = await _segments(
            FirstClauseAggregator(aggregation_type=AggregationType.TOKEN), stream
        )

        assert any(atom in segment for segment in sentence)
        assert not any(atom in segment for segment in token), f"{turn}: token kept {atom!r}"
        assert len(token) > 3 * len(sentence)
