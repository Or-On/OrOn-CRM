"""Hebrew number words + Dicta-verified number/time niqqud.

Two concerns, both pure:
1. Spelling: digits -> Hebrew words, gender-aware. `hebrew_number` (1-20, both
   genders; Jpost) is the small-range gendered check; `number_to_hebrew` (0-999999
   masculine) and `feminine_hour_minute` (0-59 feminine, hours/minutes) give full
   range (Light-AI). num2words(lang="he") is feminine-only, so we keep our tables.
2. Pointing: renikud_onnx.G2P.vocalize() mis-vocalizes spelled numbers/clock times
   (reads "שתים עשרה" as *shtaim*, "בשעה" as *ba*). NUMBER_NIQQUD holds Dicta-verified
   niqqud for that closed set; protect_numbers() swaps matches for non-Hebrew
   placeholders BEFORE vocalize (so the model never sees them) and restore_numbers()
   substitutes the correct niqqud back AFTER. Used by the niqqud transformer (Task 5).
"""

import re

# ---------------------------------------------------------------------------
# Gendered cardinals 1-20 (Jpost hebrew_style.py)
# ---------------------------------------------------------------------------

_MASC_NUMBER = {
    1: "אחד",
    2: "שניים",
    3: "שלושה",
    4: "ארבעה",
    5: "חמישה",
    6: "שישה",
    7: "שבעה",
    8: "שמונה",
    9: "תשעה",
    10: "עשרה",
    11: "אחד עשר",
    12: "שנים עשר",
    13: "שלושה עשר",
    14: "ארבעה עשר",
    15: "חמישה עשר",
    16: "שישה עשר",
    17: "שבעה עשר",
    18: "שמונה עשר",
    19: "תשעה עשר",
    20: "עשרים",
}


_FEM_NUMBER_FULL = {
    1: "אחת",
    2: "שתיים",
    3: "שלוש",
    4: "ארבע",
    5: "חמש",
    6: "שש",
    7: "שבע",
    8: "שמונה",
    9: "תשע",
    10: "עשר",
    11: "אחת עשרה",
    12: "שתים עשרה",
    13: "שלוש עשרה",
    14: "ארבע עשרה",
    15: "חמש עשרה",
    16: "שש עשרה",
    17: "שבע עשרה",
    18: "שמונה עשרה",
    19: "תשע עשרה",
    20: "עשרים",
}


def hebrew_number(n: int, *, gender: str = "masculine") -> str:
    """Return the spelled-out Hebrew cardinal for `n` in the given gender.

    Covers 1-20; raises for out-of-range values so callers notice when they
    need to extend the table rather than getting a silent fallback.
    """
    table = _FEM_NUMBER_FULL if gender == "feminine" else _MASC_NUMBER
    if n not in table:
        raise ValueError(f"hebrew_number: {n} not in 1-20 range for gender={gender}")
    return table[n]


# ---------------------------------------------------------------------------
# Full-range masculine (0-999,999) + feminine hour/minute (0-59) (Light-AI)
# ---------------------------------------------------------------------------

# Hebrew number words (masculine form, standard for general contexts)
_UNITS = ["", "אחד", "שניים", "שלושה", "ארבעה", "חמישה", "שישה", "שבעה", "שמונה", "תשעה"]
_TEENS = [
    "עשרה",
    "אחד עשר",
    "שנים עשר",
    "שלושה עשר",
    "ארבעה עשר",
    "חמישה עשר",
    "שישה עשר",
    "שבעה עשר",
    "שמונה עשר",
    "תשעה עשר",
]
_TENS = ["", "עשר", "עשרים", "שלושים", "ארבעים", "חמישים", "שישים", "שבעים", "שמונים", "תשעים"]
_HUNDREDS = [
    "",
    "מאה",
    "מאתיים",
    "שלוש מאות",
    "ארבע מאות",
    "חמש מאות",
    "שש מאות",
    "שבע מאות",
    "שמונה מאות",
    "תשע מאות",
]
_THOUSANDS = [
    "",
    "אלף",
    "אלפיים",
    "שלושת אלפים",
    "ארבעת אלפים",
    "חמשת אלפים",
    "ששת אלפים",
    "שבעת אלפים",
    "שמונת אלפים",
    "תשעת אלפים",
]


