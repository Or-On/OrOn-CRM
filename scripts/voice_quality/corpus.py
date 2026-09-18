"""The Hebrew material the voice stack is measured and regression-tested on.

Every line is synthetic and written for this file. No customer recording,
transcript or CRM value appears here, and none may be added: the corpus is
committed, and a real utterance committed once is committed forever.

Two kinds of case, because ordinary word error rate hides the failures that
actually hurt a support call:

``SpokenCase``
    What the model wrote and what the caller must end up hearing. ``must_keep``
    is checked literally against the text handed to the synthesizer, so a rule
    that changes an amount, a digit, a date or a negation fails here rather
    than on a call. ``must_lose`` names the characters a Hebrew voice would
    otherwise read out as symbols.

``TurnStream``
    A model turn split the way a streaming LLM actually emits it, used to
    measure where the TTS aggregator cuts. Boundaries matter: a cut inside a
    price, a phone number or a Hebrew-plus-English product name is heard as a
    stumble no matter how good the voice is.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class SpokenCase:
    """One authored utterance and the meaning its spoken form must preserve."""

    name: str
    category: str
    authored: str
    must_keep: tuple[str, ...] = ()
    must_lose: tuple[str, ...] = ()
    language: str = "he"


@dataclass(frozen=True)
class TurnStream:
    """One model turn as a streaming LLM emits it, plus the cuts that hurt."""

    name: str
    chunks: tuple[str, ...]
    # Substrings that must never be split across two synthesis segments.
    atomic: tuple[str, ...] = field(default_factory=tuple)


# --- Semantic-critical corpus -------------------------------------------------
# Grouped by the failure each one would produce on a live call.

SPOKEN_CORPUS: tuple[SpokenCase, ...] = (
    # Negation. A dropped or flipped negative reverses the answer.
    SpokenCase(
        name="negation_plain",
        category="negation",
        authored="לא, החבילה הזאת לא כוללת ערוצי ספורט.",
        must_keep=("לא, ", "לא כוללת"),
    ),
    SpokenCase(
        name="negation_with_amount",
        category="negation",
        authored="אין חיוב נוסף, זה לא עולה 50 ₪.",
        must_keep=("אין חיוב", "לא עולה", "חמישים שקלים"),
        must_lose=("₪",),
    ),
    SpokenCase(
        name="short_yes",
        category="short_answer",
        authored="כן.",
        must_keep=("כן",),
    ),
    SpokenCase(
        name="refusal_colloquial",
        category="negation",
        authored="הבנתי שאתם לא רוצים את השדרוג. אני מבטלת את הבקשה.",
        must_keep=("לא רוצים", "מבטלת"),
    ),
    # Money. Shekels and agorot are the values a caller will repeat back.
    SpokenCase(
        name="price_whole",
        category="money",
        authored="המחיר הוא 129 ₪ לחודש.",
        # "מאה ועשרים ותשעה", with the connective after the hundred, is how the
        # number is said out loud in Israel — compare "עד מאה ועשרים".
        must_keep=("מאה ועשרים ותשעה שקלים",),
        must_lose=("₪", "129"),
    ),
    SpokenCase(
        name="price_decimal",
        category="money",
        authored='העלות היא 19.90 ש"ח.',
        must_keep=("תשעה עשר שקלים", "תשעים אגורות"),
        must_lose=("19.90", '19.90 ש"ח'),
    ),
    SpokenCase(
        name="price_one_shekel",
        category="money",
        authored="ההפרש הוא 1 ₪ בלבד.",
        must_keep=("שקל אחד",),
        must_lose=("₪",),
    ),
    SpokenCase(
        name="price_prefix_symbol",
        category="money",
        authored="זיכוי של ₪45 יופיע בחשבונית.",
        must_keep=("ארבעים וחמישה שקלים",),
        must_lose=("₪",),
    ),
    # Percentages.
    SpokenCase(
        name="percent_discount",
        category="percent",
        authored="יש הנחה של 15% בשלושת החודשים הראשונים.",
        must_keep=("חמישה עשר אחוז",),
        must_lose=("%",),
    ),
    SpokenCase(
        name="percent_two",
        category="percent",
        authored="העלייה היא 2% בלבד.",
        must_keep=("שני אחוז",),
        must_lose=("%",),
    ),
    # Clock times. Hours are feminine in Hebrew.
    SpokenCase(
        name="clock_exact",
        category="time",
        authored="הטכנאי יגיע בשעה 14:00.",
        must_keep=("בשעה ארבע עשרה",),
        must_lose=("14:00",),
    ),
    SpokenCase(
        name="clock_half_past",
        category="time",
        authored="נתקשר בשעה 9:30.",
        must_keep=("בשעה תשע וחצי",),
        must_lose=("9:30",),
    ),
    SpokenCase(
        name="clock_range",
        category="time",
        authored="החלון הוא בין השעות 8 - 12.",
        must_keep=("שמונה עד שתים עשרה",),
    ),
    # Israeli day-first dates.
    SpokenCase(
        name="date_numeric",
        category="date",
        authored="הביקור נקבע ל-16.09.2026.",
        must_keep=("שישה עשר", "בספטמבר", "אלפיים עשרים ושש"),
        must_lose=("16.09.2026",),
    ),
    SpokenCase(
        name="date_day_of_month",
        category="date",
        authored="זה יקרה ב-17 בספטמבר.",
        must_keep=("שבעה עשר", "בספטמבר"),
    ),
    # Identifiers. Read digit by digit, never as a quantity.
    SpokenCase(
        name="phone_number",
        category="identifier",
        authored="המספר שרשום אצלנו הוא 052-1234567.",
        must_keep=("אפס חמש שתיים אחת שתיים שלוש ארבע חמש שש שבע",),
        must_lose=("052-1234567",),
    ),
    SpokenCase(
        name="identity_number",
        category="identifier",
        authored="תעודת הזהות שמסרתם היא 123456782.",
        must_keep=("אחת שתיים שלוש ארבע חמש שש שבע שמונה שתיים",),
        must_lose=("123456782",),
    ),
    # Addresses. Street numbers are masculine.
    SpokenCase(
        name="street_number",
        category="address",
        authored="הכתובת היא רחוב הרצל 9, תל אביב.",
        must_keep=("רחוב הרצל תשעה",),
    ),
    SpokenCase(
        name="apartment_number",
        category="address",
        # The label carries a preposition, which is how anyone writes it. The
        # digits must rejoin into one number: split, they were voiced as two
        # different readings of "1" — "דירה אחד 1". The joined number stays a
        # numeral because it counts a noun, which the voice reads in Hebrew.
        authored="זה בדירה 1 1 בקומה השנייה.",
        must_keep=("בדירה 11",),
        must_lose=("אחד 1",),
    ),
    # Hebrew with English product and technical terms, which Israeli speakers
    # genuinely code-switch on. The English must survive unchanged.
    SpokenCase(
        name="mixed_router",
        category="mixed_language",
        authored="צריך לאתחל את ה-router ולבדוק את חיבור ה-Wi-Fi.",
        must_keep=("router", "Wi-Fi"),
    ),
    SpokenCase(
        name="mixed_hdmi",
        category="mixed_language",
        authored="חברו את כבל ה-HDMI ליציאה HDMI 2 בטלוויזיה.",
        must_keep=("HDMI",),
    ),
    SpokenCase(
        name="mixed_error_text",
        category="mixed_language",
        authored="הממיר מציג connection timeout. ניסיתם restart?",
        must_keep=("connection timeout", "restart", "?"),
    ),
    SpokenCase(
        name="model_number",
        category="mixed_language",
        authored="הדגם הוא TX-500 והקושחה היא גרסה 4.",
        must_keep=("TX-500",),
    ),
    # Names, which a pronunciation dictionary may later touch but normalization
    # must not.
    SpokenCase(
        name="israeli_names",
        category="name",
        authored="דיברתי עם דנה כהן ועם יוסי מזרחי מהצוות.",
        must_keep=("דנה כהן", "יוסי מזרחי"),
    ),
    # Several numbers in one sentence, each with a different reading.
    SpokenCase(
        name="multiple_numbers",
        category="dense_numeric",
        authored="ב-17 בספטמבר בשעה 10:00 יגיע טכנאי לרחוב שקד 3, ותשלמו 99 ₪.",
        must_keep=(
            "שבעה עשר",
            "בשעה עשר",
            "רחוב שקד שלושה",
            "תשעים ותשעה שקלים",
        ),
        must_lose=("₪", "10:00"),
    ),
    # Punctuation carries prosody and must survive to the synthesizer.
    SpokenCase(
        name="question_mark_kept",
        category="punctuation",
        authored="בדקתם את החיבור בצד השני?",
        must_keep=("?",),
    ),
    SpokenCase(
        name="terminal_stop_kept",
        category="punctuation",
        authored="החבילה כוללת אינטרנט וטלוויזיה.",
        must_keep=(".",),
    ),
    SpokenCase(
        name="internal_comma_kept",
        category="punctuation",
        authored="אפשר לשדרג, אבל זה ייכנס לתוקף רק בחודש הבא.",
        must_keep=(",",),
    ),
    # Emoji cannot be voiced; the wording around them must be untouched.
    SpokenCase(
        name="emoji_dropped",
        category="unspoken_symbol",
        authored="מעולה 👍 סידרתי את זה.",
        must_keep=("מעולה", "סידרתי את זה"),
        must_lose=("👍",),
    ),
    # English turns must not be pushed through the Hebrew number rules.
    SpokenCase(
        name="english_amount_untouched",
        category="english",
        authored="The amount is 150.05 and the visit is on 16.09.2026.",
        must_keep=("150.05", "16.09.2026"),
        language="en",
    ),
)


# --- Aggregation streams ------------------------------------------------------
# Chunk shapes follow how a streaming model actually emits Hebrew: whole words
# or short fragments, punctuation arriving attached to the preceding token.

TURN_STREAMS: tuple[TurnStream, ...] = (
    TurnStream(
        name="opener_then_question",
        chunks=(
            "שלום",
            ", ",
            "כאן ",
            "השירות ",
            "של ",
            "קו אור",
            ". ",
            "במה ",
            "אפשר ",
            "לעזור",
            "?",
        ),
    ),
    TurnStream(
        name="price_answer",
        chunks=(
            "בשמחה",
            ", ",
            "החבילה ",
            "הזאת ",
            "עולה ",
            "129",
            " ",
            "₪",
            " לחודש",
            ", ",
            "כולל ",
            "הכול",
            ".",
        ),
        atomic=("129 ₪",),
    ),
    TurnStream(
        name="appointment_with_numbers",
        chunks=(
            "אז ",
            "קבעתי ",
            "ל-",
            "17",
            " בספטמבר",
            " בשעה ",
            "10:00",
            ". ",
            "הטכנאי ",
            "יגיע ",
            "לרחוב ",
            "שקד ",
            "3",
            ".",
        ),
        atomic=("10:00", "17 בספטמבר"),
    ),
    TurnStream(
        name="mixed_language_troubleshooting",
        chunks=(
            "קודם ",
            "כול ",
            "נאתחל ",
            "את ה-",
            "router",
            ", ",
            "ואז ",
            "נבדוק ",
            "את ",
            "חיבור ",
            "ה-",
            "Wi-Fi",
            " שלכם",
            ".",
        ),
        atomic=("router", "Wi-Fi"),
    ),
    TurnStream(
        name="short_confirmation",
        chunks=("כן", ", ", "בהחלט", "."),
    ),
    TurnStream(
        name="phone_readback",
        chunks=(
            "המספר ",
            "שרשום ",
            "אצלנו ",
            "הוא ",
            "052-1234567",
            ", ",
            "נכון",
            "?",
        ),
        atomic=("052-1234567",),
    ),
)
