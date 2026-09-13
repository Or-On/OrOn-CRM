"""Fail-closed safeguards for claims the current voice runtime cannot prove."""

from __future__ import annotations

import re

from loguru import logger
from pipecat.utils.text.base_text_filter import BaseTextFilter

_UNVERIFIED_BUSINESS_CLAIM_RE = re.compile(
    r"(?:"
    r"(?:אצטרך|צריך|מסור|למסור|תוכל\s+למסור|תוכלי\s+למסור)"
    r"\s+[^.?!]{0,50}(?:מספר\s+)?תעודת\s+הזהות|"
    r"מצאתי\s+את\s+פרטי\s+המנוי|"
    r"בדקתי\s+(?:ב|את\s+)המערכת|"
    r"אני\s+רואה\s+ש(?:המנוי|הממיר|החשבון)|"
    r"(?:פתחתי|אפתח)\s+[^.?!]{0,60}קריאת\s+שירות|"
    r"(?:תיאמתי|קבעתי)\s+[^.?!]{0,60}(?:טכנאי|פגישה|תור)|"
    r"(?:שלחתי|אשלח)\s+[^.?!]{0,60}(?:ווטסאפ|וואטסאפ|WhatsApp)|"
    r"קריאת\s+השירות\s+(?:נפתחה|פתוחה)|"
    r"הטכנאי\s+יגיע"
    r")",
    re.IGNORECASE,
)


class BusinessClaimGuardFilter(BaseTextFilter):
    """Suppress invented account, ticketing, scheduling, and delivery results.

    The current voice handler registry contains only conversation-routing
    functions. Until a verified business-tool result is carried to this guard,
    no generated sentence may claim that an external system was read or
    changed. This is a final spoken-boundary control, not another prompt hint.
    """

    async def filter(self, text: str) -> str:
        if not _UNVERIFIED_BUSINESS_CLAIM_RE.search(text):
            return text
        logger.warning("suppressed unverified business-system claim before TTS")
        return (
            "אין לי גישה למערכת המנויים או אפשרות לפתוח קריאת שירות בשיחה הזאת. "
            "אפשר להעביר את הפרטים לנציג אנושי?"
        )
