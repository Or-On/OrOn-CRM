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
    r"קריאת\s+השירות\s+(?:נפתחה|פתוחה)|"
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
    r"קריאת\s+השירות\s+(?:נפתחה|פתוחה)|"
    r"\b(?:i|we)\s+(?:(?:have|just)\s+)?(?:opened|created)\b[^.?!]{0,80}"
    r"\b(?:ticket|service\s+request)\b|"
    r"\b(?:your\s+)?(?:ticket|service\s+request)\s+(?:is|has\s+been)\s+opened\b"
    r")",
    re.IGNORECASE,
)

_IDENTITY_COLLECTION_RE = re.compile(
    r"(?:אצטרך|צריך|מסור|למסור|תוכל\s+למסור|תוכלי\s+למסור)"
    r"\s+[^.?!]{0,50}(?:מספר\s+)?תעודת\s+הזהות",
    re.IGNORECASE,
)

_TTS_CONTROL_TAG = re.compile(r"\[[^\[\]\r\n]{1,48}\]")


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
) -> tuple[str, bool]:
    """Sanitize speech and replace unverifiable external-system claims."""

    sanitized = sanitize_tts_markup(text)
    blocked_identity_request = (
        not allow_identity_collection and _IDENTITY_COLLECTION_RE.search(sanitized) is not None
    )
    blocked_ticket_claim = not allow_ticket_claim and _TICKET_CLAIM_RE.search(sanitized) is not None
    if (
        not blocked_identity_request
        and not blocked_ticket_claim
        and not _UNVERIFIED_BUSINESS_CLAIM_RE.search(sanitized)
    ):
        return sanitized, False
    logger.warning("suppressed unverified business-system claim before TTS")
    if language.lower().startswith("he"):
        # Gender-neutral wording: the persona may be female or male.
        return (
            "אין לי גישה מאומתת למערכת הזאת בשיחה הנוכחית, ולכן אי אפשר לאשר מכאן שבוצעה פעולה.",
            True,
        )
    return (
        "I don't have verified access to that system in this call, so I can't confirm that action.",
        True,
    )


class BusinessClaimGuardFilter(BaseTextFilter):
    """Suppress invented account, ticketing, scheduling, and delivery results.

    The current voice handler registry contains only conversation-routing
    functions. Until a verified business-tool result is carried to this guard,
    no generated sentence may claim that an external system was read or
    changed. This is a final spoken-boundary control, not another prompt hint.
    """

    def __init__(
        self,
        get_language: Callable[[], str] | None = None,
        allow_identity_collection: Callable[[], bool] | None = None,
        allow_ticket_claim: Callable[[], bool] | None = None,
    ):
        self._get_language = get_language
        self._allow_identity_collection = allow_identity_collection
        self._allow_ticket_claim = allow_ticket_claim

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
        )[0]
