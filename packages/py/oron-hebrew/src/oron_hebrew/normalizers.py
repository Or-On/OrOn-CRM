"""Deterministic Hebrew TTS normalizers (pure, tenant-agnostic).

Ported from Jpost hebrew_refiner.py — each rule encodes a real production bug —
plus a NEW shekel/agorot rule (pipecat expand_currency is USD-only). These are
the rules TTS gets wrong no matter what the LLM writes: symbols and digits it
voices literally. These are enforced here rather than asked for in a prompt,
because a deterministic rewrite does not depend on the model complying.
Wrapped as a BaseTextFilter in Task 4. Order (normalize_for_tts): time-ranges ->
digit-join -> hour-context -> address -> currency. Niqqud (vocalize) runs AFTER,
in the Task 5 transformer.
"""

from __future__ import annotations

import re
import unicodedata

from oron_hebrew.numbers import feminine_hour_minute, hebrew_number, number_to_hebrew

# --- Single clock times: "בשעה 10:00" -> "בשעה עשר". This must run before
#     hour-context and generic digit conversion; otherwise the hour becomes
#     Hebrew while the minutes survive as ":אפס", which Soniox voices
#     unnaturally. ---
_CLOCK_TIME_RE = re.compile(r"\b(שעה|השעה|בשעה)\s+([01]?\d|2[0-3]):([0-5]\d)\b")


def normalize_clock_times(text: str) -> str:
    def _sub(match: re.Match[str]) -> str:
        prefix = match.group(1)
        hour = feminine_hour_minute(int(match.group(2)))
        minute = int(match.group(3))
        if minute == 0:
            return f"{prefix} {hour}"
        if minute == 15:
            return f"{prefix} {hour} ורבע"
        if minute == 30:
            return f"{prefix} {hour} וחצי"
        return f"{prefix} {hour} ו{feminine_hour_minute(minute)}"

    return _CLOCK_TIME_RE.sub(_sub, text)


# --- Long numeric identities: telephone and identity numbers are identifiers,
#     not quantities. Reading them digit by digit also protects their internal
#     hyphens from the clock-range normalizer below. ---
_LONG_IDENTIFIER_RE = re.compile(r"(?<!\d)(?:\+\s*)?\d(?:[\s\-–]?\d){8,14}(?!\d)")
_DIGIT_NAMES = {
    "0": "אפס",
    "1": "אחת",
    "2": "שתיים",
    "3": "שלוש",
    "4": "ארבע",
    "5": "חמש",
    "6": "שש",
    "7": "שבע",
    "8": "שמונה",
    "9": "תשע",
}


def normalize_long_identifiers(text: str) -> str:
    def _sub(match: re.Match[str]) -> str:
        value = match.group(0)
        prefix = "פלוס " if value.lstrip().startswith("+") else ""
        return prefix + " ".join(_DIGIT_NAMES[digit] for digit in value if digit.isdigit())

    return _LONG_IDENTIFIER_RE.sub(_sub, text)


# --- Time ranges: only an actual clock expression or an explicitly labelled
#     bare-hour range becomes "עד". The former generic H-H matcher corrupted
#     telephone numbers such as 52-1234567 into "חמישים ושניים עד...". ---
_CLOCK_TIME_RANGE_RE = re.compile(
    r"(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)\s*[-–]\s*"
    r"([01]?\d|2[0-3]):([0-5]\d)(?![\d:])"
)
_BARE_TIME_RANGE_RE = re.compile(
    r"\b((?:בין\s+השעות?|בשעות?|מהשעה|משעה)\s+)(\d{1,2})\s*[-–]\s*(\d{1,2})\b"
)


def normalize_time_ranges(text: str) -> str:
    def endpoint(hour: str, minutes: str) -> str:
        if minutes == "00":
            return hour
        return normalize_clock_times(f"שעה {hour}:{minutes}").removeprefix("שעה ")

    text = _CLOCK_TIME_RANGE_RE.sub(
        lambda match: (
            f"{endpoint(match.group(1), match.group(2))} עד "
            f"{endpoint(match.group(3), match.group(4))}"
        ),
        text,
    )
    return _BARE_TIME_RANGE_RE.sub(r"\1\2 עד \3", text)


# --- Split digits: Google Hebrew TTS emits "דירה 1 1"; join back to "11" ---
_SPLIT_DIGITS_RE = re.compile(r"(?<=\d) (?=\d)")
_LABELLED_SPLIT_DIGITS_RE = re.compile(
    r"(\b(?:דירה|בית|רחוב\s+[^\d,\n]{1,60})\s+)(\d(?: \d){1,3})(?!\d)(?! \d)"
)


