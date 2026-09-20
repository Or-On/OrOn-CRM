"""Fail-closed safeguards at the final spoken boundary.

These checks cover security-sensitive system claims and TTS control markup.
They never classify ordinary conversation or decide whether a caller's message
is support-related.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from loguru import logger
from pipecat.utils.text.base_text_filter import BaseTextFilter

_UNVERIFIED_BUSINESS_CLAIM_RE = re.compile(
    r"(?:"
    r"מצאתי\s+את\s+פרטי\s+המנוי|"
    r"בדקתי\s+(?:ב?מערכת|את\s+המערכת)|"
    r"אני\s+רואה\s+ש(?:המנוי|הממיר|החשבון)|"
    r"(?:תיאמתי|קבעתי)\s+[^.?!]{0,60}(?:טכנאי|פגישה|תור)|"
    r"(?:שלחתי|אשלח)\s+[^.?!]{0,60}(?:ווטסאפ|וואטסאפ|WhatsApp)|"
    r"הטכנאי\s+יגיע|"
    r"\b(?:i|we)\s+(?:(?:have|just)\s+)?(?:checked|found|opened|created|scheduled|booked|confirmed|"
    r"refunded|processed|sent)\b[^.?!]{0,80}\b(?:account|subscriber|"
    r"appointment|technician|refund|payment|whatsapp|message)\b|"
    r"\b(?:your\s+)?(?:appointment|technician|refund|payment|booking)"
    r"\s+(?:is|has\s+been)\s+(?:confirmed|scheduled|booked|"
    r"approved|processed|on\s+the\s+way)\b"
    r")",
    re.IGNORECASE,
)

_TICKET_CLAIM_RE = re.compile(
    r"(?:"
    r"(?:פתחתי|אפתח)\s+[^.?!]{0,60}קריאת\s+שירות|"
    r"(?:פתחתי|יצרתי)\s+[^.?!]{0,60}(?:אירוע(?:\s+שירות)?|פנייה|פניה|קריאה)|"
    r"(?:קריאת\s+השירות|הפנייה|הפניה)\s+(?:נפתחה|פתוחה|נוצרה)|"
    r"(?:אירוע\s+השירות|אירוע\s+שירות|האירוע)\s+(?:נפתח|פתוח|נוצר)|"
    r"\b(?:i|we)\s+(?:(?:have|just)\s+)?(?:opened|created)\b[^.?!]{0,80}"
    r"\b(?:ticket|service\s+request|(?:service\s+)?incident)\b|"
    r"\b(?:your\s+)?(?:ticket|service\s+request|(?:service\s+)?incident)"
    r"\s+(?:is|has\s+been)\s+(?:opened|created)\b"
    r")",
    re.IGNORECASE,
)

# "I saved your details" is a claim that a write committed. For an agent that
# holds lead actions it is true only when the write returned a receipt, so it is
# checked against that receipt rather than trusted from the model's wording.
_UNVERIFIED_SAVE_CLAIM_RE = re.compile(
    r"(?:"
    r"(?:שמרתי|רשמתי|עדכנתי)\s+[^.?!]{0,40}(?:פרטים|הפרטים|המידע|התשובות|הבקשה|הפנייה)|"
    r"(?:הפרטים|המידע|התשובות|הבקשה|הפנייה)\s+(?:שלך\s+|שלכם\s+)?(?:נשמרו|נשמר|נשמרה|נרשמו|נרשם|"
    r"נרשמה|עודכנו|עודכן)|"
    r"\b(?:i|we)(?:'ve|\s+have)?\s+(?:just\s+)?(?:saved|recorded|logged|updated|noted\s+down)\b"
    r"[^.?!]{0,60}\b(?:details?|information|info|answers?|preferences?|request|enquiry|inquiry)\b|"
    r"\b(?:your\s+)?(?:details?|information|answers?|request|enquiry|inquiry)\s+"
    r"(?:(?:is|are|has|have)\s+been|(?:is|are)\s+now)\s+(?:saved|recorded|logged|updated)\b"
    r")",
    re.IGNORECASE,
)

_IDENTITY_COLLECTION_RE = re.compile(
    r"(?:אצטרך|צריך|מסור|למסור|תוכל\s+למסור|תוכלי\s+למסור)"
    r"\s+[^.?!]{0,50}(?:מספר\s+)?תעודת\s+הזהות",
    re.IGNORECASE,
)

_TTS_CONTROL_TAG = re.compile(r"\[[^\[\]\r\n]{1,48}\]")

_SENSITIVE_READBACK_RE = re.compile(
    r"(?:"
    r"\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b|"
    r"(?<![\w-])\+?(?:\d[\s().-]?){8,}\d(?![\w-])"
    r")",
    re.IGNORECASE,
)


def sanitize_tts_markup(text: str) -> str:
    """Remove all bracketed control tags from model/user-derived speech.

    Soniox v2 supports expressive tags, but no untrusted or model-authored tag
    is passed through. Natural wording and punctuation provide the delivery;
    deterministic product-owned tags can be added at a separate trusted seam.
    """

    return " ".join(_TTS_CONTROL_TAG.sub(" ", text).split())


def safe_spoken_text(
    text: str,
    language: str = "en",
    *,
    allow_identity_collection: bool = False,
    allow_ticket_claim: bool = False,
    save_claim_receipted: bool | None = None,
) -> tuple[str, bool]:
    """Sanitize speech and replace unverifiable external-system claims.

    ``save_claim_receipted`` is None for agents with no lead actions, whose
    speech is checked exactly as before. For an agent that holds them it says
    whether a committed receipt answers the caller's current turn; a save claim
    without one is replaced like any other unverified claim.
    """

    sanitized = sanitize_tts_markup(text)
    blocked_identity_request = (
        not allow_identity_collection and _IDENTITY_COLLECTION_RE.search(sanitized) is not None
    )
    blocked_ticket_claim = not allow_ticket_claim and _TICKET_CLAIM_RE.search(sanitized) is not None
    blocked_sensitive_readback = _SENSITIVE_READBACK_RE.search(sanitized) is not None
    unreceipted_save = (
        save_claim_receipted is False and _UNVERIFIED_SAVE_CLAIM_RE.search(sanitized) is not None
    )
    if (
        not blocked_identity_request
        and not blocked_ticket_claim
        and not blocked_sensitive_readback
        and not unreceipted_save
        and not _UNVERIFIED_BUSINESS_CLAIM_RE.search(sanitized)
    ):
        return sanitized, False
    logger.warning("suppressed unverified business-system claim before TTS")
    if language.lower().startswith("he"):
        if blocked_sensitive_readback:
            return "תודה, קיבלתי את הפרטים. מטעמי פרטיות לא אחזור עליהם בקול.", True
        # Gender-neutral wording: the persona may be female or male.
        return (
            "אין לי גישה מאומתת למערכת הזאת בשיחה הנוכחית, ולכן אי אפשר לאשר מכאן שבוצעה פעולה.",
            True,
        )
    if blocked_sensitive_readback:
        return "Thank you, I have the details. For privacy, I won't repeat them aloud.", True
    return (
        "I don't have verified access to that system in this call, so I can't confirm that action.",
        True,
    )


class BusinessClaimGuardFilter(BaseTextFilter):
    """Suppress invented account, ticketing, scheduling, and delivery results.

    Lead actions are the one business tool whose result reaches this guard:
    their committed receipt, per caller turn, is what permits "I saved your
    details". Every other claim that an external system was read or changed
    stays suppressed. This is a final spoken-boundary control, not another
    prompt hint.
    """

    def __init__(
        self,
        get_language: Callable[[], str] | None = None,
        allow_identity_collection: Callable[[], bool] | None = None,
        allow_ticket_claim: Callable[[], bool] | None = None,
        save_claim_receipted: Callable[[], bool] | None = None,
    ):
        self._get_language = get_language
        self._allow_identity_collection = allow_identity_collection
        self._allow_ticket_claim = allow_ticket_claim
        self._save_claim_receipted = save_claim_receipted

    async def filter(self, text: str) -> str:
        language = self._get_language() if self._get_language is not None else "en"
        allowed = (
            self._allow_identity_collection()
            if self._allow_identity_collection is not None
            else False
        )
        ticket_allowed = (
            self._allow_ticket_claim() if self._allow_ticket_claim is not None else False
        )
        return safe_spoken_text(
            text,
            language,
            allow_identity_collection=allowed,
            allow_ticket_claim=ticket_allowed,
            save_claim_receipted=(
                self._save_claim_receipted() if self._save_claim_receipted is not None else None
            ),
        )[0]
