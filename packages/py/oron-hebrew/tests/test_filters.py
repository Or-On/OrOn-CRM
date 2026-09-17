import pytest
from oron_hebrew.filters import HebrewNormalizeFilter, normalize_question_boundary


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


@pytest.mark.asyncio
async def test_filter_removes_only_terminal_full_stops():
    f = HebrewNormalizeFilter()

    assert await f.filter("נשמח לעזור.") == "נשמח לעזור"
    assert await f.filter("רגע...   ") == "רגע   "
    assert await f.filter("באמת?") == "באמת?"
    assert await f.filter("א.ב נשאר") == "א.ב נשאר"


@pytest.mark.asyncio
async def test_filter_drops_only_sentence_final_full_stops():
    f = HebrewNormalizeFilter()

    assert await f.filter("תודה רבה.") == "תודה רבה"
    assert await f.filter("תודה רבה...") == "תודה רבה"
    assert await f.filter("המחיר הוא 29.90 שקלים") == "המחיר הוא עשרים ותשעה שקלים ותשעים אגורות"
    assert await f.filter("אפשר לעזור?") == "אפשר לעזור?"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text",
    [
        "שמך המלא הוא [שם מלא]?",
        "שמך המלא הוא {{full_name}}?",
        "שמך המלא הוא ${full_name}?",
    ],
)
async def test_filter_never_speaks_an_unresolved_hebrew_placeholder(text):
    out = await HebrewNormalizeFilter().filter(text)

    assert "שם מלא" not in out
    assert "full_name" not in out
    assert out == "סליחה, חסר לי פרט כדי להמשיך. אפשר לומר לי אותו?"


@pytest.mark.asyncio
async def test_filter_never_speaks_an_unresolved_english_placeholder():
    out = await HebrewNormalizeFilter().filter("Your name is [full_name]?")

    assert out == "Sorry, I need one detail before we continue. Could you tell me?"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("סליחה רבה על הטעות! תודה שתיקנת אותי.", "סליחה, טעיתי! תודה שתיקנת אותי"),
        ("סליחה רבה. נמשיך?", "סליחה, טעיתי. נמשיך?"),
    ],
)
async def test_filter_replaces_unidiomatic_hebrew_apology(text, expected):
    assert await HebrewNormalizeFilter().filter(text) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("בשעה 10:00 בבוקר", "בשעה עשר בבוקר"),
        ("בשעה 10:15 בבוקר", "בשעה עשר ורבע בבוקר"),
        ("בשעה 10:30 בבוקר", "בשעה עשר וחצי בבוקר"),
        ("בשעה 10:45 בבוקר", "בשעה עשר וארבעים וחמש בבוקר"),
    ],
)
async def test_filter_speaks_clock_times_without_colons_or_zero_minutes(text, expected):
    assert await HebrewNormalizeFilter().filter(text) == expected


@pytest.mark.asyncio
async def test_filter_attaches_written_hebrew_date_prefix_after_number_expansion():
    assert await HebrewNormalizeFilter().filter("ה-17 בספטמבר") == "השבעה עשר בספטמבר"


@pytest.mark.asyncio
async def test_filter_separates_a_trailing_question_from_the_answer_before_it():
    text = "אני מבינה שאין לך מספר לקוח האם יש דרך אחרת לזהות אותך?"

    assert await HebrewNormalizeFilter().filter(text) == (
        "אין לך מספר לקוח. האם יש דרך אחרת לזהות אותך?"
    )


@pytest.mark.asyncio
async def test_filter_keeps_a_single_short_question_unchanged():
    assert await HebrewNormalizeFilter().filter("איך אוכל לעזור לך?") == "איך אוכל לעזור לך?"


@pytest.mark.asyncio
async def test_filter_separates_the_latest_calls_three_word_acknowledgement():
    text = "תודה שעדכנת אותי איך אוכל לעזור לך היום?"

    assert await HebrewNormalizeFilter().filter(text) == (
        "תודה שעדכנת אותי. איך אוכל לעזור לך היום?"
    )


@pytest.mark.asyncio
async def test_filter_restores_a_missing_question_mark_at_the_same_boundary():
    text = "תודה שעדכנת אותי איך אוכל לעזור לך היום"

    assert await HebrewNormalizeFilter().filter(text) == (
        "תודה שעדכנת אותי. איך אוכל לעזור לך היום?"
    )


