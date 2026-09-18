from oron_hebrew.normalizers import (
    join_split_digits,
    normalize_address_numbers,
    normalize_currency,
    normalize_for_tts,
    normalize_hour_digits,
    normalize_number_tokens,
    normalize_prefixed_hours,
    normalize_time_ranges,
)


def test_time_range_uses_ad_not_hyphen():
    # Hours are feminine; the generic reader used to voice "שנים עשר".
    assert normalize_time_ranges("בין השעות 12:00-16:00") == "בין השעות שתים עשרה עד שש עשרה"
    assert normalize_time_ranges("בין השעות 8-12") == "בין השעות שמונה עד שתים עשרה"


def test_unlabelled_numeric_hyphen_is_not_assumed_to_be_a_time_range():
    assert normalize_time_ranges("52-1234567") == "52-1234567"


def test_time_range_leaves_non_digit_hyphen():
    assert normalize_time_ranges("רחוב ת-ל אביב") == "רחוב ת-ל אביב"


def test_join_split_digits():
    assert join_split_digits("דירה 1 1") == "דירה 11"


def test_street_number_is_masculine():
    assert normalize_address_numbers("רחוב שקד 9") == "רחוב שקד תשעה"
    assert normalize_address_numbers("ברחוב שקד 9 בשעה") == "ברחוב שקד תשעה בשעה"


def test_out_of_range_address_number_passes_through():
    assert "22" in normalize_address_numbers("רחוב שמואל הנגיד 22")


def test_currency_shekel_singular_plural_agorot():
    assert normalize_currency("50 ₪") == "חמישים שקלים"
    assert normalize_currency("1 ₪") == "שקל אחד"
    assert normalize_currency("2 ₪") == "שני שקלים"
    assert normalize_currency('99 ש"ח') == "תשעים ותשעה שקלים"
    assert normalize_currency("19.90 ₪") == "תשעה עשר שקלים ותשעים אגורות"


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
    assert normalize_for_tts("בין השעות 12:00-16:00") == "בין השעות שתים עשרה עד שש עשרה"


def test_prefixed_clock_time_is_feminine_and_drops_the_hyphen():
    assert normalize_prefixed_hours("ל-3 בצהריים") == "לשלוש בצהריים"
    assert normalize_prefixed_hours("ב-8 בערב") == "בשמונה בערב"
    assert normalize_prefixed_hours("מ-9 בבוקר") == "מתשע בבוקר"


def test_prefixed_clock_teen_is_feminine():
    assert normalize_prefixed_hours("ב-11 בבוקר") == "באחת עשרה בבוקר"


def test_prefixed_count_without_a_time_word_stays_masculine():
    """`ב-5 שקלים` is a count, not a clock time — shekels are masculine."""
    assert normalize_for_tts("זה עולה 5 שקלים") == "זה עולה חמישה שקלים"
    assert normalize_prefixed_hours("ל-3 שקלים") == "ל-3 שקלים"


def test_prefixed_hours_wired_into_normalize_for_tts():
    assert normalize_for_tts("התור נקבע ל-3 בצהריים") == "התור נקבע לשלוש בצהריים"


def test_time_range_preserves_nonzero_minutes_on_both_ends():
    assert normalize_time_ranges("10:15–11:45") == "עשר ורבע עד אחת עשרה וארבעים וחמש"
    assert normalize_for_tts("בשעה 10:15–11:45") == "בשעה עשר ורבע עד אחת עשרה וארבעים וחמש"


def test_number_spacing_without_address_label_is_not_reinterpreted():
    assert join_split_digits("הכמויות הן 1 5 או 50") == "הכמויות הן 1 5 או 50"


def test_currency_preserves_grouping_sign_and_fraction():
    assert normalize_currency("-1,500.05 ₪") == "מינוס אלף וחמש מאות שקלים וחמש אגורות"
    assert normalize_currency("150 ₪") != normalize_currency("1,500 ₪")
    assert normalize_currency("1.500 ₪") == "1.500 ₪"


def test_numeric_tokens_preserve_decimal_zeros_dates_and_identifiers():
    assert normalize_number_tokens("-0.05") == "מינוס אפס נקודה אפס חמש"
    assert normalize_number_tokens("0015") == "אפס אפס אחת חמש"
    assert normalize_number_tokens("12/09/2026 10:45 1,50") == "12/09/2026 10:45 1,50"
    assert normalize_number_tokens("1,500") == "אלף וחמש מאות"


def test_six_digit_quantity_no_longer_crashes_number_conversion():
    assert normalize_number_tokens("150000") == "מאה וחמישים אלף"