def join_split_digits(text: str) -> str:
    # Recognition spacing is not evidence that two quantities form one number.
    # Retain the legacy address repair only where the field label is explicit.
    return _LABELLED_SPLIT_DIGITS_RE.sub(
        lambda match: match.group(1) + _SPLIT_DIGITS_RE.sub("", match.group(2)), text
    )


# --- Hour context: "שעה"/"השעה"/"בשעה" + digit -> feminine cardinal (hours are
#     grammatically feminine in Hebrew: "השעה שלוש", not "השעה שלושה"). ---
_HOUR_DIGIT_RE = re.compile(r"\b(שעה|השעה|בשעה)\s+(\d{1,2})\b")


def normalize_hour_digits(text: str) -> str:
    def _sub(m: re.Match) -> str:
        return f"{m.group(1)} {feminine_hour_minute(int(m.group(2)))}"

    return _HOUR_DIGIT_RE.sub(_sub, text)


# --- Prefixed clock times: "ל-3 בצהריים" -> "לשלוש בצהריים". Hours are feminine
#     here too, and the prefix binds to the word, so the hyphen goes with it —
#     left in place TTS reads it as "מינוס". A time-of-day word is required: "ב-5
#     שקלים" is a count, and masculine is right for it. ---
_TIME_OF_DAY = 'בבוקר|בצהריים|אחר הצהריים|אחה"צ|בערב|בלילה'
_PREFIXED_HOUR_RE = re.compile(rf"\b([לבמ])-\s*(\d{{1,2}})(?=\s+(?:{_TIME_OF_DAY})\b)")


def normalize_prefixed_hours(text: str) -> str:
    def _sub(m: re.Match) -> str:
        return f"{m.group(1)}{feminine_hour_minute(int(m.group(2)))}"

    return _PREFIXED_HOUR_RE.sub(_sub, text)


# --- Address numbers: "רחוב X 5" -> masculine cardinal (street numbers are
#     grammatically masculine). Feminine-noun agreement is a prompt rule. ---
_STREET_DIGIT_RE = re.compile(r"(\bרחוב\s+[^\d,\n]+?)\s+(\d+)(?![\d.,/-])")


def normalize_address_numbers(text: str) -> str:
    def _sub_street(m: re.Match) -> str:
        prefix = m.group(1).rstrip()
        try:
            digit = int(m.group(2))
            return f"{prefix} {hebrew_number(digit, gender='masculine')}"
        except ValueError:
            return m.group(0)

    return _STREET_DIGIT_RE.sub(_sub_street, text)


# --- Currency (NEW): shekel/agorot readback, ILS only. "50 ₪"->"50 שקלים";
#     "1 ₪"->"שקל אחד"; "19.90 ₪"->"19 שקלים ו90 אגורות". Symbol -> words; the
#     spoken digits are left for the number filter / TTS to read in Hebrew. ---
#     Models write the abbreviation with a typographic gershayim (ש״ח) as often
#     as with an ASCII quote, put ₪ before the amount as often as after, and
#     sometimes use a decimal comma ("29,90") — every form must read as money,
#     never as "twenty-nine point nine zero". A comma followed by exactly one or
#     two digits cannot be a thousands separator, so it is only a decimal here.
_AMOUNT = (
    r"([+-]?)(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?"
    r"|(\d+),(\d{1,2}))(?![\d.,]*\d)"
)
_SHEKEL_WORD = r'(?:₪|ש["״]ח|שח|שקלים)'
_CURRENCY_RE = re.compile(rf"(?<![\d.,]){_AMOUNT}\s*{_SHEKEL_WORD}(?![א-ת\d])")
_PREFIX_CURRENCY_RE = re.compile(rf"₪\s*{_AMOUNT}(?![\d.,]?\d)")


def _shekel_words(whole: int) -> str:
    return "שקל אחד" if whole == 1 else f"{whole} שקלים"


def _agorot_words(frac: str) -> str:
    n = int(frac.ljust(2, "0"))  # "9" -> 90 agorot
    return "אגורה אחת" if n == 1 else f"{feminine_hour_minute(n)} אגורות"


def _currency_words(m: re.Match) -> str:
    sign_text, grouped, dot_fraction, comma_whole, comma_fraction = m.groups()
    whole = (grouped or comma_whole).replace(",", "")
    fraction = dot_fraction or comma_fraction
    if len(whole) > 15:
        return m.group(0)
    sign = {"-": "מינוס ", "+": "פלוס ", "": ""}[sign_text]
    shekels = _shekel_words(int(whole))
    if fraction and int(fraction):
        if not int(whole):
            return sign + _agorot_words(fraction)  # "0.50 ₪" is fifty agorot
        return f"{sign}{shekels} ו{_agorot_words(fraction)}"
    return sign + shekels


