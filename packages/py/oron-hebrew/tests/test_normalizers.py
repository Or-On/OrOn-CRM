from oron_hebrew.normalizers import (
    join_split_digits,
    normalize_address_numbers,
    normalize_currency,
    normalize_for_tts,
    normalize_hour_digits,
    normalize_prefixed_hours,
    normalize_time_ranges,
)


def test_time_range_uses_ad_not_hyphen():
    assert normalize_time_ranges("בין השעות 12:00-16:00") == "בין השעות 12 עד 16"
    assert normalize_time_ranges("8-12") == "8 עד 12"


def test_time_range_leaves_non_digit_hyphen():
    assert normalize_time_ranges("רחוב ת-ל אביב") == "רחוב ת-ל אביב"


def test_join_split_digits():
    assert join_split_digits("דירה 1 1") == "דירה 11"


def test_street_number_is_masculine():
    assert normalize_address_numbers("רחוב שקד 9") == "רחוב שקד תשעה"


def test_out_of_range_address_number_passes_through():
    assert "22" in normalize_address_numbers("רחוב שמואל הנגיד 22")


def test_currency_shekel_singular_plural_agorot():
    assert normalize_currency("50 ₪") == "50 שקלים"
    assert normalize_currency("1 ₪") == "שקל אחד"
    assert normalize_currency('99 ש"ח') == "99 שקלים"
    assert normalize_currency("19.90 ₪") == "19 שקלים ו90 אגורות"


def test_normalize_for_tts_order():
    # digit-join must run before the address rewrite sees "1 1".
    assert normalize_for_tts("רחוב שקד 1 1") == "רחוב שקד אחד עשר"


def test_hour_digit_after_beshaa_reads_feminine():
    out = normalize_hour_digits("בשעה 12")
    assert "שתים עשרה" in out
    assert "שנים עשר" not in out


def test_hour_digit_after_hashaa_reads_feminine():
    out = normalize_hour_digits("השעה 3")
    assert "שלוש" in out
    assert "שלושה" not in out


def test_hour_digit_two_reads_feminine():
    assert "שתיים" in normalize_hour_digits("בשעה 2")


def test_hour_digits_wired_into_normalize_for_tts():
    out = normalize_for_tts("בשעה 12")
    assert "שתים עשרה" in out
    assert "שנים עשר" not in out


def test_street_number_unaffected_by_hour_rule():
    assert normalize_for_tts("רחוב שקד 9") == "רחוב שקד תשעה"


def test_time_range_rule_still_works_with_hour_rule_wired():
    assert normalize_for_tts("בין השעות 12:00-16:00") == "בין השעות 12 עד 16"


def test_prefixed_clock_time_is_feminine_and_drops_the_hyphen():
    assert normalize_prefixed_hours("ל-3 בצהריים") == "לשלוש בצהריים"
    assert normalize_prefixed_hours("ב-8 בערב") == "בשמונה בערב"
    assert normalize_prefixed_hours("מ-9 בבוקר") == "מתשע בבוקר"


def test_prefixed_clock_teen_is_feminine():
    assert normalize_prefixed_hours("ב-11 בבוקר") == "באחת עשרה בבוקר"


def test_prefixed_count_without_a_time_word_stays_masculine():
    """`ב-5 שקלים` is a count, not a clock time — shekels are masculine."""
    assert normalize_for_tts("זה עולה 5 שקלים") == "זה עולה 5 שקלים"
    assert normalize_prefixed_hours("ל-3 שקלים") == "ל-3 שקלים"


def test_prefixed_hours_wired_into_normalize_for_tts():
    assert normalize_for_tts("התור נקבע ל-3 בצהריים") == "התור נקבע לשלוש בצהריים"
