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

from oron_hebrew.numbers import feminine_hour_minute, hebrew_number

# --- Time ranges: "HH:MM-HH:MM" / "H-H" -> "H עד H" (hyphen would be "מינוס") ---
_TIME_RANGE_RE = re.compile(r"(\d{1,2})(?::\d{2})?\s*-\s*(\d{1,2})(?::\d{2})?")


def normalize_time_ranges(text: str) -> str:
    return _TIME_RANGE_RE.sub(r"\1 עד \2", text)


# --- Split digits: Google Hebrew TTS emits "דירה 1 1"; join back to "11" ---
_SPLIT_DIGITS_RE = re.compile(r"(?<=\d) (?=\d)")


def join_split_digits(text: str) -> str:
    return _SPLIT_DIGITS_RE.sub("", text)


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
_STREET_DIGIT_RE = re.compile(r"(\bרחוב\s+[^\d,\n]+?)\s+(\d+)")


def normalize_address_numbers(text: str) -> str:
    def _sub_street(m: re.Match) -> str:
        prefix, digit = m.group(1).rstrip(), int(m.group(2))
        try:
            return f"{prefix} {hebrew_number(digit, gender='masculine')}"
        except ValueError:
            return m.group(0)

    return _STREET_DIGIT_RE.sub(_sub_street, text)


# --- Currency (NEW): shekel/agorot readback, ILS only. "50 ₪"->"50 שקלים";
#     "1 ₪"->"שקל אחד"; "19.90 ₪"->"19 שקלים ו90 אגורות". Symbol -> words; the
#     spoken digits are left for the number filter / TTS to read in Hebrew. ---
_CURRENCY_RE = re.compile(r'(\d+)(?:\.(\d{1,2}))?\s*(?:₪|ש"ח|שח)')


def _shekel_words(whole: int) -> str:
    return "שקל אחד" if whole == 1 else f"{whole} שקלים"


def _agorot_words(frac: str) -> str:
    n = int(frac.ljust(2, "0"))  # "9" -> 90 agorot
    return "אגורה אחת" if n == 1 else f"{n} אגורות"


def normalize_currency(text: str) -> str:
    def _sub(m: re.Match) -> str:
        shekels = _shekel_words(int(m.group(1)))
        if m.group(2):
            return f"{shekels} ו{_agorot_words(m.group(2))}"
        return shekels

    return _CURRENCY_RE.sub(_sub, text)


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
    text = normalize_time_ranges(text)
    text = join_split_digits(text)
    text = normalize_hour_digits(text)
    text = normalize_prefixed_hours(text)
    text = normalize_address_numbers(text)
    text = normalize_currency(text)
    return strip_unspoken_symbols(text)
