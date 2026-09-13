"""Pipecat BaseTextFilter wrapping the deterministic Hebrew normalizers.

Runs FIRST in the TTS service (text_filters run before text_transforms —
verified against pipecat 1.5.0 TTSService._process_text_frame), producing clean
spelled Hebrew for the pre-spoken AggregatedTextFrame. Adds NO niqqud — that is
the Task 5 transform (vendor-text only). Stateless — the rules it applies are
tenant-agnostic TTS fixes, not configurable values."""

from __future__ import annotations

import re
from collections.abc import Callable

from loguru import logger
from pipecat.utils.text.base_text_filter import BaseTextFilter

from oron_hebrew.normalizers import normalize_for_tts, normalize_number_tokens

_TRAILING_FULL_STOP_RE = re.compile(r"[.。]+(?=\s*$)")
_UNRESOLVED_PLACEHOLDER_RE = re.compile(
    r"\[[^\]\r\n]{1,80}\]|\{\{[^}\r\n]{1,80}\}\}|\$\{[^}\r\n]{1,80}\}"
)
_HEBREW_RE = re.compile(r"[א-ת]")
_UNNATURAL_APOLOGY_RE = re.compile(r"סליחה רבה(?:\s+על\s+הטעות)?")
_HEBREW_PREFIX_HYPHEN_RE = re.compile(r"\b([בלמהו])[-־]\s*([א-ת])")
_COMMON_SPOKEN_CORRECTIONS = {
    "המסבר": "המספר",
    "מסבר": "מספר",
}
_LATIN_SPOKEN_TERMS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?<![A-Za-z])HDMI(?![A-Za-z])", re.IGNORECASE), "אֵייץ' דִּי אֶם אַיי"),
    (re.compile(r"(?<![A-Za-z])WhatsApp(?![A-Za-z])", re.IGNORECASE), "ווטסאפ"),
)
_DIRECT_QUESTION_RE = re.compile(
    r"\b(?:רציתי\s+(?:לשאול|לברר)\s+(?:אם|האם)|"
    r"האם|איך|מתי|איפה|מדוע|למה|כמה|מי|איזה|איזו|אילו|"
    r"אפשר|תוכל|תוכלי|תרצה|תרצי)\b"
)
_LEADING_SELF_REFERENCE_RE = re.compile(
    r"^(?:(?:אוקיי|בסדר)\s*[,;:.]?\s*)?"
    r"(?:אני\s+מבינה|אני\s+מבין)"
    r"(?:\s+ש|\s*[,;:.]\s+|\s+(?=(?:כדי|בשביל|אז|אבל|לכן)\b))"
)
_EMBEDDED_QUESTION_PREFIX_RE = re.compile(
    r"(?:רוצה|רוצה\s+רק|צריך|צריכה|אצטרך|אצטרכי|מנסה)\s+"
    r"(?:לדעת|להבין|לברר|לשאול)$"
)
_MALE_DIRECT_FORMS = {
    "תוכלי": "תוכל",
    "תרצי": "תרצה",
    "תצטרכי": "תצטרך",
    "תדעי": "תדע",
    "תביני": "תבין",
    "תגידי": "תגיד",
    "תשלחי": "תשלח",
    "תאשרי": "תאשר",
}
_FEMALE_DIRECT_FORMS = {value: key for key, value in _MALE_DIRECT_FORMS.items()}
_QUOTED_SPEECH_RE = re.compile(r'("[^"\n]*"|“[^”\n]*”|«[^»\n]*»)')


def _replace_words(text: str, replacements: dict[str, str]) -> str:
    for source, target in replacements.items():
        text = re.sub(rf"(?<![א-ת]){source}(?![א-ת])", target, text)
    return text


def normalize_caller_address(text: str, gender: str | None) -> str:
    """Correct only unambiguous second-person forms at the spoken boundary.

    The standalone Hebrew ``את`` is also the direct-object marker and is never
    rewritten globally. Female first-person forms such as ``אני מבינה`` belong
    to the agent persona and are deliberately preserved.
    """

    if _QUOTED_SPEECH_RE.search(text):
        return "".join(
            part if index % 2 else normalize_caller_address(part, gender)
            for index, part in enumerate(_QUOTED_SPEECH_RE.split(text))
        )
    if gender == "male":
        text = _replace_words(text, _MALE_DIRECT_FORMS)
        text = re.sub(
            r"\bאת\s+(יכולה|צריכה|מוכנה|מעוניינת|בטוחה|יודעת)\b",
            lambda match: {
                "יכולה": "אתה יכול",
                "צריכה": "אתה צריך",
                "מוכנה": "אתה מוכן",
                "מעוניינת": "אתה מעוניין",
                "בטוחה": "אתה בטוח",
                "יודעת": "אתה יודע",
            }[match.group(1)],
            text,
        )
        return re.sub(r"\bהאם\s+את\b", "האם אתה", text)
    if gender == "female":
        text = _replace_words(text, _FEMALE_DIRECT_FORMS)
        text = re.sub(
            r"\bאתה\s+(יכול|צריך|מוכן|מעוניין|בטוח|יודע)\b",
            lambda match: {
                "יכול": "את יכולה",
                "צריך": "את צריכה",
                "מוכן": "את מוכנה",
                "מעוניין": "את מעוניינת",
                "בטוח": "את בטוחה",
                "יודע": "את יודעת",
            }[match.group(1)],
            text,
        )
        return re.sub(r"\bהאם\s+אתה\b", "האם את", text)
    return text


