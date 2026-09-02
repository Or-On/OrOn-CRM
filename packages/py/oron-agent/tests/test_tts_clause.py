"""The opening clause of a turn reaches TTS without waiting for its sentence."""

from oron_agent.tts_clause import FirstClauseAggregator


async def _drain(agg, *chunks) -> list[str]:
    out = []
    for chunk in chunks:
        async for a in agg.aggregate(chunk):
            out.append(a.text)
    return out


OPENER = "זה נושא חשוב מאוד, "
REST = "אלי כהן הוא רואה חשבון מוסמך. מה דעתך?"


async def test_the_opening_clause_leaves_before_its_sentence_is_finished():
    agg = FirstClauseAggregator()
    assert await _drain(agg, OPENER) == ["זה נושא חשוב מאוד,"]


async def test_only_the_opener_splits_on_a_comma():
    """Every later chunk opens its own TTS session, so splitting them adds a gap
    mid-answer and buys nothing — only the first chunk gates the audio."""
    agg = FirstClauseAggregator()
    spoken = await _drain(agg, OPENER + REST)

    assert spoken[0] == "זה נושא חשוב מאוד,"
    assert "אלי כהן הוא רואה חשבון מוסמך." in spoken
    assert not any(s.endswith(",") for s in spoken[1:])


async def test_a_bare_connective_is_not_shipped_as_the_opener():
    """ "אז," is two syllables — it sounds clipped and spends a whole TTS
    session on nothing."""
    agg = FirstClauseAggregator()
    assert await _drain(agg, "אז, ") == []
    # Inherited lookahead: nothing ships until a non-whitespace char follows.
    assert await _drain(agg, "מה דעתך על זה?") == []
    assert await _drain(agg, " ו") == ["אז, מה דעתך על זה?"]


async def test_a_sentence_with_no_comma_goes_whole_at_the_end_of_the_response():
    """No clause mark, so nothing leaves early, and the lookahead never sees a
    following character — `flush()` at the end of the LLM response is what
    releases it. That is the same turn, so the caller waits no longer."""
    agg = FirstClauseAggregator()
    assert await _drain(agg, "אני עדיין כאן. ") == []
    pending = await agg.flush()
    assert pending is not None and pending.text == "אני עדיין כאן."


async def test_token_by_token_arrival_finds_the_same_boundary():
    """The LLM streams a few characters at a time, not whole clauses."""
    agg = FirstClauseAggregator()
    spoken = await _drain(agg, *OPENER)
    assert spoken == ["זה נושא חשוב מאוד,"]


async def test_every_turn_splits_not_only_the_first():
    """`TTSService` never calls reset(); flush() is the only turn boundary, so
    without clearing there the latch makes this the last turn ever split."""
    agg = FirstClauseAggregator()
    await _drain(agg, OPENER)
    await agg.flush()

    assert await _drain(agg, OPENER) == ["זה נושא חשוב מאוד,"]


async def test_an_interruption_drops_the_half_built_clause():
    agg = FirstClauseAggregator()
    await _drain(agg, "זה נושא חשוב")
    await agg.handle_interruption()

    assert agg.text.text == ""
    assert await _drain(agg, OPENER) == ["זה נושא חשוב מאוד,"]


async def test_flush_returns_the_tail_that_never_ended_in_punctuation():
    agg = FirstClauseAggregator()
    await _drain(agg, "בסדר גמור")
    pending = await agg.flush()

    assert pending is not None
    assert pending.text == "בסדר גמור"
    assert await agg.flush() is None


def test_build_tts_actually_installs_the_clause_aggregator():
    """The wiring, not the aggregator: a swap that leaves the default aggregator
    in place passes every unit test in this file."""
    from oron_agent.tts import build_tts
    from oron_flows import TtsProvider
    from pipecat.services.tts_service import TextAggregationMode
    from pipecat.transcriptions.language import Language

    def _tts(first_clause: bool):
        return build_tts(
            TtsProvider.SONIOX,
            language=Language.HE,
            voice="v",
            text_filters=[],
            text_aggregation_mode=TextAggregationMode.SENTENCE,
            first_clause=first_clause,
            speed=1.0,
            soniox_api_key="k",
            soniox_model="m",
            gemini_model="g",
            google_credentials_path=None,
        )

    assert isinstance(_tts(True)._text_aggregator, FirstClauseAggregator)
    assert not isinstance(_tts(False)._text_aggregator, FirstClauseAggregator)


async def test_token_mode_survives_the_clause_aggregator():
    """Installing this must not silently disable TTS_TEXT_AGGREGATION: the
    parent's TOKEN early-return has to run before the clause hook is reached."""
    from pipecat.utils.text.base_text_aggregator import AggregationType

    agg = FirstClauseAggregator(aggregation_type=AggregationType.TOKEN)
    assert await _drain(agg, "שלום עולם ") == ["שלום עולם "]


async def test_a_sentence_end_is_not_split_from_the_digits_after_it():
    """`"...29."` then `"90 שקלים"` must not be spoken as two utterances.

    The hand-rolled version called match_endofsentence with no lookahead and
    split there; pipecat holds a sentence until a non-whitespace character
    follows the terminal punctuation. A canvassing bot quotes numbers.
    """
    spoken = await _drain(FirstClauseAggregator(), "המחיר המעודכן הוא 29.", "90 שקלים לחודש")
    assert not any(chunk.endswith("29.") for chunk in spoken), spoken


def test_the_default_installs_the_aggregator_end_to_end():
    """Guards the DEFAULT, which the wiring test cannot: that one passes
    first_clause explicitly, so flipping the default back to False leaves it
    green while production quietly reverts."""
    from oron_agent.config import Settings
    from oron_agent.tts import build_tts
    from oron_flows import TtsProvider
    from pipecat.services.tts_service import TextAggregationMode
    from pipecat.transcriptions.language import Language

    service = build_tts(
        TtsProvider.SONIOX,
        language=Language.HE,
        voice="v",
        text_filters=[],
        text_aggregation_mode=TextAggregationMode.SENTENCE,
        first_clause=Settings.model_fields["tts_first_clause"].default,
        speed=1.0,
        soniox_api_key="k",
        soniox_model="m",
        gemini_model="g",
        google_credentials_path=None,
    )
    assert isinstance(service._text_aggregator, FirstClauseAggregator)
