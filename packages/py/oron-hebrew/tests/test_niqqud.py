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
