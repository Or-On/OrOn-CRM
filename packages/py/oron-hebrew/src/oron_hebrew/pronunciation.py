"""Semantic constraints shared by published and retained speech dictionaries."""

import re
import unicodedata

_CRITICAL_WORDS = re.compile(
    r"(?:^|\W)(?:[ובכלמשה]{0,2})?(?:לא|אל|אין|בלי|אסור|מותר|כן|אתה|את|לך|שלך|זכר|נקבה|"
    r"אושר|אישר|שולם|שילמתי|נשלח|נקבע|בוצע|הנחה|מחיר|שקלים|שקל|אגורות|אחוז|"
    r"ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|"
    r"אפס|אחד|אחת|שניים|שתיים|שלוש|שלושה|ארבע|ארבעה|חמש|חמישה|"
    r"שש|שישה|שבע|שבעה|שמונה|תשע|תשעה|עשר|עשרה|חמישים|מאה|אלף|"
    r"no|not|never|without|approved|paid|sent|booked|confirmed|discount|price|"
    r"male|female|neutral|he|she|you)(?:$|\W)",
    re.IGNORECASE,
)


def _unpointed(value: str) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFD", value) if not unicodedata.combining(char)
    )


def is_safe_pronunciation_pair(original: str, spoken: str) -> bool:
    """Allow bounded lexical pronunciation, never critical-value substitution."""
    for value in (original, spoken):
        if (
            not value.strip()
            or len(value) > 80
            or any(char.isdigit() or unicodedata.category(char).startswith("C") for char in value)
            or re.search(r"[<>\[\]{}%₪$€£]", value)
            or _CRITICAL_WORDS.search(_unpointed(value))
        ):
            return False
    return not re.search(r"[א-ת]", original) or _unpointed(original) == _unpointed(spoken)