@pytest.mark.asyncio
async def test_filter_does_not_split_an_embedded_question_clause():
    text = "אני רוצה לדעת איזה דגם של ממיר יש לך"

    assert await HebrewNormalizeFilter().filter(text) == text


@pytest.mark.asyncio
async def test_filter_separates_a_question_introduced_by_ratziti_levarer():
    text = "ברוך השם, מצוין תודה ששאלת רציתי לברר אם קיבלת את המייל?"

    assert await HebrewNormalizeFilter().filter(text) == (
        "ברוך השם, מצוין תודה ששאלת. רציתי לברר אם קיבלת את המייל?"
    )


@pytest.mark.asyncio
async def test_filter_removes_generic_self_reference_before_the_useful_answer():
    text = "אני מבינה כדי שאוכל לעזור לך אצטרך את דגם הממיר תוכל לבדוק זאת?"

    assert await HebrewNormalizeFilter(lambda: "male").filter(text) == (
        "כדי שאוכל לעזור לך אצטרך את דגם הממיר. תוכל לבדוק זאת?"
    )


@pytest.mark.asyncio
async def test_filter_enforces_selected_male_address_without_changing_agent_self_reference():
    text = "אני מבינה. תוכלי בבקשה למסור מספר לקוח?"

    assert await HebrewNormalizeFilter(lambda: "male").filter(text) == (
        "תוכל בבקשה למסור מספר לקוח?"
    )


@pytest.mark.asyncio
async def test_filter_does_not_confuse_the_direct_object_marker_with_female_address():
    text = "קיבלתי את מספר הטלפון. האם את מוכנה להמשיך?"

    assert await HebrewNormalizeFilter(lambda: "male").filter(text) == (
        "קיבלתי את מספר הטלפון. האם אתה מוכן להמשיך?"
    )


@pytest.mark.asyncio
async def test_filter_can_enforce_selected_female_address():
    text = "תוכל לומר אם אתה מוכן להמשיך?"

    assert await HebrewNormalizeFilter(lambda: "female").filter(text) == (
        "תוכלי לומר אם את מוכנה להמשיך?"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("recorded", "expected"),
    [
        (
            "אני בסדר גמור, תודה ששאלת איך אוכל לעזור לך היום?",
            "אני בסדר גמור, תודה ששאלת. איך אוכל לעזור לך היום?",
        ),
        (
            "בטח, אשמח לעזור לך כדי שאוכל לבדוק את פרטי התיקון, "
            "תוכלי בבקשה למסור לי את מספר תעודת הזהות שלך?",
            "בטח, אשמח לעזור לך כדי שאוכל לבדוק את פרטי התיקון. "
            "תוכל בבקשה למסור לי את מספר תעודת הזהות שלך?",
        ),
        (
            "אני מבינה ללא מספר תעודת זהות, אין באפשרותי לגשת לפרטי המנוי "
            "ולטפל בבקשה האם יש דרך אחרת שבה אוכל לזהות אותך?",
            "אני מבינה ללא מספר תעודת זהות, אין באפשרותי לגשת לפרטי המנוי "
            "ולטפל בבקשה. האם יש דרך אחרת שבה אוכל לזהות אותך?",
        ),
    ],
)
async def test_latest_recorded_run_on_responses_are_repaired(recorded, expected):
    assert await HebrewNormalizeFilter(lambda: "male").filter(recorded) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text",
    [
        (
            "אוקיי, אני מבינה. כדי שאוכל לעזור לך, אצטרך כמה פרטים. "
            "האם מדובר בממיר ספציפי או שאתה רוצה לברר באופן כללי על השירות?"
        ),
        (
            "אני מבינה שניסית כבר כמה דברים. כדי שאוכל לבדוק את פרטי הממיר "
            "הספציפי ולראות איך אפשר לעזור, אצטרך את מספר הלקוח שלך. "
            "האם תוכל למסור לי אותו?"
        ),
    ],
)
async def test_latest_already_punctuated_turn_is_not_split_again(text):
    once = normalize_question_boundary(text)
    twice = normalize_question_boundary(once)

    assert once == text
    assert twice == text


