"""Pipecat BaseTextFilter wrapping the deterministic Hebrew normalizers.

Applied as a speech-only text transformer (``make_speech_transformer``): it
changes what the synthesizer reads, never the assistant history. Adds NO
niqqud — that is the niqqud transformer's job.

Scope is deliberately narrow: spoken forms for symbols and numerals the
synthesizer cannot infer (money, clock times, dates, identifiers, percent),
emoji removal, and refusal to voice an unresolved template placeholder. It
does not rewrite wording, grammar, address forms or punctuation. Earlier
semantic rewrites (apology substitution, deleting "אני מבינה ש…", inferring
question boundaries per streamed clause, stripping sentence-final stops,
fixed spelling and transliteration tables) changed meaning or delivery and were
removed on 2026-09-18; see the regression tests for the recorded cases.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from loguru import logger
from pipecat.utils.text.base_text_filter import BaseTextFilter

from oron_hebrew.normalizers import normalize_for_tts, normalize_number_tokens

_UNRESOLVED_PLACEHOLDER_RE = re.compile(
    r"\[[^\]\r\n]{1,80}\]|\{\{[^}\r\n]{1,80}\}\}|\$\{[^}\r\n]{1,80}\}"
)
_HEBREW_RE = re.compile(r"[א-ת]")
_HEBREW_PREFIX_HYPHEN_RE = re.compile(r"\b([בלמהו])[-־]\s*([א-ת])")


class HebrewNormalizeFilter(BaseTextFilter):
    def __init__(self, get_caller_gender: Callable[[], str | None] | None = None) -> None:
        # Retained for the transformer signature. Caller address is owned by the
        # model instruction (caller_gender_instruction), not by text rewriting.
        self._get_caller_gender = get_caller_gender or (lambda: None)

    async def filter(self, text: str) -> str:
        if _UNRESOLVED_PLACEHOLDER_RE.search(text):
            # Never voice an implementation token to a customer. Replacing the
            # complete sentence is safer than deleting only "[name]", which
            # leaves a confident but nonsensical question behind.
            logger.warning("suppressed unresolved placeholder before TTS")
            return (
                "סליחה, חסר לי פרט כדי להמשיך. אפשר לומר לי אותו?"
                if _HEBREW_RE.search(text)
                else "Sorry, I need one detail before we continue. Could you tell me?"
            )
        text = normalize_for_tts(text)
        # Standalone digits the structural rules left behind. Counted nouns keep
        # their digits: the pipeline has no noun-gender knowledge, and a fixed
        # masculine reading produced "שלושה אפשרויות" / "שניים שקלים".
        text = normalize_number_tokens(text)
        # Written Hebrew often uses "ה-17". Once the digits have become words,
        # retaining that hyphen makes some voices announce punctuation or pause
        # mechanically. The spoken form is the attached prefix: "השבעה עשר".
        return _HEBREW_PREFIX_HYPHEN_RE.sub(r"\1\2", text)