def normalize_currency(text: str) -> str:
    text = _PREFIX_CURRENCY_RE.sub(_currency_words, text)
    return _CURRENCY_RE.sub(_currency_words, text)


# --- Percent: "12%" -> "12 אחוז". The sign is not a letter TTS can voice, and
#     the number filter would otherwise leave "שנים עשר%". ---
_PERCENT_RE = re.compile(r"(\d)\s*%")


def normalize_percent(text: str) -> str:
    return _PERCENT_RE.sub(r"\1 אחוז", text)


# --- Numeric dates: Israeli day-first "16.09.2026" / "16/09/2026" -> "16
#     בספטמבר 2026". Left numeric, the generic number filter refuses to guess
#     and TTS reads the digits and separators literally. Only real calendar
#     dates are rewritten; anything else stays intact for other readback. ---
_HEBREW_MONTHS = (
    "בינואר",
    "בפברואר",
    "במרץ",
    "באפריל",
    "במאי",
    "ביוני",
    "ביולי",
    "באוגוסט",
    "בספטמבר",
    "באוקטובר",
    "בנובמבר",
    "בדצמבר",
)
_NUMERIC_DATE_RE = re.compile(
    r"(?<![\d.,/])(\d{1,2})([./])(\d{1,2})\2((?:19|20)\d{2})(?![\d/]|\.\d)"
)


def normalize_numeric_dates(text: str) -> str:
    def _sub(m: re.Match) -> str:
        day, month, year = int(m.group(1)), int(m.group(3)), m.group(4)
        if not (1 <= day <= 31 and 1 <= month <= 12):
            return m.group(0)
        return f"{day} {_HEBREW_MONTHS[month - 1]} {year}"

    return _NUMERIC_DATE_RE.sub(_sub, text)


_NUMBER_TOKEN_RE = re.compile(r"(?<!\w)[+-]?\d+(?:[.,:/-]\d+)*(?!\w)")
_DECIMAL_TOKEN_RE = re.compile(r"([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?")


def normalize_number_tokens(text: str) -> str:
    """Speak complete numeric tokens without reinterpreting dates or IDs.

    A decimal's fractional digits remain digits (0.05 is not 0.5). Ambiguous
    dates and invalid grouped numbers are passed intact for specific readback
    validation instead of independently converting their components.
    """

    def replace(match: re.Match[str]) -> str:
        token = match.group()
        numeric = _DECIMAL_TOKEN_RE.fullmatch(token)
        if numeric is None:
            return token
        sign, whole, fraction = numeric.groups()
        digits = whole.replace(",", "")
        if len(digits) > 15:
            return token
        prefix = {"-": "מינוס ", "+": "פלוס ", "": ""}[sign]
        spoken = (
            " ".join(_DIGIT_NAMES[digit] for digit in digits)
            if len(digits) > 1 and digits.startswith("0")
            else number_to_hebrew(int(digits))
        )
        if fraction is not None:
            spoken += " נקודה " + " ".join(_DIGIT_NAMES[digit] for digit in fraction)
        return prefix + spoken

    return _NUMBER_TOKEN_RE.sub(replace, text)


# Categories, not an emoji list: an enumerated pattern goes stale every Unicode
# release. So = pictographs, Sk = modifiers (skin tones), joiners compose them.
_UNSPOKEN_CATEGORIES = frozenset({"So", "Sk"})
_EMOJI_JOINERS = frozenset({"\ufe0f", "\u200d"})


def strip_unspoken_symbols(text: str) -> str:
    """Drop characters TTS cannot voice.

    A model told to avoid emoji emits them anyway, so the prompt cannot own this.
    Runs after the currency rule, so ₪ is already a word.
    """
    return "".join(
        c
        for c in text
        if unicodedata.category(c) not in _UNSPOKEN_CATEGORIES and c not in _EMOJI_JOINERS
    )


def normalize_for_tts(text: str) -> str:
    """Run all deterministic normalizers in the fixed, order-sensitive sequence.
    Niqqud is applied AFTER this by the Task 5 transformer."""
    text = normalize_numeric_dates(text)
    text = normalize_long_identifiers(text)
    text = normalize_time_ranges(text)
    text = normalize_clock_times(text)
    text = join_split_digits(text)
    text = normalize_hour_digits(text)
    text = normalize_prefixed_hours(text)
    text = normalize_address_numbers(text)
    text = normalize_currency(text)
    text = normalize_percent(text)
    return strip_unspoken_symbols(text)
