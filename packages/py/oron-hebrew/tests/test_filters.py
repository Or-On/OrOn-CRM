import pytest
from oron_hebrew.filters import HebrewNormalizeFilter


@pytest.mark.asyncio
async def test_filter_applies_normalizers_and_number_words():
    f = HebrewNormalizeFilter()
    out = await f.filter("ברחוב שקד 9 בשעה 12")
    assert "רחוב שקד תשעה" in out  # street masculine
    assert "שתים עשרה" in out  # hour feminine


@pytest.mark.asyncio
async def test_filter_converts_leftover_digits_to_words():
    f = HebrewNormalizeFilter()
    out = await f.filter("יש 3 פריטים")
    assert "שלושה" in out and "3" not in out


@pytest.mark.asyncio
async def test_filter_is_reentrant_no_niqqud_added():
    # The filter must NOT add niqqud (that is the Task 5 transform's job).
    f = HebrewNormalizeFilter()
    out = await f.filter("שלום")
    assert out == "שלום"
