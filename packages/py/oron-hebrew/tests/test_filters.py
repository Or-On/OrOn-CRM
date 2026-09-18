import pytest
from oron_hebrew.filters import HebrewNormalizeFilter


@pytest.mark.asyncio
async def test_filter_applies_normalizers_and_number_words():
    f = HebrewNormalizeFilter()
    out = await f.filter("ברחוב שקד 9 בשעה 12")
    assert "רחוב שקד תשעה" in out  # street masculine
    assert "שתים עשרה" in out  # hour feminine


@pytest.mark.asyncio
async def test_filter_converts_standalone_digits_to_words():
    assert await HebrewNormalizeFilter().filter("הקוד הוא 3") == "הקוד הוא שלושה"


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["יש לך 3 אפשרויות.", "יש 3 פריטים", "נשארו 2 דקות"])
async def test_counted_nouns_keep_digits_instead_of_a_guessed_gender(text):
    # Recorded defect: the fixed masculine reading produced "שלושה אפשרויות"
    # and "שניים דקות". Nothing here knows a noun's gender.
    assert await HebrewNormalizeFilter().filter(text) == text


@pytest.mark.asyncio
async def test_filter_is_reentrant_no_niqqud_added():
    # The filter must NOT add niqqud (that is the Task 5 transform's job).
    f = HebrewNormalizeFilter()
    out = await f.filter("שלום")
    assert out == "שלום"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text",
    ["נשמח לעזור.", "תודה רבה...", "באמת?", "א.ב נשאר", "שלום, כאן נועה. במה אפשר לעזור?"],
)
async def test_filter_keeps_sentence_punctuation(text):
    # Measured 2026-09-18 on Soniox tts-rt-v2: a kept final stop was not voiced
    # and preserved the pause between sentences; stripping it ran them together.
    assert await HebrewNormalizeFilter().filter(text) == text


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
    "text",
    [
        # Each was rewritten before 2026-09-18 into a different statement.
        "סליחה רבה על הטעות! תודה שתיקנת אותי.",
        "אני מבינה שהראוטר לא עובד מאז אתמול.",
        "אני מבינה שניסית כבר כמה דברים. האם תוכל למסור מספר לקוח?",
        "אוקיי, אני מבינה. כדי שאוכל לעזור לך, אצטרך כמה פרטים.",
        "המסבר שלך מופיע אצלנו.",
    ],
)
async def test_filter_never_rewrites_wording(text):
    assert await HebrewNormalizeFilter(lambda: "male").filter(text) == text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("gender", "text"),
    [
        ("male", "קיבלתי את מספר הטלפון. האם את מוכנה להמשיך?"),
        ("female", "תוכל לומר אם אתה מוכן להמשיך?"),
        ("male", 'היא אמרה "תוכלי להמשיך". תוכל להמשיך?'),
    ],
)
async def test_caller_address_is_owned_by_the_model_instruction_not_rewritten(gender, text):
    # Address form reaches the model as CALLER ADDRESS UPDATE. Rewriting speech
    # made the caller hear something other than the remembered assistant turn.
    assert await HebrewNormalizeFilter(lambda: gender).filter(text) == text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "chunk",
    ["כדי לבדוק כמה זה עולה,", "תודה שעדכנת אותי איך אוכל לעזור לך היום", "למה לא עובד לך"],
)
async def test_streamed_clause_punctuation_is_not_inferred(chunk):
    # The planner streams clauses; inference turned "…עולה," into "…עולה,?".
    assert await HebrewNormalizeFilter().filter(chunk) == chunk


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text", ["בדוק את כבל HDMI ואז אשלח WhatsApp.", "ה-Wi-Fi עובד אבל אין תמונה"]
)
async def test_technical_english_terms_are_left_for_the_voice(text):
    # Measured: Soniox voiced plain "HDMI" inside Hebrew correctly. Tenant
    # pronunciations remain configurable per profile.
    assert await HebrewNormalizeFilter().filter(text) == text


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
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("הטכנאי מגיע בין השעות 8-12.", "הטכנאי מגיע בין השעות שמונה עד שתים עשרה."),
        ("פתוח 10:00-12:30", "פתוח עשר עד שתים עשרה וחצי"),
    ],
)
async def test_hour_ranges_are_feminine(text, expected):
    assert await HebrewNormalizeFilter().filter(text) == expected


@pytest.mark.asyncio
async def test_filter_attaches_written_hebrew_date_prefix_after_number_expansion():
    assert await HebrewNormalizeFilter().filter("ה-17 בספטמבר") == "השבעה עשר בספטמבר"


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
        ("משלם 2 שקלים לדקה", "משלם שני שקלים לדקה"),
        ("2.02 ₪", "שני שקלים ושתי אגורות"),
        ("12%", "שנים עשר אחוז"),
        ("הנחה של 2%", "הנחה של שני אחוז"),
        ("הפגישה ב-16.09.2026", "הפגישה בשישה עשר בספטמבר אלפיים עשרים ושש"),
        ("ב-1/2/2026", "באחד בפברואר אלפיים עשרים ושש"),
        ("נולד ב-3.4.1999", "נולד בשלושה באפריל אלף תשע מאות תשעים ותשע"),
    ],
)
async def test_filter_speaks_money_percent_and_numeric_dates(text, expected):
    assert await HebrewNormalizeFilter().filter(text) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["גרסה 1.2.3", "32.13.2026"])
async def test_filter_leaves_non_dates_and_non_money_intact(text):
    assert await HebrewNormalizeFilter().filter(text) == text
