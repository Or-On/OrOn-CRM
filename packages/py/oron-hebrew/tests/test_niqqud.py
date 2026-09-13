import re

import pytest
from oron_hebrew.niqqud import make_hebrew_niqqud_transformer

_NIQQUD = re.compile(r"[֑-ׇ]")


class _FixtureG2P:
    def vocalize(self, text, **_kwargs):
        return text.replace("מה", "מָה")


@pytest.mark.asyncio
async def test_transformer_adds_niqqud_to_hebrew():
    tf = make_hebrew_niqqud_transformer(_FixtureG2P(), get_caller_gender=lambda: "male")
    out = await tf("מה שלומך", "*")
    assert _NIQQUD.search(out)


@pytest.mark.asyncio
async def test_transformer_protects_number_words():
    tf = make_hebrew_niqqud_transformer(_FixtureG2P(), get_caller_gender=lambda: None)
    out = await tf("מתחיל בשעה שתים עשרה", "*")
    assert "שְׁתֵּים עֶשְׂרֵה" in out  # Dicta form, not the model's *shtaim*
    assert "בְּשָׁעָה" in out


@pytest.mark.asyncio
async def test_transformer_gates_on_hebrew_and_empty():
    tf = make_hebrew_niqqud_transformer(_FixtureG2P(), get_caller_gender=lambda: None)
    assert await tf("Are you ready?", "*") == "Are you ready?"
    assert await tf("", "*") == ""


@pytest.mark.asyncio
async def test_transformer_degrades_when_g2p_is_none():
    tf = make_hebrew_niqqud_transformer(None, get_caller_gender=lambda: None)
    assert await tf("מה שלומך", "*") == "מה שלומך"  # passthrough, never crashes


@pytest.mark.asyncio
async def test_authored_pronunciations_survive_pointing_being_off():
    """Turning niqqud off must not also drop the lexicon. It is there to fix
    names the vendor mispronounces, which it does pointed or not."""
    tf = make_hebrew_niqqud_transformer(
        None, get_caller_gender=lambda: None, pronunciations={"אלי": "אֵלִי"}
    )
    assert await tf("מדבר אלי כהן", "*") == "מדבר אֵלִי כהן"


@pytest.mark.asyncio
async def test_caller_address_homographs_are_pointed_for_male_when_global_niqqud_is_off():
    tf = make_hebrew_niqqud_transformer(None, get_caller_gender=lambda: "male")

    assert await tf("איך אוכל לעזור לך? הבנתי שניסית ובדקת.", "*") == (
        "איך אוכל לעזור לְךָ? הבנתי שנִסִּיתָ ובָּדַקְתָּ."
    )


@pytest.mark.asyncio
async def test_caller_address_homographs_are_pointed_for_female_when_global_niqqud_is_off():
    tf = make_hebrew_niqqud_transformer(None, get_caller_gender=lambda: "female")

    assert await tf("איך אוכל לעזור לך? הבנתי שניסית ובדקת.", "*") == (
        "איך אוכל לעזור לָךְ? הבנתי שנִסִּיתְ ובָּדַקְתְּ."
    )


@pytest.mark.asyncio
async def test_caller_address_pointing_stays_off_without_an_explicit_form():
    tf = make_hebrew_niqqud_transformer(None, get_caller_gender=lambda: None)

    assert await tf("איך אוכל לעזור לך?", "*") == "איך אוכל לעזור לך?"


def test_lexicon_does_not_change_a_name_inside_another_name():
    from oron_hebrew.niqqud import _protect_lexicon
    from oron_hebrew.numbers import restore_numbers

    protected, restore = _protect_lexicon("אלי ישראלי", {"אלי": "אֵלִי"})
    assert restore_numbers(protected, restore) == "אֵלִי ישראלי"


def test_pointing_does_not_apply_callers_preference_inside_quote():
    from oron_hebrew.niqqud import point_caller_address

    assert point_caller_address('היא אמרה "ניסית"', "male") == 'היא אמרה "ניסית"'


@pytest.mark.asyncio
async def test_retained_lexicon_cannot_rewrite_critical_semantics():
    transform = make_hebrew_niqqud_transformer(
        None,
        get_caller_gender=lambda: None,
        pronunciations={
            "לא": "כן",
            "150": "50",
            "pending": "ושולם",
            "אלי": "אֵלִי",
            "Or-On": "אוֹר אוֹן",
        },
    )
    assert await transform("אלי לא שילם 150 עבור Or-On: pending", None) == (
        "אֵלִי לא שילם 150 עבור אוֹר אוֹן: pending"
    )


@pytest.mark.asyncio
async def test_retained_lexicon_ignores_oversized_and_markup_entries():
    transform = make_hebrew_niqqud_transformer(
        None,
        get_caller_gender=lambda: None,
        pronunciations={"brand": "x" * 81, "other": "<break/>"},
    )
    assert await transform("בדיקת brand other", None) == "בדיקת brand other"