def normalize_question_boundary(text: str) -> str:
    """Separate a trailing direct question from a preceding spoken answer."""

    if not _HEBREW_RE.search(text):
        return text
    stripped = text.rstrip()
    question_is_explicit = stripped.endswith("?")
    # A terminal statement mark is deliberate. Only infer a missing question
    # mark when the model emitted no terminal punctuation at all.
    may_infer_question = not stripped.endswith((".", "!", "?", "…"))
    if not question_is_explicit and not may_infer_question:
        return text
    # Only inspect the final, not-yet-punctuated sentence. The complete turn is
    # intentionally passed through this function twice (once by the turn
    # planner and once by the final TTS filter). Looking back across an existing
    # sentence boundary made the second pass split ordinary phrases such as
    # "אצטרך כמה פרטים" and "לראות איך אפשר לעזור". It also made the operation
    # non-idempotent, which is unsafe at a spoken boundary.
    body = stripped[:-1].rstrip() if question_is_explicit else stripped
    last_boundary = max((body.rfind(mark) for mark in (".", "!", "?", "…")), default=-1)
    clause_start = last_boundary + 1
    while clause_start < len(text) and text[clause_start].isspace():
        clause_start += 1
    clause = text[clause_start:]
    candidates = [match for match in _DIRECT_QUESTION_RE.finditer(clause)]
    if candidates:
        opening_prefix = clause[: candidates[0].start()].strip(" ,;—–")
        # "תוך כמה זמן תרצה..." is already one question. Continuing to a later
        # candidate (``תרצה``) manufactured the broken boundary
        # "תוך כמה זמן. תרצה...". A cue appearing within the first two words
        # establishes the whole clause as interrogative.
        if len(opening_prefix.split()) <= 2:
            return f"{stripped}?" if may_infer_question else text
    for match in reversed(candidates):
        local_prefix = clause[: match.start()].rstrip(" ,;—–")
        if len(local_prefix.split()) < 3 or _EMBEDDED_QUESTION_PREFIX_RE.search(local_prefix):
            continue
        prefix = text[: clause_start + match.start()].rstrip(" ,;—–")
        question = text[clause_start + match.start() :].strip()
        if may_infer_question:
            question = f"{question}?"
        return f"{prefix}. {question}"
    if may_infer_question and candidates and candidates[0].start() == 0:
        return f"{stripped}?"
    return text


class HebrewNormalizeFilter(BaseTextFilter):
    def __init__(self, get_caller_gender: Callable[[], str | None] | None = None) -> None:
        self._get_caller_gender = get_caller_gender or (lambda: None)

    async def filter(self, text: str) -> str:
        if _UNRESOLVED_PLACEHOLDER_RE.search(text):
            # Never voice an implementation token to a customer. Replacing the
            # complete sentence is safer than deleting only "[name]", which
            # leaves a confident but nonsensical question behind. This filtered
            # text is also what Pipecat appends to assistant context.
            logger.warning("suppressed unresolved placeholder before TTS")
            return (
                "סליחה, חסר לי פרט כדי להמשיך. אפשר לומר לי אותו?"
                if _HEBREW_RE.search(text)
                else "Sorry, I need one detail before we continue. Could you tell me?"
            )
        # "סליחה רבה" is a literal translation rather than idiomatic Hebrew.
        # Keep a final spoken-boundary safeguard even though the persona prompt
        # also instructs the model to acknowledge corrections naturally.
        text = _UNNATURAL_APOLOGY_RE.sub("סליחה, טעיתי", text)
        text = _replace_words(text, _COMMON_SPOKEN_CORRECTIONS)
        for pattern, spoken in _LATIN_SPOKEN_TERMS:
            text = pattern.sub(spoken, text)
        # A generic self-referential acknowledgement delays the useful answer
        # and is often mistaken for the caller's address form. Remove it only
        # before unmistakable discourse continuations; preserve empathetic
        # phrases such as "אני מבינה אותך".
        text = _LEADING_SELF_REFERENCE_RE.sub("", text)
        text = normalize_caller_address(text, self._get_caller_gender())
        text = normalize_question_boundary(text)
        text = normalize_for_tts(text)
        # Soniox v2 occasionally voices a terminal dot as the English word
        # "period" after Hebrew. Strip only sentence-final full stops at the
        # spoken boundary; commas and question marks still carry useful prosody,
        # and decimal points inside a value are untouched.
        text = _TRAILING_FULL_STOP_RE.sub("", text)
        # Any digits the structural rules left behind read in Hebrew (masculine
        # default; the address/time rules already handled gendered contexts).
        text = normalize_number_tokens(text)
        # Written Hebrew often uses "ה-17". Once the digits have become words,
        # retaining that hyphen makes some voices announce punctuation or pause
        # mechanically. The spoken form is the attached prefix: "השבעה עשר".
        return _HEBREW_PREFIX_HYPHEN_RE.sub(r"\1\2", text)