def number_to_hebrew(n: int) -> str:
    """Convert an integer (0-999,999) to Hebrew words."""
    if n == 0:
        return "אפס"
    if n < 0 or n >= 1_000_000:
        return str(n)

    parts = []

    # Thousands
    thousands = n // 1000
    if thousands > 0:
        if thousands <= 9:
            parts.append(_THOUSANDS[thousands])
        elif thousands <= 19:
            parts.append(_TEENS[thousands - 10] + " אלף")
        elif thousands >= 100:
            parts.append(number_to_hebrew(thousands) + " אלף")
        else:
            t_tens = thousands // 10
            t_units = thousands % 10
            t_part = _TENS[t_tens]
            if t_units:
                t_part += " ו" + _UNITS[t_units]
            parts.append(t_part + " אלף")
        n %= 1000

    # Hundreds
    hundreds = n // 100
    if hundreds > 0:
        parts.append(_HUNDREDS[hundreds])
        n %= 100

    # Tens and units
    if n >= 10 and n <= 19:
        parts.append(_TEENS[n - 10])
    elif n > 0:
        tens = n // 10
        units = n % 10
        if tens > 0 and units > 0:
            parts.append(_TENS[tens] + " ו" + _UNITS[units])
        elif tens > 0:
            parts.append(_TENS[tens])
        elif units > 0:
            parts.append(_UNITS[units])

    # Join with "ו" connector between parts
    if len(parts) == 1:
        return parts[0]
    # Connect each subsequent part with "ו"
    result = parts[0]
    for part in parts[1:]:
        result += " ו" + part
    return result


# Feminine number words, used when a digit refers to an hour or minute.
# Hours (שעה) and minutes (דקה) are grammatically feminine in Hebrew, so
# "2 בצהריים" must read as "שתיים בצהריים", not "שניים בצהריים".
_FEM_UNITS = ["", "אחת", "שתיים", "שלוש", "ארבע", "חמש", "שש", "שבע", "שמונה", "תשע"]
_FEM_TEENS = [
    "עשר",
    "אחת עשרה",
    "שתים עשרה",
    "שלוש עשרה",
    "ארבע עשרה",
    "חמש עשרה",
    "שש עשרה",
    "שבע עשרה",
    "שמונה עשרה",
    "תשע עשרה",
]
_FEM_TENS = ["", "עשר", "עשרים", "שלושים", "ארבעים", "חמישים", "שישים", "שבעים", "שמונים", "תשעים"]


def feminine_hour_minute(n: int) -> str:
    """Convert 0-99 to feminine Hebrew words (hours/minutes and agorot)."""
    if n == 0:
        return "אפס"
    if 1 <= n <= 9:
        return _FEM_UNITS[n]
    if 10 <= n <= 19:
        return _FEM_TEENS[n - 10]
    if 20 <= n <= 99:
        tens = n // 10
        units = n % 10
        if units == 0:
            return _FEM_TENS[tens]
        return _FEM_TENS[tens] + " ו" + _FEM_UNITS[units]
    return str(n)


# ---------------------------------------------------------------------------
# Static, Dicta-verified niqqud for Hebrew number / time words (Jpost
# hebrew_numbers.py).
#
# The renikud model (repurposed for niqqud) mis-vocalizes spelled-out numbers and
# clock times — e.g. it reads "שתים עשרה" as *shtaim* instead of the construct
# *shtem*, and "בשעה" as *ba* instead of *be*. Numbers are a small closed set, so
# we override them with correct forms generated ONCE by the Dicta diacritizer
# (`dictabert-large-char-menaked`) — no runtime Dicta dependency, no added latency.
#
# Used by `hebrew_niqqud`: the matched spans are swapped for placeholders before
# the model runs (so the model never sees them), then the correct niqqud is
# substituted back into the output.
# ---------------------------------------------------------------------------

