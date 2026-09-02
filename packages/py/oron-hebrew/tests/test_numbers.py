import re
import unicodedata

from oron_hebrew.numbers import (
    NUMBER_NIQQUD,
    feminine_hour_minute,
    hebrew_number,
    number_to_hebrew,
    protect_numbers,
    restore_numbers,
)

_NIQQUD = re.compile(r"[֑-ׇ]")


def _strip(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if not _NIQQUD.match(c))


def test_hebrew_number_gendered_1_20():
    assert hebrew_number(11, gender="feminine") == "אחת עשרה"
    assert hebrew_number(11, gender="masculine") == "אחד עשר"


def test_number_to_hebrew_full_range_masculine():
    assert number_to_hebrew(0) == "אפס"
    assert number_to_hebrew(42) == "ארבעים ושניים"
    assert number_to_hebrew(123) == "מאה ועשרים ושלושה"


def test_feminine_hour_minute():
    assert feminine_hour_minute(2) == "שתיים"
    assert feminine_hour_minute(12) == "שתים עשרה"


def test_protect_maps_numbers_to_dicta_niqqud():
    protected, restore = protect_numbers("מתחיל בשעה שתים עשרה")
    assert "שתים עשרה" not in protected  # replaced by placeholder
    assert "שְׁתֵּים עֶשְׂרֵה" in restore.values()
    assert "בְּשָׁעָה" in restore.values()


def test_longest_match_wins():
    _, restore = protect_numbers("השעה שתים עשרה בדיוק")
    assert "שְׁתֵּים עֶשְׂרֵה" in restore.values()
    assert "שְׁתַּיִם" not in restore.values()


def test_restore_roundtrip_consonants_unchanged():
    protected, restore = protect_numbers("בשעה שלוש")
    restored = restore_numbers(protected, restore)
    assert _strip(restored) == "בשעה שלוש"


def test_all_table_values_carry_niqqud():
    for bare, pointed in NUMBER_NIQQUD.items():
        assert _NIQQUD.search(pointed), f"{bare!r} has no niqqud"