@pytest.mark.asyncio
async def test_latest_fillers_are_removed_without_breaking_sentence_grammar():
    assert (
        await HebrewNormalizeFilter(lambda: "male").filter(
            "אוקיי, אני מבינה. כדי שאוכל לעזור לך, אצטרך כמה פרטים. האם מדובר בממיר ספציפי?"
        )
        == "כדי שאוכל לעזור לך, אצטרך כמה פרטים. האם מדובר בממיר ספציפי?"
    )

    assert (
        await HebrewNormalizeFilter(lambda: "male").filter(
            "אני מבינה שניסית כבר כמה דברים. האם תוכל למסור מספר לקוח?"
        )
        == "ניסית כבר כמה דברים. האם תוכל למסור מספר לקוח?"
    )


@pytest.mark.asyncio
async def test_question_that_begins_with_an_early_cue_is_not_split_again():
    text = "תוך כמה זמן תרצה שנתאם את הגעת הטכנאי?"

    assert await HebrewNormalizeFilter(lambda: "male").filter(text) == text


@pytest.mark.asyncio
async def test_latest_spelling_and_latin_terms_are_normalized_before_speech():
    text = "האם זה המסבר הנכון? בדוק את כבל HDMI ואז אשלח WhatsApp."

    assert await HebrewNormalizeFilter(lambda: "male").filter(text) == (
        "האם זה המספר הנכון? בדוק את כבל אֵייץ' דִּי אֶם אַיי ואז אשלח ווטסאפ"
    )


@pytest.mark.asyncio
async def test_phone_number_is_read_digit_by_digit_and_never_as_a_time_range():
    output = await HebrewNormalizeFilter(lambda: "male").filter(
        "המספר הוא 52-1234567. האם זה המספר הנכון?"
    )

    assert output == ("המספר הוא חמש שתיים אחת שתיים שלוש ארבע חמש שש שבע. האם זה המספר הנכון?")
    assert "עד" not in output


@pytest.mark.asyncio
async def test_negation_amount_and_correction_survive_speech_normalization():
    output = await HebrewNormalizeFilter().filter("לא 150 ₪, אלא 1,500.05 ₪ ביום שני")
    assert output == "לא מאה וחמישים שקלים, אלא אלף וחמש מאות שקלים וחמש אגורות ביום שני"


@pytest.mark.asyncio
async def test_quoted_second_person_is_not_rewritten_to_callers_preference():
    text = 'היא אמרה "תוכלי להמשיך". תוכל להמשיך?'
    assert await HebrewNormalizeFilter(lambda: "male").filter(text) == text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # Gershayim, prefix symbol and decimal comma are all money, never "נקודה".
        ("המחיר 29.90 ש״ח", "המחיר עשרים ותשעה שקלים ותשעים אגורות"),
        ('המחיר 29.90 ש"ח', "המחיר עשרים ותשעה שקלים ותשעים אגורות"),
        ("המחיר ₪29.90", "המחיר עשרים ותשעה שקלים ותשעים אגורות"),
        ("המחיר 29,90 ₪", "המחיר עשרים ותשעה שקלים ותשעים אגורות"),
        ("סך הכל 1,250.50 שקלים", "סך הכל אלף ומאתיים וחמישים שקלים וחמישים אגורות"),
        ("המחיר 29.00 ₪", "המחיר עשרים ותשעה שקלים"),
        ("0,50 ₪", "חמישים אגורות"),
        ("1,250,000 ₪", "מיליון ומאתיים וחמישים אלף שקלים"),
        ("12%", "שנים עשר אחוז"),
        ("הפגישה ב-16.09.2026", "הפגישה בשישה עשר בספטמבר אלפיים ועשרים ושישה"),
        ("ב-1/2/2026", "באחד בפברואר אלפיים ועשרים ושישה"),
    ],
)
async def test_filter_speaks_money_percent_and_numeric_dates(text, expected):
    assert await HebrewNormalizeFilter().filter(text) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["גרסה 1.2.3", "32.13.2026"])
async def test_filter_leaves_non_dates_and_non_money_intact(text):
    assert await HebrewNormalizeFilter().filter(text) == text