# bare (unpointed) → correct niqqud. Multi-word teens and common prefixed forms
# are stored whole because their vocalization differs from the standalone words
# (e.g. שלוש → שָׁלוֹשׁ, but שלוש עשרה → שְׁלוֹשׁ עֶשְׂרֵה; and בשתים → בִּשְׁתֵּים).
NUMBER_NIQQUD: dict[str, str] = {
    # time words
    "שעה": "שָׁעָה",
    "השעה": "הַשָּׁעָה",
    "בשעה": "בְּשָׁעָה",
    "חצי": "חֲצִי",
    "רבע": "רֶבַע",
    "וחצי": "וָחֵצִי",
    "ורבע": "וְרֶבַע",
    # feminine cardinals 1–10 (hours / feminine nouns)
    "אחת": "אַחַת",
    "שתיים": "שְׁתַּיִם",
    "שתים": "שְׁתַּיִם",
    "שלוש": "שָׁלוֹשׁ",
    "ארבע": "אַרְבַּע",
    "חמש": "חָמֵשׁ",
    "שש": "שֵׁשׁ",
    "שבע": "שֶׁבַע",
    "שמונה": "שְׁמוֹנֶה",
    "תשע": "תֵּשַׁע",
    "עשר": "עֶשֶׂר",
    # teens 11–19 (feminine, construct)
    "אחת עשרה": "אַחַת עֶשְׂרֵה",
    "שתים עשרה": "שְׁתֵּים עֶשְׂרֵה",
    "שתיים עשרה": "שְׁתֵּים עֶשְׂרֵה",
    "שלוש עשרה": "שְׁלוֹשׁ עֶשְׂרֵה",
    "ארבע עשרה": "אַרְבַּע עֶשְׂרֵה",
    "חמש עשרה": "חֲמֵשׁ עֶשְׂרֵה",
    "שש עשרה": "שֵׁשׁ עֶשְׂרֵה",
    "שבע עשרה": "שְׁבַע עֶשְׂרֵה",
    "שמונה עשרה": "שְׁמוֹנֶה עֶשְׂרֵה",
    "תשע עשרה": "תְּשַׁע עֶשְׂרֵה",
    # tens
    "עשרים": "עֶשְׂרִים",
    "שלושים": "שְׁלוֹשִׁים",
    "ארבעים": "אַרְבָּעִים",
    "חמישים": "חֲמִישִׁים",
    # common prefixed forms (prefix niqqud varies with the following letter)
    "בשלוש": "בְּשָׁלוֹשׁ",
    "בשתים עשרה": "בִּשְׁתֵּים עֶשְׂרֵה",
    "בשתיים עשרה": "בִּשְׁתֵּים עֶשְׂרֵה",
    # ו- (and) prefixed — common in compound numbers ("עשרים ושתיים")
    "ואחת": "וְאַחַת",
    "ושתיים": "וּשְׁתַּיִם",
    "ושתים": "וּשְׁתַּיִם",
    "ושלוש": "וְשָׁלוֹשׁ",
    "וארבע": "וְאַרְבַּע",
    "וחמש": "וְחָמֵשׁ",
    "ושש": "וְשֵׁשׁ",
    "ושבע": "וְשֶׁבַע",
    "ושמונה": "וּשְׁמוֹנֶה",
    "ותשע": "וְתֵּשַׁע",
    "ועשר": "וְעֶשֶׂר",
    "ואחת עשרה": "וְאַחַת עֶשְׂרֵה",
    "ושתים עשרה": "וּשְׁתֵּים עֶשְׂרֵה",
    "ושתיים עשרה": "וּשְׁתֵּים עֶשְׂרֵה",
    "ושלוש עשרה": "וּשְׁלוֹשׁ עֶשְׂרֵה",
    "ועשרים": "וַעֶשְׂרִים",
    "ושלושים": "וּשְׁלוֹשִׁים",
    # ל- (to/at) prefixed — clock times ("נפגש לשלוש")
    "לאחת": "לְאַחַת",
    "לשתיים": "לִשְׁתַּיִם",
    "לשתים": "לִשְׁתַּיִם",
    "לשלוש": "לְשָׁלוֹשׁ",
    "לארבע": "לְאַרְבַּע",
    "לחמש": "לְחָמֵשׁ",
    "לשש": "לְשֵׁשׁ",
    "לשבע": "לְשֶׁבַע",
    "לשמונה": "לִשְׁמוֹנֶה",
    "לתשע": "לְתֵשַׁע",
    "לעשר": "לְעֶשֶׂר",
    "לאחת עשרה": "לְאַחַת עֶשְׂרֵה",
    "לשתים עשרה": "לִשְׁתֵּים עֶשְׂרֵה",
    "לשתיים עשרה": "לִשְׁתֵּים עֶשְׂרֵה",
    "לשלוש עשרה": "לִשְׁלוֹשׁ עֶשְׂרֵה",
    "לעשרים": "לְעֶשְׂרִים",
    "לשלושים": "לִשְׁלוֹשִׁים",
}

# Private-use placeholder wrappers — non-Hebrew, so the niqqud engine passes them
# through untouched and we can substitute the correct form back afterwards.
_PH_OPEN, _PH_CLOSE = "", ""

_HEB = r"א-ת"
# Longest key first so "בשתים עשרה" beats "שתים עשרה" beats "שתים"/"עשר".
# Spaces in multi-word keys match any run of whitespace. Hebrew-letter lookaround
# prevents partial hits ("עשר" inside "עשרים", "שלוש" inside "בשלוש").
_KEYS = sorted(NUMBER_NIQQUD, key=len, reverse=True)
_pattern = "|".join(re.escape(k).replace(r"\ ", r"\s+") for k in _KEYS)
_NUM_RE = re.compile(rf"(?<![{_HEB}])(?:{_pattern})(?![{_HEB}])")


def protect_numbers(text: str) -> tuple[str, dict[str, str]]:
    """Replace number/time words with placeholders.

    Returns (text_with_placeholders, {placeholder: correct_niqqud}). Whitespace
    inside matched phrases is normalized to a single space for dict lookup.
    """
    restore: dict[str, str] = {}
    n = 0

    def _sub(m: re.Match) -> str:
        nonlocal n
        key = re.sub(r"\s+", " ", m.group(0))
        ph = f"{_PH_OPEN}{n}{_PH_CLOSE}"
        restore[ph] = NUMBER_NIQQUD[key]
        n += 1
        return ph

    return _NUM_RE.sub(_sub, text), restore


def restore_numbers(text: str, restore: dict[str, str]) -> str:
    for ph, niqqud in restore.items():
        text = text.replace(ph, niqqud)
    return text
